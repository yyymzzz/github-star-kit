/**
 * Ollama provider — local LLM runtime, chat + embed.
 *
 *   chat:  POST {base}/api/chat        (note: not /v1/chat/completions)
 *   embed: POST {base}/api/embed       (Ollama >= 0.1.41; was /api/embeddings)
 *
 * No auth required — Ollama runs locally and listens on 11434 by default.
 * `config.apiKey` is ignored.
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

const DEFAULT_CHAT_MODEL = 'llama3.2';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export class OllamaProvider extends BaseProvider {
  readonly name: ProviderName = 'ollama';
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? defaultBaseUrl('ollama');
  }

  protected chatUrl(): string {
    return buildChatEndpoint('ollama', this.baseUrl);
  }

  protected embedUrl(): string {
    return buildEmbedEndpoint('ollama', this.baseUrl);
  }

  protected chatHeaders(): Record<string, string> {
    return { 'content-type': 'application/json' };
  }

  protected buildChatBody(req: ChatRequest): Record<string, unknown> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const model = req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL;
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) options['num_predict'] = req.maxTokens;

    const body: Record<string, unknown> = { model, messages, stream: false };
    if (Object.keys(options).length > 0) body['options'] = options;
    return body;
  }

  protected buildEmbedBody(req: EmbedRequest): Record<string, unknown> {
    const model = req.model ?? this.config.embedModel ?? DEFAULT_EMBED_MODEL;
    return { model, input: req.inputs };
  }

  protected parseChatResponse(data: unknown, req: ChatRequest): ChatResponse {
    const d = data as {
      message?: { content?: unknown };
      model?: unknown;
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };
    const content = d.message?.content;
    if (typeof content !== 'string') {
      throw new AIError('parse', 'Ollama response missing message.content', {
        provider: 'ollama',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    return {
      text: content,
      model: typeof d.model === 'string' ? d.model : (req.model ?? this.config.chatModel ?? DEFAULT_CHAT_MODEL),
      inputTokens: numberOr(d.prompt_eval_count, 0),
      outputTokens: numberOr(d.eval_count, 0),
    };
  }

  protected parseEmbedResponse(data: unknown, req: EmbedRequest): EmbedResponse {
    const d = data as {
      embeddings?: unknown;
      model?: unknown;
      prompt_eval_count?: unknown;
    };
    if (!Array.isArray(d.embeddings) || d.embeddings.length === 0) {
      throw new AIError('parse', 'Ollama embed response missing embeddings array', {
        provider: 'ollama',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    const vectors: number[][] = [];
    for (let i = 0; i < d.embeddings.length; i += 1) {
      const v = d.embeddings[i];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) {
        throw new AIError('parse', `Ollama embed response embeddings[${i}] malformed`, {
          provider: 'ollama',
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
      inputTokens: numberOr(d.prompt_eval_count, 0),
    };
  }
}
