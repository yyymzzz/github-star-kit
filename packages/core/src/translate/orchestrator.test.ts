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
  readonly calls: Array<{ id: number; locale: string; text: string; field: 'description' | 'tags' }>;
} {
  const calls: Array<{ id: number; locale: string; text: string; field: 'description' | 'tags' }> = [];
  const fn: UpdateStarTranslationFn = async (id, locale, text, field) => {
    calls.push({ id, locale, text, field });
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

  it('R48 root cause: translates tags even when description is null/empty (regression — was "翻译 N 个" button stuck)', async () => {
    // Real-world bug found in R48 round-3: user starred repos that have
    // no GitHub description, ran auto-tag (which filled aiTags from name
    // + topics + language), then clicked Translate. Pre-fix behavior:
    //   - R48 R1 fixed untranslatedCount to count "desc OR tags missing"
    //     → button correctly showed "翻译 9 个"
    //   - BUT orchestrator's noSource judgment dropped any star with
    //     empty description, regardless of aiTags status
    //   → click → all 9 stars noSource → tagsTranslated=0
    //   → setAllStarsForTrCount re-reads same data → count stays 9
    //   → user sees button do nothing
    //
    // Contract after fix: noSource means "truly nothing to translate" —
    // desc empty AND (tags empty OR alsoTags=false). When desc is empty
    // but tags exist + alsoTags=true, the worker runs the tags arm only.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: null,
        aiTags: ['cli-tool', 'rust'],
        aiTagsI18n: {},
      }),
      makeStar({
        id: 2,
        description: '   ',
        aiTags: ['javascript', 'web-framework'],
        aiTagsI18n: {},
      }),
      makeStar({
        id: 3,
        description: null,
        aiTags: [],
        aiTagsI18n: {},
      }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    // Stars 1 + 2: tags translated. Star 3 stays noSource (no source at all).
    expect(result.tagsTranslated).toBe(2);
    expect(result.translated).toBe(0);
    expect(result.noSourceText).toBe(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.field === 'tags')).toBe(true);
    expect(calls.map((c) => c.id).sort()).toEqual([1, 2]);
  });

  it('R48 root cause: respects alsoTags=false — empty-desc stars stay noSource (back-compat)', async () => {
    // Mirror guard: when alsoTags is explicitly false, the new "tags
    // make a star translatable" rule must NOT kick in. Otherwise we'd
    // break legacy callers that only want descriptions translated.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: null,
        aiTags: ['rust', 'cli'],
        aiTagsI18n: {},
      }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
      alsoTags: false,
    });
    expect(result.translated).toBe(0);
    expect(result.tagsTranslated).toBe(0);
    expect(result.noSourceText).toBe(1);
    expect(chat).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
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

  it('R21 蓝军 P0: tag-backfill — re-runs tag translation when desc cached but tags missing', async () => {
    // The "翻译完了依旧有标签和介绍没有翻译" symptom: prior run got
    // description but tags failed (provider noise). The next translate
    // click USED TO skip the entire star (skip checked only desc),
    // leaving tags permanently English unless user forceRetranslate.
    // New contract: skip only when BOTH desc AND tags are cached for
    // this locale; otherwise the worker enters and skips desc chat
    // (already cached) and runs ONLY the tags chat.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'Async runtime for Rust.',
        aiTags: ['rust', 'async-runtime', 'concurrency'],
        descriptionI18n: { 'zh-CN': '一个 Rust 异步运行时。' }, // desc cached
        aiTagsI18n: {}, // tags NOT cached — backfill needed
      }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    // Star is NOT skipped (skip only when both cached).
    expect(result.skipped).toBe(0);
    // Description path runs ZERO chat calls (descAlreadyCached short-circuit).
    // Only tags chat fires.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.field).toBe('tags');
    expect(calls[0]!.locale).toBe('zh-CN');
    // result.tagsTranslated reflects the new tag-only success path.
    expect(result.tagsTranslated).toBe(1);
    // result.translated reflects description count — desc was cached so
    // no NEW description translation happened this run.
    expect(result.translated).toBe(0);
    // The starStore row is unchanged because makeRecorder is a no-op
    // persistence stub — the orchestrator's updateStar call is what the
    // popup wires to a real starStore.upsertMany. We verify via calls[].
    const after = await starStore.get(1);
    expect(after!.descriptionI18n!['zh-CN']).toBe('一个 Rust 异步运行时。');
  });

  it('R21 蓝军 P0: still skips when BOTH desc and tags are cached', async () => {
    // Complement of above: when the full translation set is cached,
    // the orchestrator must NOT enter the worker — zero chat calls,
    // skipped counter increments.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'Async runtime for Rust.',
        aiTags: ['rust', 'async'],
        descriptionI18n: { 'zh-CN': '一个 Rust 异步运行时。' },
        aiTagsI18n: { 'zh-CN': 'rust, 异步' },
      }),
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
    expect(result.translated).toBe(0);
    expect(chat).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('R21 蓝军 P0: star with no aiTags is fully cached when desc alone is cached', async () => {
    // Edge case: a repo with empty aiTags doesn't need tag translation.
    // "Tags done" for such a star = always true. Desc cached → full skip.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({
        id: 1,
        description: 'Foo bar baz.',
        aiTags: [], // no tags — nothing to translate on the tag side
        descriptionI18n: { 'zh-CN': '富吧巴兹。' },
      }),
    ]);
    const { fn: updateStar } = makeRecorder();
    const chat = vi.fn(makeFakeChat((s) => `t:${s}`));
    const result = await translateStars({
      starStore,
      chat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.skipped).toBe(1);
    expect(chat).not.toHaveBeenCalled();
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

  it('counts an essay-length response (>1200 chars) as failed (parser returns null)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'a' })]);
    const { fn: updateStar, calls } = makeRecorder();
    // 1500 > MAX_TRANSLATION_LENGTH (1200, bumped by R17 蓝军 fix
    // for verbose models adding suffix notes that inflated past the
    // old 600 cap). 800-char essays now PASS — the old test value
    // would let the model's actual translation through.
    const essayChat: ChatBatchFn = async () => ({
      text: 'a'.repeat(1500),
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

  it('propagates AbortError when CALLER signal is aborted (user cancel)', async () => {
    // R20 蓝军 semantics: AbortError WITH signal.aborted=true is the
    // user-initiated cancel path — propagate to caller. AbortError
    // WITHOUT signal.aborted is treated as network-side timeout by
    // callWithRetry → retries → eventually counts as failed (separate
    // test below). The orchestrator now distinguishes these two paths.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'x' })]);
    const { fn: updateStar } = makeRecorder();
    const controller = new AbortController();
    controller.abort();
    const abortChat: ChatBatchFn = async () => {
      throw new DOMException('User cancelled', 'AbortError');
    };
    await expect(
      translateStars({
        starStore,
        chat: abortChat,
        updateStar,
        targetLocale: 'zh-CN',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats bare AbortError (no signal) as transient → retries then counts failed (R20 蓝军)', async () => {
    // Subagent B (R20 audit) TEST GAP: the other 4 orchestrators all
    // assert "bare AbortError → retry → failed" but translate didn't.
    // This locks the contract: a provider's internal withTimeout firing
    // its own AbortController must NOT silently kill the run — it goes
    // through callWithRetry's transient ladder.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'x' })]);
    const { fn: updateStar } = makeRecorder();
    let calls = 0;
    const flakyChat: ChatBatchFn = async () => {
      calls += 1;
      throw new DOMException('inner timeout', 'AbortError');
    };
    const result = await translateStars({
      starStore,
      chat: flakyChat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedStarIds).toEqual([1]);
    expect(calls).toBeGreaterThan(1); // retried at least once
  });

  it('populates lastErrorKind when AIError-shaped error is thrown (R20 蓝军 MAJOR #1)', async () => {
    // The contract: when chat throws an AIError carrying a `.kind`
    // discriminator, the orchestrator must echo `kind` into
    // lastErrorKind AND the message into lastErrorMessage. Locks the
    // promise the popup wiring depends on for specific error UX.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1, description: 'x' })]);
    const { fn: updateStar } = makeRecorder();
    class FakeAIError extends Error {
      override readonly name = 'AIError';
      constructor(
        readonly kind: string,
        message: string
      ) {
        super(message);
      }
    }
    const authErrChat: ChatBatchFn = async () => {
      throw new FakeAIError('auth', '401 Unauthorized — bad API key');
    };
    const result = await translateStars({
      starStore,
      chat: authErrChat,
      updateStar,
      targetLocale: 'zh-CN',
    });
    expect(result.failed).toBe(1);
    expect(result.lastErrorKind).toBe('auth');
    expect(result.lastErrorMessage).toBe('401 Unauthorized — bad API key');
  });

  it('priority: AIError beats parser-empty signal in lastErrorMessage (R20 蓝军 MAJOR #1)', async () => {
    // R20 MAJOR #1 race-priority discipline test: when one star fails
    // via parser-empty (weak signal) and another via AIError (strong),
    // lastErrorMessage MUST reflect the AIError regardless of which
    // landed first by wall-clock. Mirrors the tagging MAJOR #2 latch.
    //
    // We use kind='auth' (permanent — NOT in callWithRetry's transient
    // set) so each star fires the chat exactly once. Using rate_limit
    // would retry 3× and inflate the call count, conflating "retry
    // happened" with "priority test failed".
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'parser empty path' }),
      makeStar({ id: 2, description: 'aierror path' }),
    ]);
    const { fn: updateStar } = makeRecorder();
    class FakeAIError extends Error {
      override readonly name = 'AIError';
      constructor(
        readonly kind: string,
        message: string
      ) {
        super(message);
      }
    }
    let call = 0;
    // R20 蓝军 round-2 fix: force the parser-empty path to land AFTER
    // the AIError via 20ms setTimeout. Without the delay, the test
    // passes on microtask scheduling luck rather than the latch. With
    // the delay, AIError fires first (sync throw), latches aiErrorSeen,
    // then parser-empty's recordFailure(null, ...) MUST be blocked by
    // the latch — that's the contract this test now actually pins.
    const mixedChat: ChatBatchFn = async (_s, user) => {
      call += 1;
      if (user.includes('parser empty')) {
        await new Promise((r) => setTimeout(r, 20));
        // Returns an essay-length response — parser returns null → weak signal.
        return {
          text: 'a'.repeat(1500),
          inputTokens: 1,
          outputTokens: 1,
          model: 'f',
        };
      }
      throw new FakeAIError('auth', '401 Unauthorized — bad key');
    };
    const result = await translateStars({
      starStore,
      chat: mixedChat,
      updateStar,
      targetLocale: 'zh-CN',
      concurrency: 2,
    });
    expect(result.failed).toBe(2);
    expect(call).toBe(2);
    expect(result.lastErrorKind).toBe('auth');
    expect(result.lastErrorMessage).toBe('401 Unauthorized — bad key');
  });

  it('weak signal does NOT overwrite AIError when ordered: AIError FIRST (latch direction test)', async () => {
    // Complement of the above: lock the OTHER ordering. With
    // concurrency=1, AIError star processes FIRST (sets aiErrorSeen +
    // overwrites freely), parser-empty processes SECOND. The latch
    // MUST block the parser-empty weak signal from clobbering the
    // already-recorded AIError. This pins the "priority is irreversible
    // once latched" half of the contract.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, description: 'aierror first' }),
      makeStar({ id: 2, description: 'parser empty second' }),
    ]);
    const { fn: updateStar } = makeRecorder();
    class FakeAIError extends Error {
      override readonly name = 'AIError';
      constructor(readonly kind: string, message: string) {
        super(message);
      }
    }
    let call = 0;
    const orderedChat: ChatBatchFn = async (_s, user) => {
      call += 1;
      if (user.includes('aierror first')) {
        throw new FakeAIError('auth', '401 first');
      }
      return {
        text: 'a'.repeat(1500), // parser-empty
        inputTokens: 1,
        outputTokens: 1,
        model: 'f',
      };
    };
    const result = await translateStars({
      starStore,
      chat: orderedChat,
      updateStar,
      targetLocale: 'zh-CN',
      concurrency: 1,
    });
    expect(result.failed).toBe(2);
    expect(result.lastErrorKind).toBe('auth');
    expect(result.lastErrorMessage).toBe('401 first'); // NOT the parser-empty fallback
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
