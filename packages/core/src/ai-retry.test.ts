import { describe, expect, it, vi } from 'vitest';
import {
  backoffMsFor,
  callWithRetry,
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
