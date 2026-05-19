/**
 * Provider barrel + factory.
 *
 * Stage 2 ships four concrete providers. `openai-compatible` (DeepSeek / MiMo
 * / proxies / custom endpoints) is reserved for a later stage and throws here
 * — the exhaustive switch keeps TypeScript honest when we add it.
 */
import { AIError } from '../errors.js';
import type { AIProvider, ProviderConfig } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { VoyageProvider } from './voyage.js';

export { BaseProvider } from './base.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { VoyageProvider } from './voyage.js';
export { OllamaProvider } from './ollama.js';

/**
 * Instantiate a provider from a ProviderConfig. Throws AIError(bad_request)
 * for unsupported provider names.
 */
export function createProvider(config: ProviderConfig): AIProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'voyage':
      return new VoyageProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai-compatible':
      throw new AIError(
        'bad_request',
        "Provider 'openai-compatible' is not yet implemented",
        { provider: config.provider }
      );
    default: {
      const exhaustive: never = config.provider;
      throw new AIError('bad_request', `Unknown provider: ${String(exhaustive)}`, {
        provider: String(exhaustive),
      });
    }
  }
}
