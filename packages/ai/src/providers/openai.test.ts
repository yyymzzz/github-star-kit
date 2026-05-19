import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import {
  installFetchMock,
  nextJson,
  nextNetworkError,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';
import { OpenAIProvider } from './openai.js';

const config = { provider: 'openai' as const, apiKey: 'sk-test' };

let fm: MockFetchHandle;
beforeEach(() => {
  fm = installFetchMock();
});
afterEach(() => {
  fm.restore();
});

describe('OpenAIProvider constructor', () => {
  it('throws AIError(auth) when apiKey is missing', () => {
    expect(() => new OpenAIProvider({ provider: 'openai' })).toThrow(AIError);
  });
});

describe('OpenAIProvider.chat', () => {
  it('posts to /v1/chat/completions with Bearer auth and parses response', async () => {
    nextJson(fm, {
      choices: [{ message: { role: 'assistant', content: 'hello world' } }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    });
    const p = new OpenAIProvider(config);
    const res = await p.chat({ user: 'hi', system: 'be terse' });

    const call = fm.lastCall()!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');

    const body = fm.lastBody<{ messages: Array<{ role: string; content: string }>; model: string }>();
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);

    expect(res.text).toBe('hello world');
    expect(res.model).toBe('gpt-4o-mini');
    expect(res.inputTokens).toBe(5);
    expect(res.outputTokens).toBe(7);
  });

  it('omits system message when not provided', async () => {
    nextJson(fm, {
      choices: [{ message: { content: 'ok' } }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await new OpenAIProvider(config).chat({ user: 'hi' });
    const body = fm.lastBody<{ messages: Array<{ role: string }> }>();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe('user');
  });

  it('maps 401 → AIError kind=auth', async () => {
    nextJson(fm, { error: 'bad key' }, { status: 401 });
    const p = new OpenAIProvider(config);
    await expect(p.chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'auth',
      context: { provider: 'openai', statusCode: 401 },
    });
  });

  it('maps 429 → AIError kind=rate_limit with retryAfter', async () => {
    nextJson(fm, { error: 'rate' }, { status: 429, headers: { 'retry-after': '17' } });
    try {
      await new OpenAIProvider(config).chat({ user: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).kind).toBe('rate_limit');
      expect((err as AIError).context.retryAfterSeconds).toBe(17);
    }
  });

  it('maps 503 → AIError kind=server', async () => {
    nextJson(fm, { error: 'down' }, { status: 503 });
    await expect(new OpenAIProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('maps malformed body → AIError kind=parse', async () => {
    nextJson(fm, { choices: [] });
    await expect(new OpenAIProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('maps fetch TypeError → AIError kind=network', async () => {
    nextNetworkError(fm, 'DNS failure');
    await expect(new OpenAIProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  // Regression for audit bug B: non-JSON body (HTML error page, empty body,
  // wrong content-type) must surface as kind=parse, not kind=unknown.
  it('maps non-JSON 200 body → AIError kind=parse (regression: bug B)', async () => {
    fm.fetchMock.mockResolvedValueOnce(
      new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );
    await expect(new OpenAIProvider(config).chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'parse',
      context: { provider: 'openai' },
    });
  });

  it('caller AbortSignal triggers AIError kind=timeout', async () => {
    fm.fetchMock.mockImplementationOnce(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (!sig) return;
          if (sig.aborted) return reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
          sig.addEventListener('abort', () =>
            reject(sig.reason ?? new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const controller = new AbortController();
    const promise = new OpenAIProvider(config).chat({ user: 'x', signal: controller.signal });
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('honors baseUrl override and dedupes /v1', async () => {
    nextJson(fm, {
      choices: [{ message: { content: 'ok' } }],
      model: 'm',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const p = new OpenAIProvider({ ...config, baseUrl: 'https://proxy.example.com/v1' });
    await p.chat({ user: 'x' });
    expect(fm.lastCall()!.url).toBe('https://proxy.example.com/v1/chat/completions');
  });
});

describe('OpenAIProvider.embed', () => {
  it('posts to /v1/embeddings and parses vectors + dim', async () => {
    nextJson(fm, {
      data: [
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] },
      ],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 8 },
    });
    const res = await new OpenAIProvider(config).embed({ inputs: ['a', 'b'] });
    expect(fm.lastCall()!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(res.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(res.dim).toBe(3);
    expect(res.inputTokens).toBe(8);
    expect(res.model).toBe('text-embedding-3-small');
  });

  it('rejects malformed embedding array → AIError kind=parse', async () => {
    nextJson(fm, { data: [{ embedding: 'not-an-array' }], model: 'm' });
    await expect(new OpenAIProvider(config).embed({ inputs: ['a'] })).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});
