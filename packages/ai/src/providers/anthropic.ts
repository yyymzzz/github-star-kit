/**
 * Anthropic provider — chat only (no first-party embeddings API).
 *
 *   chat: POST {base}/v1/messages
 *
 * Headers:
 *   x-api-key: <key>
 *   anthropic-version: 2023-06-01
 *   anthropic-dangerous-direct-browser-access: true   ← required for browser BYOK
 *
 * Anthropic requires `max_tokens` to be present in every request. We supply a
 * conservative default (1024) when the caller doesn't specify.
 */
import { AIError } from '../errors.js';
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ProviderName,
} from '../types.js';
import { buildChatEndpoint, defaultBaseUrl } from '../utils/urlBuilder.js';
import { BaseProvider } from './base.js';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider extends BaseProvider {
  readonly name: ProviderName = 'anthropic';
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    if (!config.apiKey) {
      throw new AIError('auth', 'Anthropic requires an apiKey', { provider: 'anthropic' });
    }
    this.baseUrl = config.baseUrl ?? defaultBaseUrl('anthropic');
  }

  protected override get supportsEmbedding(): boolean {
    return false;
  }

  protected chatUrl(): string {
    return buildChatEndpoint('anthropic', this.baseUrl);
  }

  protected embedUrl(): string {
    // Unreachable: supportsEmbedding=false short-circuits before this is called.
    throw new AIError('bad_request', 'Anthropic has no embeddings endpoint', {
      provider: 'anthropic',
    });
  }

  protected chatHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  protected buildChatBody(req: ChatRequest): Record<string, unknown> {
    const model = req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL;
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: req.user }],
    };
    if (req.system) body['system'] = req.system;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    return body;
  }

  protected buildEmbedBody(_req: EmbedRequest): Record<string, unknown> {
    throw new AIError('bad_request', 'Anthropic has no embeddings endpoint', {
      provider: 'anthropic',
    });
  }

  protected parseChatResponse(data: unknown, req: ChatRequest): ChatResponse {
    const d = data as {
      content?: Array<{ type?: unknown; text?: unknown }>;
      model?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (!Array.isArray(d.content) || d.content.length === 0) {
      throw new AIError('parse', 'Anthropic response missing content array', {
        provider: 'anthropic',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    const text = d.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text.length === 0) {
      throw new AIError('parse', 'Anthropic response has no text content blocks', {
        provider: 'anthropic',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    return {
      text,
      model: typeof d.model === 'string' ? d.model : (req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL),
      inputTokens: numberOr(d.usage?.input_tokens, 0),
      outputTokens: numberOr(d.usage?.output_tokens, 0),
    };
  }

  protected parseEmbedResponse(_data: unknown, _req: EmbedRequest): EmbedResponse {
    throw new AIError('bad_request', 'Anthropic has no embeddings endpoint', {
      provider: 'anthropic',
    });
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
