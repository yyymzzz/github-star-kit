import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import {
  installFetchMock,
  nextJson,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';
import { AnthropicProvider } from './anthropic.js';

const config = { provider: 'anthropic' as const, apiKey: 'sk-ant-test' };

let fm: MockFetchHandle;
beforeEach(() => {
  fm = installFetchMock();
});
afterEach(() => {
  fm.restore();
});

describe('AnthropicProvider constructor', () => {
  it('throws AIError(auth) when apiKey is missing', () => {
    expect(() => new AnthropicProvider({ provider: 'anthropic' })).toThrow(AIError);
  });
});

describe('AnthropicProvider.chat', () => {
  it('posts to /v1/messages with x-api-key + anthropic-version + browser-access header', async () => {
    nextJson(fm, {
      content: [{ type: 'text', text: 'hi back' }],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 4, output_tokens: 3 },
    });
    const p = new AnthropicProvider(config);
    const res = await p.chat({ user: 'hi', system: 'be terse', maxTokens: 256 });

    const call = fm.lastCall()!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const h = call.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = fm.lastBody<{
      system?: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    }>();
    expect(body.system).toBe('be terse');
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);

    expect(res.text).toBe('hi back');
    expect(res.inputTokens).toBe(4);
    expect(res.outputTokens).toBe(3);
  });

  it('concatenates multiple text content blocks', async () => {
    nextJson(fm, {
      content: [
        { type: 'text', text: 'part 1 ' },
        { type: 'text', text: 'part 2' },
        { type: 'tool_use', id: 't1' }, // ignored
      ],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const res = await new AnthropicProvider(config).chat({ user: 'x' });
    expect(res.text).toBe('part 1 part 2');
  });

  it('supplies default max_tokens when caller omits it', async () => {
    nextJson(fm, {
      content: [{ type: 'text', text: 'ok' }],
      model: 'm',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new AnthropicProvider(config).chat({ user: 'x' });
    const body = fm.lastBody<{ max_tokens: number }>();
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('maps 401 → AIError kind=auth', async () => {
    nextJson(fm, {}, { status: 401 });
    await expect(new AnthropicProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('rejects content array without text blocks → AIError kind=parse', async () => {
    nextJson(fm, {
      content: [{ type: 'tool_use', id: 't1' }],
      model: 'm',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await expect(new AnthropicProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});

describe('AnthropicProvider.embed', () => {
  it('throws AIError(bad_request) without making a fetch call', async () => {
    const p = new AnthropicProvider(config);
    await expect(p.embed({ inputs: ['a'] })).rejects.toMatchObject({
      kind: 'bad_request',
      context: { provider: 'anthropic' },
    });
    expect(fm.calls()).toHaveLength(0);
  });
});
