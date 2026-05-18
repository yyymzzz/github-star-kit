/**
 * Abstract base class for AI providers.
 *
 * Concrete providers (OpenAI / Anthropic / Voyage / Ollama) extend this and
 * implement the `buildChatBody`, `parseChatResponse`, etc. hooks. The base
 * class owns the cross-cutting concerns: HTTP, timeouts, error mapping,
 * AbortSignal composition.
 *
 * Design contract:
 *   - `chat()` / `embed()` always either resolve with a typed response or
 *     reject with `AIError` (never a generic Error or undefined).
 *   - BYOK: the constructor receives `ProviderConfig` containing the user's
 *     API key. Never logged, never persisted by this class.
 */

import { AIError } from '../errors.js';
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ProviderName,
} from '../types.js';
import { withTimeout, DEFAULT_TIMEOUTS } from '../utils/timeout.js';

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: ProviderName;
  protected readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** Default chat timeout — providers may override. */
  protected get chatTimeoutMs(): number {
    return DEFAULT_TIMEOUTS.chat;
  }

  /** Default embed timeout — providers may override. */
  protected get embedTimeoutMs(): number {
    return DEFAULT_TIMEOUTS.embed;
  }

  // ─── Public surface ──────────────────────────────────────────────

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { signal, clear } = withTimeout(this.chatTimeoutMs, req.signal);
    try {
      const body = this.buildChatBody(req);
      const url = this.chatUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: this.chatHeaders(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw AIError.fromHttpResponse(res, {
          provider: this.name,
          ...(req.model !== undefined ? { model: req.model } : {}),
        });
      }
      const data: unknown = await res.json();
      return this.parseChatResponse(data, req);
    } catch (err) {
      if (err instanceof AIError) throw err;
      throw AIError.fromFetchError(err, {
        provider: this.name,
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    } finally {
      clear();
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!this.supportsEmbedding) {
      throw new AIError(
        'bad_request',
        `Provider '${this.name}' does not support embedding`,
        { provider: this.name }
      );
    }
    const { signal, clear } = withTimeout(this.embedTimeoutMs, req.signal);
    try {
      const body = this.buildEmbedBody(req);
      const url = this.embedUrl();
      const res = await fetch(url, {
        method: 'POST',
        headers: this.embedHeaders(),
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw AIError.fromHttpResponse(res, {
          provider: this.name,
          ...(req.model !== undefined ? { model: req.model } : {}),
        });
      }
      const data: unknown = await res.json();
      return this.parseEmbedResponse(data, req);
    } catch (err) {
      if (err instanceof AIError) throw err;
      throw AIError.fromFetchError(err, {
        provider: this.name,
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    } finally {
      clear();
    }
  }

  // ─── Subclass hooks ──────────────────────────────────────────────

  /** Whether this provider can do embeddings. Default true; override for chat-only providers. */
  protected get supportsEmbedding(): boolean {
    return true;
  }

  /** Build the chat endpoint URL. */
  protected abstract chatUrl(): string;

  /** Build the embeddings endpoint URL. */
  protected abstract embedUrl(): string;

  /** Headers for chat requests (Authorization, x-api-key, etc.). */
  protected abstract chatHeaders(): Record<string, string>;

  /** Headers for embed requests (often same as chat — default impl reuses). */
  protected embedHeaders(): Record<string, string> {
    return this.chatHeaders();
  }

  /** Translate ChatRequest into the provider-specific request body. */
  protected abstract buildChatBody(req: ChatRequest): Record<string, unknown>;

  /** Translate EmbedRequest into the provider-specific request body. */
  protected abstract buildEmbedBody(req: EmbedRequest): Record<string, unknown>;

  /** Parse the provider's chat response into our ChatResponse contract. */
  protected abstract parseChatResponse(data: unknown, req: ChatRequest): ChatResponse;

  /** Parse the provider's embed response into our EmbedResponse contract. */
  protected abstract parseEmbedResponse(data: unknown, req: EmbedRequest): EmbedResponse;
}
