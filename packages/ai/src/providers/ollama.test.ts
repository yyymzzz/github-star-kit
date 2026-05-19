import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import {
  installFetchMock,
  nextJson,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';
import { OllamaProvider } from './ollama.js';

const config = { provider: 'ollama' as const };

let fm: MockFetchHandle;
beforeEach(() => {
  fm = installFetchMock();
});
afterEach(() => {
  fm.restore();
});

describe('OllamaProvider constructor', () => {
  it('does NOT require apiKey (Ollama is local, no auth)', () => {
    expect(() => new OllamaProvider(config)).not.toThrow();
  });

  it('uses localhost:11434 as default base URL', async () => {
    nextJson(fm, {
      message: { content: 'ok' },
      model: 'llama3.2',
      eval_count: 1,
      prompt_eval_count: 1,
    });
    await new OllamaProvider(config).chat({ user: 'x' });
    expect(fm.lastCall()!.url).toBe('http://localhost:11434/api/chat');
  });
});

describe('OllamaProvider.chat', () => {
  it('posts to /api/chat with stream:false and translates maxTokens → num_predict', async () => {
    nextJson(fm, {
      message: { role: 'assistant', content: 'hello' },
      model: 'llama3.2',
      prompt_eval_count: 6,
      eval_count: 2,
    });
    const p = new OllamaProvider(config);
    const res = await p.chat({
      user: 'hi',
      system: 'be brief',
      temperature: 0.5,
      maxTokens: 128,
    });

    const body = fm.lastBody<{
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      options: { temperature: number; num_predict: number };
    }>();
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.options.temperature).toBe(0.5);
    expect(body.options.num_predict).toBe(128);

    // No auth header — Ollama is local
    const h = fm.lastCall()!.init.headers as Record<string, string>;
    expect(h['authorization']).toBeUndefined();
    expect(h['x-api-key']).toBeUndefined();

    expect(res.text).toBe('hello');
    expect(res.inputTokens).toBe(6);
    expect(res.outputTokens).toBe(2);
  });

  it('maps network error → AIError kind=network (Ollama not running case)', async () => {
    fm.fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED 127.0.0.1:11434'));
    await expect(new OllamaProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps malformed body (no message.content) → AIError kind=parse', async () => {
    nextJson(fm, { model: 'llama3.2' });
    await expect(new OllamaProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('honors custom baseUrl (remote Ollama)', async () => {
    nextJson(fm, {
      message: { content: 'ok' },
      model: 'llama3.2',
      eval_count: 1,
      prompt_eval_count: 1,
    });
    const p = new OllamaProvider({ ...config, baseUrl: 'http://10.0.0.5:11434' });
    await p.chat({ user: 'x' });
    expect(fm.lastCall()!.url).toBe('http://10.0.0.5:11434/api/chat');
  });
});

describe('OllamaProvider.embed', () => {
  it('posts to /api/embed and parses embeddings array', async () => {
    nextJson(fm, {
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      model: 'nomic-embed-text',
      prompt_eval_count: 4,
    });
    const res = await new OllamaProvider(config).embed({ inputs: ['a', 'b'] });
    expect(fm.lastCall()!.url).toBe('http://localhost:11434/api/embed');
    expect(res.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(res.dim).toBe(2);
    expect(res.inputTokens).toBe(4);
  });

  it('rejects empty embeddings array → AIError kind=parse', async () => {
    nextJson(fm, { embeddings: [], model: 'm' });
    await expect(new OllamaProvider(config).embed({ inputs: ['a'] })).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});
