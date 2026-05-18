/**
 * Smart URL builder for AI provider endpoints.
 *
 * Users paste base URLs in many shapes:
 *   - `https://api.openai.com`           (no version)
 *   - `https://api.openai.com/v1`        (with version)
 *   - `https://api.openai.com/v1/`       (with version + trailing slash)
 *   - `https://my-proxy.example.com/`    (custom OpenAI-compatible)
 *
 * We must produce a canonical endpoint without producing `/v1/v1/...`.
 *
 * Borrowed conceptually from upstream `src/utils/apiUrlBuilder.ts` —
 * rewritten with URL constructor + explicit invariants.
 */

import type { ProviderName } from '../types.js';

/**
 * Join a base URL with a path segment, deduplicating `v1` if base already
 * contains it. Returns a canonical URL string.
 *
 * @param baseUrl   e.g. "https://api.openai.com" or "https://api.openai.com/v1"
 * @param pathWithVersion  e.g. "v1/chat/completions" — we'll strip the leading
 *                          `v1/` if `baseUrl` already ends with `/v1`.
 */
export function buildApiUrl(baseUrl: string, pathWithVersion: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = pathWithVersion.replace(/^\/+/, '');

  // Detect if base already has `/vN` (v1, v2, etc.) at the end
  const versionInBase = /\/v\d+$/.exec(trimmedBase);
  if (versionInBase) {
    // Strip leading `vN/` from path if it matches
    const leadingVersionInPath = /^v\d+\//.exec(trimmedPath);
    if (leadingVersionInPath) {
      return `${trimmedBase}/${trimmedPath.slice(leadingVersionInPath[0].length)}`;
    }
  }

  return `${trimmedBase}/${trimmedPath}`;
}

/**
 * Resolve the final chat-completion endpoint for a provider.
 *
 * `openai-compatible` returns the baseUrl unmodified — the user is expected
 * to provide the full endpoint themselves (these proxies vary too much).
 */
export function buildChatEndpoint(provider: ProviderName, baseUrl: string): string {
  switch (provider) {
    case 'openai':
      return buildApiUrl(baseUrl, 'v1/chat/completions');
    case 'openai-compatible':
      // OpenAI-compatible proxies often have their own routing — return as-is
      // and let user supply the full endpoint URL.
      return baseUrl;
    case 'anthropic':
      return buildApiUrl(baseUrl, 'v1/messages');
    case 'voyage':
      // Voyage is embedding-only; chat endpoint is undefined.
      throw new Error('Voyage AI does not support chat completions');
    case 'ollama':
      return buildApiUrl(baseUrl, 'api/chat');
  }
}

/**
 * Resolve the final embeddings endpoint for a provider.
 */
export function buildEmbedEndpoint(provider: ProviderName, baseUrl: string): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return buildApiUrl(baseUrl, 'v1/embeddings');
    case 'voyage':
      return buildApiUrl(baseUrl, 'v1/embeddings');
    case 'ollama':
      return buildApiUrl(baseUrl, 'api/embed');
    case 'anthropic':
      // Anthropic does not (yet) provide a first-party embeddings API.
      throw new Error('Anthropic does not provide an embeddings API; use voyage or openai');
  }
}

/**
 * Default base URLs per provider when user hasn't set one.
 */
export function defaultBaseUrl(provider: ProviderName): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com';
    case 'openai-compatible':
      // No sensible default — caller must provide.
      throw new Error('openai-compatible requires explicit baseUrl');
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'voyage':
      return 'https://api.voyageai.com';
    case 'ollama':
      return 'http://localhost:11434';
  }
}
