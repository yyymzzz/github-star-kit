import { describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { StarStoreMemory } from '../storage/memory.js';
import type { ChatBatchFn } from '../tagging/orchestrator.js';
import {
  translateStars,
  type UpdateStarTranslationFn,
} from './orchestrator.js';

function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id: 1,
    fullName: 'tokio-rs/tokio',
    htmlUrl: 'https://github.com/tokio-rs/tokio',
    ownerLogin: 'tokio-rs',
    ownerAvatarUrl: null,
    description: 'Async runtime for Rust.',
    topics: ['async', 'rust'],
    language: 'Rust',
    starredAt: '2024-01-01T00:00:00Z',
    pushedAt: '2024-06-01T00:00:00Z',
    stargazersCount: 26000,
    defaultBranch: 'master',
    archived: false,
    isFork: false,
    subscribedToReleases: false,
    deepIndexed: false,
    aiTags: [],
    aiSummary: null,
    userNote: null,
    lastEmbeddedAt: null,
    lastSyncedAt: '2026-05-23T00:00:00Z',
    descriptionI18n: {},
    aiSummaryI18n: {},
    aiTagsI18n: {},
    lastTranslatedAt: null,
    ...overrides,
  };
}

const makeFakeChat = (
  translator: (input: string) => string,
  opts: { model?: string } = {}
): ChatBatchFn => {
  const model = opts.model ?? 'fake-translate-v1';
  return async (_system, user) => ({
    text: translator(user),
    inputTokens: 100,
    outputTokens: 40,
    model,
  });
};

function makeRecorder(): {
  readonly fn: UpdateStarTranslationFn;
  readonly calls: Array<{ id: number; locale: string; text: string }>;
} {
  const calls: Array<{ id: number; locale: string; text: string }> = [];
  const fn: UpdateStarTranslationFn = async (id, locale, text) => {
    calls.push({ id, locale, text });
  };
  return { fn, calls };
}

describe('translateStars — happy paths', () => {
  it('translates every untranslated star and persists per-locale', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a', description: 'first' }),
      makeStar({ id: 2, fullName: 'b/b', description: 'second' }),
      makeStar({ id: 3, fullName: 'c/c', description: 'third' }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();

    const result = await translateStars({
      starStore,
      chat: makeFakeChat((s) => `[zh] ${s}`),
      updateStar,
      targetLocale: 'zh-CN',
    });

    expect(result.translated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.noSourceText).toBe(0);
    expect(result.targetLocale).toBe('zh-CN');
    expect(result.model).toBe('fake-translate-v1');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.locale).toBe('zh-CN');
    expect(calls[0]!.text).toBe('[zh] first');
  });

  it('reports total token usage', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'one' }),
      makeStar({ id: 2, description: 'two' }),
    ]);
    const { fn: updateStar } = makeRecorder();
    const result = await translateStars({
      starStore,
      chat: makeFakeChat((s) => `t:${s}`),
      updateStar,
      targetLocale: 'ja',
    });
    expect(result.totalInputTokens).toBe(200);
    expect(result.totalOutputTokens).toBe(80);
  });

  it('returns zeros on empty starStore', async () => {
    const starStore = new StarStoreMemory();
    const { fn: updateStar } = makeRecorder();
    const result = await translateStars({
      starStore,
      chat: makeFakeChat((s) => s),
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result).toMatchObject({
      translated: 0,
      skipped: 0,
      failed: 0,
      noSourceText: 0,
    });
  });

  it('honors concurrency cap', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany(
      Array.from({ length: 10 }, (_, i) =>
        makeStar({ id: i + 1, fullName: `r/${i + 1}`, description: `d${i + 1}` })
      )
    );
    const { fn: updateStar } = makeRecorder();

    let inFlight = 0;
    let peak = 0;
    const slow: ChatBatchFn = async (_s, user) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 4));
      inFlight -= 1;
      return { text: `T:${user}`, inputTokens: 1, outputTokens: 1, model: 'slow' };
    };
    await translateStars({
      starStore,
      chat: slow,
      updateStar,
      targetLocale: 'zh-CN',
      concurrency: 3,
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('translateStars — source-text filtering', () => {
  it('counts null/empty descriptions as noSourceText (no chat call)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'has text' }),
      makeStar({ id: 2, description: null }),
      makeStar({ id: 3, description: '' }),
      makeStar({ id: 4, description: '   ' }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.translated).toBe(1);
    expect(result.noSourceText).toBe(3);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(1);
  });
});

describe('translateStars — skip-cache + force re-translate', () => {
  it('skips stars already translated for the target locale', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'original',
        descriptionI18n: { 'zh-CN': '已翻译' },
      }),
      makeStar({ id: 2, description: 'another', descriptionI18n: {} }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.skipped).toBe(1);
    expect(result.translated).toBe(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(2);
  });

  it('does NOT skip when a DIFFERENT locale is cached (per-locale isolation)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'original',
        descriptionI18n: { ja: '日本語版' }, // ja cached, zh-CN missing
      }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const result = await translateStars({
      starStore,
      chat: makeFakeChat((s) => `[zh] ${s}`),
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.translated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(calls[0]!.locale).toBe('zh-CN');
  });

  it('re-translates every star when forceRetranslate=true', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'a',
        descriptionI18n: { 'zh-CN': '旧版' },
      }),
      makeStar({
        id: 2,
        description: 'b',
        descriptionI18n: { 'zh-CN': '旧版2' },
      }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const result = await translateStars({
      starStore,
      chat: makeFakeChat((s) => `新版:${s}`),
      updateStar,
      targetLocale: 'zh-CN',
      forceRetranslate: true,
    });
    expect(result.translated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(calls[0]!.text).toBe('新版:a');
  });
});

describe('translateStars — failure handling', () => {
  it('counts a chat error as failed, continues with others', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'a' }),
      makeStar({ id: 2, description: 'b' }),
      makeStar({ id: 3, description: 'c' }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();

    let count = 0;
    const flaky: ChatBatchFn = async (_s, user) => {
      count += 1;
      if (count === 2) throw new Error('provider 503');
      return { text: `T:${user}`, inputTokens: 1, outputTokens: 1, model: 'f' };
    };
    const result = await translateStars({
      starStore,
      chat: flaky,
      updateStar,
      targetLocale: 'zh-CN',
      concurrency: 1, // deterministic ordering
    });
    expect(result.translated).toBe(2);
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('counts an essay-length response (>600 chars) as failed (parser returns null)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'a' })]);
    const { fn: updateStar, calls } = makeRecorder();
    const essayChat: ChatBatchFn = async () => ({
      text: 'a'.repeat(800),
      inputTokens: 1,
      outputTokens: 1,
      model: 'verbose',
    });
    const result = await translateStars({
      starStore,
      chat: essayChat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('propagates AbortError without counting it as a failed star', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'x' })]);
    const { fn: updateStar } = makeRecorder();
    const abortChat: ChatBatchFn = async () => {
      throw new DOMException('User cancelled', 'AbortError');
    };
    await expect(
      translateStars({
        starStore,
        chat: abortChat,
        updateStar,
        targetLocale: 'zh-CN',
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('translateStars — input validation', () => {
  it('rejects concurrency < 1', async () => {
    const starStore = new StarStoreMemory();
    const { fn: updateStar } = makeRecorder();
    await expect(
      translateStars({
        starStore,
        chat: makeFakeChat((s) => s),
        updateStar,
        targetLocale: 'zh-CN',
        concurrency: 0,
      })
    ).rejects.toThrow(/concurrency must be >= 1/);
  });

  it('rejects unknown targetLocale (typo defense)', async () => {
    const starStore = new StarStoreMemory();
    const { fn: updateStar } = makeRecorder();
    await expect(
      translateStars({
        starStore,
        chat: makeFakeChat((s) => s),
        updateStar,
        targetLocale: 'zz-XX' as string,
      })
    ).rejects.toThrow(/unknown targetLocale/);
  });
});

describe('translateStars — progress', () => {
  it('fires onProgress with cumulative done/total counts', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'a' }),
      makeStar({ id: 2, description: null }), // counted as noSourceText immediately
      makeStar({ id: 3, description: 'c' }),
    ]);
    const { fn: updateStar } = makeRecorder();
    const progress: Array<[number, number]> = [];
    await translateStars({
      starStore,
      chat: makeFakeChat((s) => s),
      updateStar,
      targetLocale: 'zh-CN',
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });
    // First fire: baseline (noSource = 1 already counted, 2 to do)
    expect(progress[0]).toEqual([1, 3]);
    // Final fire: everything done
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });
});
