/**
 * @starkit/ai — Provider-agnostic AI adapter.
 *
 * W1 Day 2 status:
 *   Stage 1: provider base + URL/timeout utils + error taxonomy ✅
 *   Stage 2: 4 concrete providers (OpenAI / Anthropic / Voyage / Ollama) ✅
 *
 * BYOK design — API keys are passed per-instance in ProviderConfig; this
 * package never reads them from env or persists them.
 */

export const VERSION = '0.0.1';

export type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
  ProviderName,
} from './types.js';

export { AIError } from './errors.js';
export type { AIErrorKind, AIErrorContext } from './errors.js';

export {
  createProvider,
  BaseProvider,
  OpenAIProvider,
  AnthropicProvider,
  VoyageProvider,
  OllamaProvider,
} from './providers/index.js';
