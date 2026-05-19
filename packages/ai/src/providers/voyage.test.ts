import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIError } from '../errors.js';
import {
  installFetchMock,
  nextJson,
  type MockFetchHandle,
} from '../test-utils/fetch-mock.js';
import { VoyageProvider } from './voyage.js';

const config = { provider: 'voyage' as const, apiKey: 'pa-test' };

let fm: MockFetchHandle;
beforeEach(() => {
  fm = installFetchMock();
});
afterEach(() => {
  fm.restore();
});

describe('VoyageProvider constructor', () => {
  it('throws AIError(auth) when apiKey is missing', () => {
    expect(() => new VoyageProvider({ provider: 'voyage' })).toThrow(AIError);
  });
});

describe('VoyageProvider.chat', () => {
  it('throws AIError(bad_request) without making a fetch call', async () => {
    const p = new VoyageProvider(config);
    await expect(p.chat({ user: 'x' })).rejects.toMatchObject({
      kind: 'bad_request',
      context: { provider: 'voyage' },
    });
    expect(fm.calls()).toHaveLength(0);
  });
});

describe('VoyageProvider.embed', () => {
  it('posts to /v1/embeddings with Bearer auth and parses vectors', async () => {
    nextJson(fm, {
      data: [{ embedding: [0.11, 0.22, 0.33, 0.44] }],
      model: 'voyage-3',
      usage: { total_tokens: 12 },
    });
    const p = new VoyageProvider(config);
    const res = await p.embed({ inputs: ['hello'] });

    const call = fm.lastCall()!;
    expect(call.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((call.init.headers as Record<string, string>)['authorization']).toBe('Bearer pa-test');

    const body = fm.lastBody<{ model: string; input: string[]; input_type: string }>();
    expect(body.model).toBe('voyage-3');
    expect(body.input).toEqual(['hello']);
    expect(body.input_type).toBe('document');

    expect(res.vectors).toEqual([[0.11, 0.22, 0.33, 0.44]]);
    expect(res.dim).toBe(4);
    expect(res.inputTokens).toBe(12);
  });

  it('maps 429 → AIError kind=rate_limit', async () => {
    nextJson(fm, { error: 'rate' }, { status: 429 });
    await expect(new VoyageProvider(config).embed({ inputs: ['x'] })).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('maps malformed data → AIError kind=parse', async () => {
    nextJson(fm, { data: 'not-an-array' });
    await expect(new VoyageProvider(config).embed({ inputs: ['x'] })).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});
