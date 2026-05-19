/**
 * Voyage AI provider — embeddings only.
 *
 *   embed: POST {base}/v1/embeddings
 *
 * Headers: Authorization: Bearer <key>
 *
 * Voyage offers specialized retrieval embeddings (voyage-3, voyage-code-3,
 * etc.) intended to be paired with a separate chat provider (OpenAI /
 * Anthropic / Ollama). This adapter is embed-only and chat() throws.
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
import { buildEmbedEndpoint, defaultBaseUrl } from '../utils/urlBuilder.js';
import { BaseProvider } from './base.js';

const DEFAULT_EMBED_MODEL = 'voyage-3';

export class VoyageProvider extends BaseProvider {
  readonly name: ProviderName = 'voyage';
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    if (!config.apiKey) {
      throw new AIError('auth', 'Voyage requires an apiKey', { provider: 'voyage' });
    }
    this.baseUrl = config.baseUrl ?? defaultBaseUrl('voyage');
  }

  protected override get supportsChat(): boolean {
    return false;
  }

  protected chatUrl(): string {
    // Unreachable: supportsChat=false short-circuits before this is called.
    throw new AIError('bad_request', 'Voyage does not support chat completions', {
      provider: 'voyage',
    });
  }

  protected embedUrl(): string {
    return buildEmbedEndpoint('voyage', this.baseUrl);
  }

  protected chatHeaders(): Record<string, string> {
    // Reused by embedHeaders() default.
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey ?? ''}`,
    };
  }

  protected buildChatBody(_req: ChatRequest): Record<string, unknown> {
    throw new AIError('bad_request', 'Voyage does not support chat completions', {
      provider: 'voyage',
    });
  }

  protected buildEmbedBody(req: EmbedRequest): Record<string, unknown> {
    const model = req.model ?? this.config.embedModel ?? DEFAULT_EMBED_MODEL;
    return { model, input: req.inputs, input_type: 'document' };
  }

  protected parseChatResponse(_data: unknown, _req: ChatRequest): ChatResponse {
    throw new AIError('bad_request', 'Voyage does not support chat completions', {
      provider: 'voyage',
    });
  }

  protected parseEmbedResponse(data: unknown, req: EmbedRequest): EmbedResponse {
    const d = data as {
      data?: Array<{ embedding?: unknown }>;
      model?: unknown;
      usage?: { total_tokens?: unknown };
    };
    if (!Array.isArray(d.data) || d.data.length === 0) {
      throw new AIError('parse', 'Voyage embed response missing data array', {
        provider: 'voyage',
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    }
    const vectors: number[][] = [];
    for (let i = 0; i < d.data.length; i += 1) {
      const v = d.data[i]?.embedding;
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'number')) {
        throw new AIError('parse', `Voyage embed response data[${i}].embedding malformed`, {
          provider: 'voyage',
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
      inputTokens: numberOr(d.usage?.total_tokens, 0),
    };
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
