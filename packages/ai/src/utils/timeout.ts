/**
 * Timeout + AbortSignal helpers for AI provider requests.
 *
 * Composes a user-provided AbortSignal with an internal timeout signal so
 * the request aborts when EITHER trips. Modern Node (>= 18.17) and browsers
 * support `AbortSignal.any()` natively; we fall back for older runtimes.
 */

export interface CombinedSignal {
  readonly signal: AbortSignal;
  /** Call to release the internal timeout (always call in `finally`). */
  readonly clear: () => void;
}

/**
 * Combine a caller signal with an internal timeout. Returns a signal that
 * aborts when either fires.
 *
 * @param timeoutMs  Internal timeout in milliseconds. Use Infinity to disable.
 * @param caller     Optional caller-supplied AbortSignal.
 */
export function withTimeout(timeoutMs: number, caller?: AbortSignal): CombinedSignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Request timeout', 'AbortError'));
    }, timeoutMs);
  }

  if (caller) {
    if (caller.aborted) {
      controller.abort(caller.reason);
    } else {
      caller.addEventListener(
        'abort',
        () => controller.abort(caller.reason),
        { once: true }
      );
    }
  }

  return {
    signal: controller.signal,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Default per-operation timeouts (milliseconds). Caller can override.
 */
export const DEFAULT_TIMEOUTS = {
  /** Single chat completion. */
  chat: 30_000,
  /** Batch embed call (smaller payload, but provider may rate-limit). */
  embed: 30_000,
  /** Connection test "Reply with OK" call. */
  connectionTest: 10_000,
} as const;
