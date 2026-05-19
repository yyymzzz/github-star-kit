/**
 * Shared fetch-mock helpers for provider contract tests.
 *
 * NOT compiled into the published package — see packages/ai/tsconfig.json
 * `exclude` for the path carve-out. Lives under `src/` so providers' tests
 * can import via relative paths without crossing rootDir.
 */
import { vi, type MockInstance } from 'vitest';

export interface MockFetchHandle {
  readonly fetchMock: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;
  /** All recorded calls, in order. */
  calls(): Array<{ url: string; init: RequestInit }>;
  /** The most recent call, or undefined if none. */
  lastCall(): { url: string; init: RequestInit } | undefined;
  /** Parse the last call's body as JSON. */
  lastBody<T = unknown>(): T;
  restore(): void;
}

/**
 * Stub `globalThis.fetch` with a vi mock. Returns a handle for inspection +
 * restore. Each test should call handle.restore() in afterEach (or use
 * test-scoped vi.restoreAllMocks()).
 */
export function installFetchMock(): MockFetchHandle {
  const fetchMock = vi.fn() as unknown as MockInstance<
    Parameters<typeof fetch>,
    ReturnType<typeof fetch>
  >;
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    calls() {
      return fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        init: (init ?? {}) as RequestInit,
      }));
    },
    lastCall() {
      const all = this.calls();
      return all[all.length - 1];
    },
    lastBody<T = unknown>(): T {
      const c = this.lastCall();
      if (!c || typeof c.init.body !== 'string') {
        throw new Error('No body recorded on last fetch call');
      }
      return JSON.parse(c.init.body) as T;
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

/**
 * Queue the next fetch response with a JSON body + status.
 * Pair with installFetchMock.
 */
export function nextJson(
  handle: MockFetchHandle,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): void {
  const status = init.status ?? 200;
  const headers = new Headers({ 'content-type': 'application/json', ...(init.headers ?? {}) });
  handle.fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers })
  );
}

/**
 * Queue the next fetch to reject with a TypeError (network failure).
 */
export function nextNetworkError(handle: MockFetchHandle, message = 'fetch failed'): void {
  handle.fetchMock.mockRejectedValueOnce(new TypeError(message));
}

/**
 * Queue the next fetch to hang forever (caller relies on AbortSignal to bail).
 */
export function nextHang(handle: MockFetchHandle): void {
  handle.fetchMock.mockImplementationOnce(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // will hang
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      })
  );
}
