/**
 * OpenAI provider — chat + embeddings.
 *
 *   chat:  POST {base}/v1/chat/completions
 *   embed: POST {base}/v1/embeddings
 *
 * BYOK: `config.apiKey` is required (constructor throws if missing).
 * Auth:  `Authorization: Bearer <key>`.
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
import {
  buildChatEndpoint,
  buildEmbedEndpoint,
  defaultBaseUrl,
} from '../utils/urlBuilder.js';
import { BaseProvider, numberOr } from './base.js';

const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export class OpenAIProvider extends BaseProvider {
  readonly name: ProviderName = 'openai';
  // protected so OpenAICompatibleProvider can build URLs against a custom base.
  protected readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    if (!config.apiKey) {
      throw new AIError('auth', 'OpenAI requires an apiKey', { provider: 'openai' });
    }
    this.baseUrl = config.baseUrl ?? defaultBaseUrl('openai');
  }

  protected chatUrl(): string {
    return buildChatEndpoint('openai', this.baseUrl);
  }

  protected embedUrl(): string {
    return buildEmbedEndpoint('openai', this.baseUrl);
  }

  protected chatHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey ?? ''}`,
    };
  }

  protected buildChatBody(req: ChatRequest): Record<string, unknown> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const model = req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL;
    const body: Record<string, unknown> = { model, messages };
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    return body;
  }

  protected buildEmbedBody(req: EmbedRequest): Record<string, unknown> {
    const model = req.model ?? this.config.embedModel ?? DEFAULT_EMBED_MODEL;
    return { model, input: req.inputs };
  }

  protected parseChatResponse(data: unknown, req: ChatRequest): ChatResponse {
    const d = data as {
      choices?: Array<{ message?: { content?: unknown } }>;
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = d.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new AIError('parse', 'OpenAI response missing choices[0].message.content', {
        provider: 'openai',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    return {
      text: content,
      model: typeof d.model === 'string' ? d.model : (req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL),
      inputTokens: numberOr(d.usage?.prompt_tokens, 0),
      outputTokens: numberOr(d.usage?.completion_tokens, 0),
    };
  }

  protected parseEmbedResponse(data: unknown, req: EmbedRequest): EmbedResponse {
    const d = data as {
      data?: Array<{ embedding?: unknown }>;
      model?: unknown;
      usage?: { prompt_tokens?: unknown };
    };
    if (!Array.isArray(d.data) || d.data.length === 0) {
      throw new AIError('parse', 'OpenAI embed response missing data array', {
        provider: 'openai',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    const vectors: number[][] = [];
    for (let i = 0; i < d.data.length; i += 1) {
      const v = d.data[i]?.embedding;
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) {
        throw new AIError('parse', `OpenAI embed response data[${i}].embedding malformed`, {
          provider: 'openai',
          ...(req.model !== undefined ? { model: req.model } : {}),
        });
      }
      vectors.push(v as number[]);
    }
    const firstVec = vectors[0]!;
    return {
      vectors,
      model: typeof d.model === 'string' ? d.model : (req.model ?? this.config.embedModel ?? DEFAULT_EMBED_MODEL),
      dim: firstVec.length,
      inputTokens: numberOr(d.usage?.prompt_tokens, 0),
    };
  }
}
