import { describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAIProvider,
  VoyageProvider,
  createProvider,
} from './index.js';

describe('createProvider', () => {
  it('returns OpenAIProvider for provider=openai', () => {
    const p = createProvider({ provider: 'openai', apiKey: 'k' });
    expect(p).toBeInstanceOf(OpenAIProvider);
    expect(p.name).toBe('openai');
  });

  it('returns AnthropicProvider for provider=anthropic', () => {
    const p = createProvider({ provider: 'anthropic', apiKey: 'k' });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe('anthropic');
  });

  it('returns VoyageProvider for provider=voyage', () => {
    const p = createProvider({ provider: 'voyage', apiKey: 'k' });
    expect(p).toBeInstanceOf(VoyageProvider);
    expect(p.name).toBe('voyage');
  });

  it('returns OllamaProvider for provider=ollama', () => {
    const p = createProvider({ provider: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.name).toBe('ollama');
  });

  it('throws AIError(bad_request) for openai-compatible (not yet implemented)', () => {
    expect(() => createProvider({ provider: 'openai-compatible', baseUrl: 'x' })).toThrow(AIError);
  });
});
