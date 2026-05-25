/**
 * Shared retry-on-transient helper for AI provider calls (chat + embed).
 *
 * R20 蓝军 (post-R17): consolidates the retry logic that lived only inside
 * translate/orchestrator.ts into one module. Every other AI-touching
 * orchestrator (embed / tag / digest summary / code deep-index) had the
 * SAME silent-fail bug: a `catch` that only matched `err.name === 'AbortError'
 * || 'TimeoutError'` would let every AIError fall through to a silent
 * `failed++` counter — because @starkit/ai's `AIError` sets `name='AIError'`,
 * not 'TimeoutError'. The fix is to duck-type on `err.kind` (the AIError
 * discriminator) so the orchestrator stays decoupled from the ai package
 * (no workspace cycle).
 *
 * Architecture call: a "single shared helper" instead of a "4x copy of the
 * same logic" — caught Phase 4.5 of systematic-debugging (3+ fixes for the
 * same root cause = architectural problem, not a hypothesis problem).
 */

/**
 * Identify a transient chat/embed error worth retrying.
 *
 * Duck-types on the `kind` field that `AIError` carries (see
 * `packages/ai/src/errors.ts`). Avoids a hard import of `@starkit/ai` so
 * this module can live in @starkit/core without a workspace dep cycle —
 * ai already depends on core, the reverse would close the loop.
 *
 * What counts as transient:
 *   - rate_limit (429): backoff + retry
 *   - timeout (408/504 or AbortError NOT triggered by caller): retry
 *   - server (5xx): retry
 *   - network (fetch threw before response): retry
 * What does NOT count (permanent / user-initiated):
 *   - auth (401/403): retry won't fix a bad key — bubble up
 *   - bad_request (400/404/422): malformed request — bubble up
 *   - parse (2xx unexpected shape): provider broke contract — bubble up
 *   - User AbortError (caller pressed cancel): handled separately by the
 *     orchestrator's signal.aborted check BEFORE this function — see
 *     callsites for the explicit early-return.
 */
export function isTransientChatError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const kind = (err as { kind?: unknown }).kind;
  return (
    kind === 'rate_limit' ||
    kind === 'timeout' ||
    kind === 'server' ||
    kind === 'network' ||
    // R20 蓝军 finding #3 (subagent B): SiliconFlow / DashScope return an
    // HTML maintenance page when overloaded → response 200 but JSON.parse
    // throws → AIError(kind='parse'). One retry typically clears the
    // overload window. Without this, every burst-load failure is a hard
    // failure even though it's transient infrastructure noise.
    kind === 'parse'
  );
}

/**
 * Exponential backoff. Honors `retryAfterSeconds` from the provider when
 * present (rate-limit responses do this); otherwise 500ms → 1500ms → 3500ms.
 * Capped at 5.5s worst-case per attempt so a permanently-failing star
 * doesn't stall the whole batch.
 */
export function backoffMsFor(err: unknown, attempt: number): number {
  const ctx = (err as { context?: { retryAfterSeconds?: unknown } }).context;
  const ra = ctx?.retryAfterSeconds;
  if (typeof ra === 'number' && ra > 0 && ra <= 30) {
    return ra * 1000;
  }
  return [500, 1500, 3500][attempt] ?? 3500;
}

export interface ChatRetryOptions {
  /** Max retry attempts. Total tries = maxRetries + 1. Default 2 (so 3
   *  attempts total). Empirical: SiliconFlow free-tier 429s recover within
   *  2-5s — 3 attempts catch ~95% of transient cases. */
  readonly maxRetries?: number;
  /** Caller's AbortSignal — checked before each attempt so user can cancel
   *  even between retries. */
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_RETRIES = 2;

/**
 * Run an async chat/embed call with retry-on-transient.
 *
 * Generic over T so caller can plug in any of:
 *   - `() => provider.chat({...})` — translate / tag / digest hook
 *   - `() => provider.embed({...})` — embed / deep-index
 *
 * Throws (does NOT swallow):
 *   - User-initiated AbortError (signal.aborted = true): immediate
 *   - Permanent AIError (auth, bad_request, parse): bubble up after first
 *     failure (no retry)
 *   - Network-side AbortError WITHOUT caller signal: counted as transient,
 *     retried up to maxRetries before bubbling
 *   - Any non-Error throw: bubble up unchanged
 *
 * The orchestrator that wraps this is responsible for catching the final
 * throw and converting to its own failure-counter increment (so each
 * orchestrator owns its "what does 'failed' mean for me" semantics).
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: ChatRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new DOMException('callWithRetry: aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // User-initiated cancel: never retry, bubble immediately.
      if (opts.signal?.aborted) throw err;
      // Bare DOMException AbortError WITHOUT signal-aborted means the
      // provider's internal timeout fired (`withTimeout` aborts its own
      // AbortController separately from the caller's). Treat as transient.
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const transient = isAbort || isTransientChatError(err);
      if (!transient || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, backoffMsFor(err, attempt)));
    }
  }
  // Unreachable in practice — the loop either returns or throws. Defensive
  // fallback for the type system + a bug-detection canary.
  throw lastErr ?? new Error('callWithRetry: unreachable');
}

/**
 * Priority-aware failure recorder shared across orchestrators.
 *
 * R28 蓝军 (R26 MAJOR #1 fan-out): translate + tag had a hand-rolled
 * `aiErrorSeen` latch that prioritized AIError-shaped errors over weaker
 * signals (parser-empty / empty tag list). The other 3 orchestrators
 * (embed / code / digest) used bare "last-writer-wins", which meant a
 * dim-mismatch generic Error could clobber a rate_limit AIError that
 * landed first. Same data-quality bug, just hidden behind the technical
 * abstraction.
 *
 * This factory returns a recorder + read-only getters. Callers wire the
 * getters into their result object. Single source of truth for priority
 * discipline — no more inline closures with subtly-different semantics
 * per orchestrator.
 *
 * Priority tiers:
 *   1. STRONG (AIError, identified by `.kind` string): always overwrites,
 *      latches `aiErrorSeen=true` so weaker signals can't clobber.
 *   2. MEDIUM (generic Error without `.kind`): overwrites weak signals
 *      only if no AIError has landed yet.
 *   3. WEAK (caller-supplied fallback string, e.g. parser-empty): writes
 *      only if no stronger signal has been recorded and lastErrorMessage
 *      is still null. Never overwrites.
 *
 * Single-threaded JS guarantees the read+write inside each tier is atomic
 * per microtask (no real interleaving inside the synchronous block).
 * Concurrent workers fighting over the recorder see deterministic
 * priority — strong always wins, regardless of wall-clock order.
 */
export interface FailureRecorder {
  /**
   * Record a failure. `err` is the caught throwable (Error / non-Error /
   * null). `fallbackMsg` is the description for the weak-signal path when
   * `err === null` (e.g. parseResponse returned null → caller passes a
   * "model returned only refusal text" string). Ignored otherwise.
   */
  readonly record: (err: unknown, fallbackMsg: string) => void;
  /** Current lastErrorKind (AIError `.kind` from the strongest signal). */
  readonly getKind: () => string | null;
  /** Current lastErrorMessage. */
  readonly getMessage: () => string | null;
}

export function createFailureRecorder(): FailureRecorder {
  let kind: string | null = null;
  let message: string | null = null;
  let aiErrorSeen = false;
  return {
    record: (err: unknown, fallbackMsg: string): void => {
      if (err instanceof Error) {
        const errKind = (err as { kind?: unknown }).kind;
        if (typeof errKind === 'string') {
          // STRONG: AIError. Always wins, latches.
          kind = errKind;
          message = err.message;
          aiErrorSeen = true;
          return;
        }
        // MEDIUM: generic Error. Overwrites weak signals only if no
        // AIError has landed yet (the latch decides).
        if (!aiErrorSeen) message = err.message;
        return;
      }
      // WEAK: parser-empty / dim-mismatch synthesized message. Only
      // writes when no stronger signal has been recorded AND the
      // message slot is still null (don't clobber even peer weak
      // signals — first-weak-wins inside the weak tier).
      if (!aiErrorSeen && message === null) {
        message = fallbackMsg;
      }
    },
    getKind: () => kind,
    getMessage: () => message,
  };
}
