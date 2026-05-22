import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import { isSafeBaseUrl } from '../utils/urlBuilder.js';
import {
  installFetchMock,
  nextJson,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';
import { OpenAICompatibleProvider, createProvider } from './index.js';

describe('isSafeBaseUrl', () => {
  it('accepts https hosts', () => {
    expect(isSafeBaseUrl('https://api.deepseek.com')).toBe(true);
    expect(isSafeBaseUrl('https://api.siliconflow.cn/v1')).toBe(true);
  });

  it('accepts http only for localhost / loopback', () => {
    expect(isSafeBaseUrl('http://localhost:1234')).toBe(true);
    expect(isSafeBaseUrl('http://127.0.0.1:11434')).toBe(true);
  });

  it('rejects http for non-loopback hosts (would leak the API key in cleartext)', () => {
    expect(isSafeBaseUrl('http://evil.example.com')).toBe(false);
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(isSafeBaseUrl('ftp://example.com')).toBe(false);
    expect(isSafeBaseUrl('not-a-url')).toBe(false);
    expect(isSafeBaseUrl('')).toBe(false);
  });
});

describe('createProvider — openai-compatible', () => {
  it('builds an OpenAICompatibleProvider for a valid https config', () => {
    const p = createProvider({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe('openai-compatible');
  });

  it('throws AIError when baseUrl is missing', () => {
    expect(() =>
      createProvider({ provider: 'openai-compatible', apiKey: 'k' })
    ).toThrow(AIError);
  });

  it('throws AIError when baseUrl is unsafe (http non-localhost)', () => {
    expect(() =>
      createProvider({
        provider: 'openai-compatible',
        apiKey: 'k',
        baseUrl: 'http://evil.example.com',
      })
    ).toThrow(AIError);
  });

  it('throws AIError when apiKey is missing (BYOK cloud proxy still needs a key)', () => {
    expect(() =>
      createProvider({
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
      })
    ).toThrow(AIError);
  });
});

describe('OpenAICompatibleProvider wire format', () => {
  let fm: MockFetchHandle;
  beforeEach(() => {
    fm = installFetchMock();
  });
  afterEach(() => {
    fm.restore();
  });

  it('posts chat to {baseUrl}/v1/chat/completions with the OpenAI body shape', async () => {
    nextJson(fm, {
      choices: [{ message: { content: 'hi there' } }],
      model: 'deepseek-chat',
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
    const p = createProvider({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      chatModel: 'deepseek-chat',
    });
    const res = await p.chat({ user: 'hello' });
    expect(res.text).toBe('hi there');
    expect(fm.lastCall()!.url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('posts embeddings to {baseUrl}/v1/embeddings (v1 dedup honored)', async () => {
    nextJson(fm, {
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: 'bge-m3',
      usage: { prompt_tokens: 2 },
    });
    const p = createProvider({
      provider: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'https://api.siliconflow.cn/v1', // trailing /v1 must not double
      embedModel: 'bge-m3',
    });
    const res = await p.embed({ inputs: ['x'] });
    expect(res.dim).toBe(3);
    expect(fm.lastCall()!.url).toBe('https://api.siliconflow.cn/v1/embeddings');
  });
});
