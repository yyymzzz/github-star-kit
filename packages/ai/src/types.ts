/**
 * Provider-agnostic types. Concrete provider implementations land W1 Day 2.
 */

export type ProviderName = 'openai' | 'anthropic' | 'voyage' | 'ollama' | 'openai-compatible';

export interface ProviderConfig {
  readonly provider: ProviderName;
  /** API key for BYOK providers. For Ollama, ignored. */
  readonly apiKey?: string;
  /** Override base URL — useful for OpenAI-compatible endpoints and Ollama. */
  readonly baseUrl?: string;
  /** Default chat model id. */
  readonly chatModel?: string;
  /** Default embedding model id. */
  readonly embedModel?: string;
}

export interface ChatRequest {
  readonly system?: string;
  readonly user: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** AbortSignal honored by providers. */
  readonly signal?: AbortSignal;
}

export interface ChatResponse {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface EmbedRequest {
  readonly inputs: ReadonlyArray<string>;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface EmbedResponse {
  /** `vectors[i]` corresponds to `inputs[i]`. Each vector has uniform `dim`. */
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  readonly model: string;
  readonly dim: number;
  readonly inputTokens: number;
}

export interface AIProvider {
  readonly name: ProviderName;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}
