import { describe, expect, it, vi } from 'vitest';
import {
  backoffMsFor,
  callWithRetry,
  createFailureRecorder,
  isTransientChatError,
} from './ai-retry.js';

// Helpers to construct realistic AIError-shaped objects without importing
// @starkit/ai (avoids workspace cycle in tests).
class FakeAIError extends Error {
  override readonly name = 'AIError';
  constructor(
    readonly kind: string,
    message: string,
    readonly context: { retryAfterSeconds?: number } = {}
  ) {
    super(message);
  }
}

describe('isTransientChatError', () => {
  it('classifies rate_limit / timeout / server / network / parse as transient', () => {
    expect(isTransientChatError(new FakeAIError('rate_limit', 'x'))).toBe(true);
    expect(isTransientChatError(new FakeAIError('timeout', 'x'))).toBe(true);
    expect(isTransientChatError(new FakeAIError('server', 'x'))).toBe(true);
    expect(isTransientChatError(new FakeAIError('network', 'x'))).toBe(true);
    // R20 蓝军 finding #3: SiliconFlow under load returns HTML →
    // kind='parse'. Retry typically clears the overload window.
    expect(isTransientChatError(new FakeAIError('parse', 'x'))).toBe(true);
  });

  it('rejects permanent error kinds (auth / bad_request / unknown)', () => {
    expect(isTransientChatError(new FakeAIError('auth', 'x'))).toBe(false);
    expect(isTransientChatError(new FakeAIError('bad_request', 'x'))).toBe(false);
    expect(isTransientChatError(new FakeAIError('unknown', 'x'))).toBe(false);
  });

  it('rejects non-AIError-shaped errors (plain Error, no `kind`)', () => {
    expect(isTransientChatError(new Error('boom'))).toBe(false);
    expect(isTransientChatError('string error')).toBe(false);
    expect(isTransientChatError(null)).toBe(false);
    expect(isTransientChatError(undefined)).toBe(false);
  });
});

describe('backoffMsFor', () => {
  it('honors retryAfterSeconds when in [1, 30]', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: 7 });
    expect(backoffMsFor(err, 0)).toBe(7000);
    expect(backoffMsFor(err, 1)).toBe(7000);
    expect(backoffMsFor(err, 2)).toBe(7000);
  });

  it('falls back to exponential when retryAfterSeconds absent', () => {
    const err = new FakeAIError('server', 'x');
    expect(backoffMsFor(err, 0)).toBe(500);
    expect(backoffMsFor(err, 1)).toBe(1500);
    expect(backoffMsFor(err, 2)).toBe(3500);
  });

  it('rejects oversized retryAfterSeconds (> 30s caps to backoff schedule)', () => {
    // A 999-second Retry-After is hostile; fall back to our own ladder.
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: 999 });
    expect(backoffMsFor(err, 0)).toBe(500);
  });

  it('clamps attempts beyond the schedule to 3500ms', () => {
    const err = new FakeAIError('server', 'x');
    expect(backoffMsFor(err, 5)).toBe(3500);
    expect(backoffMsFor(err, 100)).toBe(3500);
  });

  // R28 蓝军 (R26 MAJOR #3): edge cases the original test suite missed.
  // Audit B flagged: 30 (boundary), 31 (off-by-one), negative values,
  // zero. The body uses `ra > 0 && ra <= 30` so we pin those branches.
  it('honors retryAfterSeconds === 30 (upper boundary inclusive)', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: 30 });
    expect(backoffMsFor(err, 0)).toBe(30000);
  });

  it('rejects retryAfterSeconds === 31 (one past boundary)', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: 31 });
    expect(backoffMsFor(err, 0)).toBe(500); // falls back to schedule
  });

  it('rejects retryAfterSeconds === 0 (zero is not > 0)', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: 0 });
    expect(backoffMsFor(err, 0)).toBe(500);
  });

  it('rejects negative retryAfterSeconds (defense against hostile providers)', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: -5 });
    expect(backoffMsFor(err, 0)).toBe(500);
  });

  it('rejects NaN retryAfterSeconds (defense against bad parse)', () => {
    const err = new FakeAIError('rate_limit', 'x', { retryAfterSeconds: NaN });
    expect(backoffMsFor(err, 0)).toBe(500);
  });
});

describe('callWithRetry — happy path', () => {
  it('returns result without retry when fn succeeds on first attempt', async () => {
    const fn = vi.fn(async () => 'ok');
    const r = await callWithRetry(fn);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('callWithRetry — transient retry', () => {
  it('retries on rate_limit, returns on success', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts < 3) throw new FakeAIError('rate_limit', '429');
      return 'ok';
    };
    const r = await callWithRetry(fn);
    expect(r).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('retries on timeout AIError', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts === 1) throw new FakeAIError('timeout', '504');
      return 'ok';
    };
    const r = await callWithRetry(fn);
    expect(r).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('retries on bare DOMException AbortError (network-side timeout)', async () => {
    // Provider's internal withTimeout fires its own abort — looks like a
    // DOMException AbortError but caller's signal is NOT aborted.
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new DOMException('inner timeout', 'AbortError');
      }
      return 'ok';
    };
    const r = await callWithRetry(fn);
    expect(r).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('gives up after maxRetries attempts on persistent transient', async () => {
    const fn = vi.fn(async () => {
      throw new FakeAIError('server', '500');
    });
    await expect(callWithRetry(fn, { maxRetries: 2 })).rejects.toMatchObject({
      kind: 'server',
    });
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

describe('callWithRetry — permanent errors bubble immediately', () => {
  it('does NOT retry auth errors (bad key — retry would burn quota)', async () => {
    const fn = vi.fn(async () => {
      throw new FakeAIError('auth', '401');
    });
    await expect(callWithRetry(fn)).rejects.toMatchObject({ kind: 'auth' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry bad_request errors', async () => {
    const fn = vi.fn(async () => {
      throw new FakeAIError('bad_request', '404');
    });
    await expect(callWithRetry(fn)).rejects.toMatchObject({
      kind: 'bad_request',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DOES retry parse errors (R20 蓝军 #3 — SiliconFlow HTML page when overloaded)', async () => {
    // SiliconFlow / Cloudflare return an HTML error page with 200 OK
    // under load → AIError(kind='parse'). Retry typically clears the
    // overload window.
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts === 1) throw new FakeAIError('parse', 'unexpected token <');
      return 'ok';
    };
    const r = await callWithRetry(fn);
    expect(r).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does NOT retry plain Error (no kind discriminator)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('mystery');
    });
    await expect(callWithRetry(fn)).rejects.toThrow('mystery');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('callWithRetry — caller abort', () => {
  it('propagates immediately when caller signal is aborted before first attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'ok');
    await expect(
      callWithRetry(fn, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates when caller aborts BETWEEN retries (during backoff sleep)', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fn = async () => {
      attempts += 1;
      if (attempts === 1) {
        // Abort after the first failure has been recorded.
        setTimeout(() => controller.abort(), 0);
        throw new FakeAIError('rate_limit', '429');
      }
      return 'ok';
    };
    await expect(
      callWithRetry(fn, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// R28: FailureRecorder is the shared priority latch extracted from
// translate / tag in R28 fan-out (was hand-rolled inline closures).
// Pins the priority discipline (AIError > Error > weak fallback) so
// all 5 orchestrators (embed / tag / translate / digest / code) get
// the SAME semantics for free.
describe('createFailureRecorder', () => {
  it('starts in clean state — kind=null, message=null', () => {
    const r = createFailureRecorder();
    expect(r.getKind()).toBeNull();
    expect(r.getMessage()).toBeNull();
  });

  it('records AIError-shape (has .kind) and exposes both fields', () => {
    const r = createFailureRecorder();
    r.record(new FakeAIError('auth', '401 Unauthorized'), 'fallback');
    expect(r.getKind()).toBe('auth');
    expect(r.getMessage()).toBe('401 Unauthorized');
  });

  it('records generic Error (no .kind) — only message, kind stays null', () => {
    const r = createFailureRecorder();
    r.record(new Error('something broke'), 'fallback');
    expect(r.getKind()).toBeNull();
    expect(r.getMessage()).toBe('something broke');
  });

  it('records weak fallback when err is null', () => {
    const r = createFailureRecorder();
    r.record(null, 'parser refused');
    expect(r.getKind()).toBeNull();
    expect(r.getMessage()).toBe('parser refused');
  });

  it('priority: AIError overwrites previous generic Error', () => {
    const r = createFailureRecorder();
    r.record(new Error('first generic'), 'fallback');
    r.record(new FakeAIError('rate_limit', '429'), 'fallback2');
    expect(r.getKind()).toBe('rate_limit');
    expect(r.getMessage()).toBe('429');
  });

  it('priority: AIError overwrites previous weak fallback', () => {
    const r = createFailureRecorder();
    r.record(null, 'parser refused');
    r.record(new FakeAIError('server', '503'), 'fallback2');
    expect(r.getKind()).toBe('server');
    expect(r.getMessage()).toBe('503');
  });

  it('priority LATCH: weak fallback CANNOT overwrite previous AIError', () => {
    const r = createFailureRecorder();
    r.record(new FakeAIError('auth', '401'), 'fallback');
    r.record(null, 'should not appear');
    expect(r.getKind()).toBe('auth');
    expect(r.getMessage()).toBe('401');
  });

  it('priority LATCH: generic Error CANNOT overwrite previous AIError', () => {
    // The strong-tier latch protects AIError from BOTH weak signals AND
    // generic Errors that land later. Without this, a dim-mismatch
    // generic Error fired after a rate_limit AIError would clobber the
    // more actionable AIError.
    const r = createFailureRecorder();
    r.record(new FakeAIError('rate_limit', '429'), 'f');
    r.record(new Error('dim mismatch'), 'f2');
    expect(r.getKind()).toBe('rate_limit');
    expect(r.getMessage()).toBe('429'); // NOT 'dim mismatch'
  });

  it('priority: second AIError overwrites first AIError (latest-AIError-wins)', () => {
    // Within the strong tier, latest-write-wins. Justification: a later
    // AIError is at least as actionable as the earlier one — and often
    // it's the FINAL failure after the call-with-retry exhausted, which
    // is the most relevant signal for the user.
    const r = createFailureRecorder();
    r.record(new FakeAIError('rate_limit', '429'), 'f');
    r.record(new FakeAIError('auth', '401'), 'f2');
    expect(r.getKind()).toBe('auth');
    expect(r.getMessage()).toBe('401');
  });

  it('generic Error overwrites previous weak fallback', () => {
    const r = createFailureRecorder();
    r.record(null, 'parser refused');
    r.record(new Error('network'), 'fallback');
    expect(r.getKind()).toBeNull();
    expect(r.getMessage()).toBe('network');
  });

  it('first-weak-wins: subsequent weak fallback does NOT overwrite first weak', () => {
    // Inside the weak tier the recorder is first-write-wins. Rationale:
    // when no AIError has landed and the message slot is already filled
    // with one weak signal, additional weak signals from later workers
    // shouldn't churn the user-visible message.
    const r = createFailureRecorder();
    r.record(null, 'first weak');
    r.record(null, 'second weak');
    expect(r.getMessage()).toBe('first weak');
  });

  it('non-Error throw (string) routes to weak fallback path', () => {
    // If a caller does `throw 'plain string'` instead of `throw new Error()`,
    // err is not instanceof Error so the recorder falls to weak-tier.
    const r = createFailureRecorder();
    r.record('plain string thrown', 'fallback used');
    expect(r.getKind()).toBeNull();
    expect(r.getMessage()).toBe('fallback used');
  });
});
