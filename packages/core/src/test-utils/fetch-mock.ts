/**
 * Shared fetch-mock helpers for GitHub sync contract tests.
 *
 * NOT compiled into dist — see packages/core/tsconfig.json `exclude`.
 * Mirrors the shape of packages/ai/src/test-utils/fetch-mock.ts.
 */
import { vi, type MockInstance } from 'vitest';

export interface MockFetchHandle {
  readonly fetchMock: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;
  calls(): Array<{ url: string; init: RequestInit }>;
  lastCall(): { url: string; init: RequestInit } | undefined;
  restore(): void;
}

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
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

/**
 * Queue the next fetch response with a JSON body. Optional `link` adds a
 * GitHub-style `Link: <next-url>; rel="next"` pagination header.
 */
export function nextJson(
  handle: MockFetchHandle,
  body: unknown,
  init: {
    status?: number;
    headers?: Record<string, string>;
    /** Convenience: set Link header to a single `; rel="next"` URL. */
    nextLink?: string;
  } = {}
): void {
  const status = init.status ?? 200;
  const headers = new Headers({
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  });
  if (init.nextLink) {
    headers.set('link', `<${init.nextLink}>; rel="next"`);
  }
  handle.fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers })
  );
}

/**
 * Queue an empty 304 Not Modified response. Octokit surfaces these as
 * RequestError with status === 304.
 */
export function nextNotModified(
  handle: MockFetchHandle,
  headers: Record<string, string> = {}
): void {
  handle.fetchMock.mockResolvedValueOnce(
    new Response(null, {
      status: 304,
      headers: new Headers(headers),
    })
  );
}

export function nextNetworkError(handle: MockFetchHandle, message = 'fetch failed'): void {
  handle.fetchMock.mockRejectedValueOnce(new TypeError(message));
}
