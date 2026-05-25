import { describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { StarStoreMemory } from '../storage/memory.js';
import {
  tagStars,
  type ChatBatchFn,
  type UpdateStarTagsFn,
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
    ...overrides,
  };
}

/**
 * Helper: deterministic fake chat that returns tags based on repo metadata.
 * Lets tests assert specific tags ended up on specific repos.
 */
const makeFakeChat = (
  tagsFor: (user: string) => string,
  opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}
): ChatBatchFn => {
  const model = opts.model ?? 'fake-chat-v1';
  const it = opts.inputTokens ?? 50;
  const ot = opts.outputTokens ?? 10;
  return async (_system, user) => ({
    text: tagsFor(user),
    inputTokens: it,
    outputTokens: ot,
    model,
  });
};

/** Helper: record updateStar calls so tests can assert what was persisted. */
function makeRecorder(): {
  readonly fn: UpdateStarTagsFn;
  readonly calls: Array<{ id: number; aiTags: ReadonlyArray<string> }>;
} {
  const calls: Array<{ id: number; aiTags: ReadonlyArray<string> }> = [];
  const fn: UpdateStarTagsFn = async (id, aiTags) => {
    calls.push({ id, aiTags });
  };
  return { fn, calls };
}

describe('tagStars — happy paths', () => {
  it('tags every untagged star and persists via updateStar', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'a/a' }),
      makeStar({ id: 2, fullName: 'b/b' }),
      makeStar({ id: 3, fullName: 'c/c' }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();

    const result = await tagStars({
      starStore,
      chat: makeFakeChat(() => 'tag1, tag2, tag3'),
      updateStar,
      concurrency: 2,
    });

    expect(result.tagged).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.model).toBe('fake-chat-v1');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.aiTags).toEqual(['tag1', 'tag2', 'tag3']);
  });

  it('reports total token usage across all calls', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
    ]);
    const { fn: updateStar } = makeRecorder();
    const result = await tagStars({
      starStore,
      chat: makeFakeChat(() => 'a, b, c', { inputTokens: 60, outputTokens: 12 }),
      updateStar,
    });
    expect(result.totalInputTokens).toBe(120);
    expect(result.totalOutputTokens).toBe(24);
  });

  it('returns zeros on an empty starStore', async () => {
    const starStore = new StarStoreMemory();
    const { fn: updateStar } = makeRecorder();
    const result = await tagStars({
      starStore,
      chat: makeFakeChat(() => ''),
      updateStar,
    });
    expect(result).toEqual({
      tagged: 0,
      skipped: 0,
      failed: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      model: null,
      // R20 蓝军: new fields default empty/null on a no-op run.
      failedStarIds: [],
      lastErrorKind: null,
      lastErrorMessage: null,
    });
  });

  it('honors the concurrency cap (no more than N in flight at any moment)', async () => {
    const starStore = new StarStoreMemory();
    const stars = Array.from({ length: 10 }, (_, i) =>
      makeStar({ id: i + 1, fullName: `r/${i + 1}` })
    );
    await starStore.upsertMany(stars);
    const { fn: updateStar } = makeRecorder();

    let inFlight = 0;
    let peakInFlight = 0;
    const slowChat: ChatBatchFn = async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {
        text: 'a, b, c',
        inputTokens: 1,
        outputTokens: 1,
        model: 'slow',
      };
    };

    await tagStars({ starStore, chat: slowChat, updateStar, concurrency: 3 });
    // 3 concurrent — never more
    expect(peakInFlight).toBeLessThanOrEqual(3);
    // Must have actually used the concurrency (otherwise the assertion above
    // would pass trivially for any value)
    expect(peakInFlight).toBeGreaterThan(1);
  });
});

describe('tagStars — skip already-tagged', () => {
  it('skips stars whose aiTags is already non-empty (default forceRetag=false)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, aiTags: ['existing'] }),
      makeStar({ id: 2, aiTags: [] }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const chat = vi.fn(makeFakeChat(() => 'a, b, c'));
    const result = await tagStars({
      starStore,
      chat,
      updateStar,
    });
    expect(result.skipped).toBe(1);
    expect(result.tagged).toBe(1);
    // Only the untagged star reached the chat
    expect(chat).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(2);
  });

  it('re-tags every star when forceRetag=true', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, aiTags: ['old-tag'] }),
      makeStar({ id: 2, aiTags: ['stale'] }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();
    const result = await tagStars({
      starStore,
      chat: makeFakeChat(() => 'new1, new2, new3'),
      updateStar,
      forceRetag: true,
    });
    expect(result.skipped).toBe(0);
    expect(result.tagged).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.aiTags).toEqual(['new1', 'new2', 'new3']);
  });
});

describe('tagStars — failure handling', () => {
  it('counts a chat error as failed and continues with other stars', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();

    let count = 0;
    const flakyChat: ChatBatchFn = async () => {
      count += 1;
      if (count === 2) throw new Error('boom — provider 503');
      return { text: 'a, b, c', inputTokens: 1, outputTokens: 1, model: 'fake' };
    };

    const result = await tagStars({
      starStore,
      chat: flakyChat,
      updateStar,
      concurrency: 1, // force serial so the failing call is deterministic
    });
    expect(result.tagged).toBe(2);
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('counts an empty tag response as failed (does not persist [])', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
    ]);
    const { fn: updateStar, calls } = makeRecorder();

    // Response that parses to []: only-sentence content.
    const badChat: ChatBatchFn = async () => ({
      text: 'This is a long sentence the parser will reject as a tag',
      inputTokens: 1,
      outputTokens: 1,
      model: 'fake',
    });

    const result = await tagStars({ starStore, chat: badChat, updateStar });
    expect(result.tagged).toBe(0);
    expect(result.failed).toBe(2);
    expect(calls).toHaveLength(0); // Nothing persisted
  });

  it('propagates AbortError when CALLER signal is aborted (no retry, no failed count)', async () => {
    // R20 蓝军 semantics: AbortError propagates only when caller's signal
    // is aborted. A bare AbortError without signal.aborted is treated by
    // callWithRetry as a network-side timeout (transient) and retried.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { fn: updateStar } = makeRecorder();
    const controller = new AbortController();
    controller.abort();

    const abortChat: ChatBatchFn = async () => {
      throw new DOMException('Aborted by user', 'AbortError');
    };

    await expect(
      tagStars({
        starStore,
        chat: abortChat,
        updateStar,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats bare AbortError (no signal) as transient → retries then counts as failed', async () => {
    // R20 蓝军 fix: provider's internal withTimeout throws bare AbortError
    // (NOT caller's). v1 propagated, killing the whole tagStars run. Now
    // callWithRetry retries up to 3x; after exhaustion the star counts as
    // failed with id in failedStarIds.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { fn: updateStar } = makeRecorder();

    let calls = 0;
    const flakyChat: ChatBatchFn = async () => {
      calls += 1;
      throw new DOMException('inner timeout', 'AbortError');
    };

    const result = await tagStars({ starStore, chat: flakyChat, updateStar });
    expect(result.tagged).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedStarIds).toEqual([1]);
    expect(calls).toBeGreaterThan(1); // retried at least once
  });

  it('populates lastErrorKind when AIError-shaped error is thrown (R20 蓝军)', async () => {
    // The other 4 orchestrators all set lastErrorKind from `err.kind`
    // when an AIError-shaped throw occurs. Subagent B (R20 audit) test
    // gap: tagging didn't verify this. Lock the contract so the popup's
    // "show specific reason" UX doesn't silently regress.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { fn: updateStar } = makeRecorder();
    class FakeAIError extends Error {
      override readonly name = 'AIError';
      constructor(readonly kind: string, message: string) {
        super(message);
      }
    }
    const authChat: ChatBatchFn = async () => {
      throw new FakeAIError('auth', '401 Unauthorized');
    };
    const result = await tagStars({ starStore, chat: authChat, updateStar });
    expect(result.failed).toBe(1);
    expect(result.lastErrorKind).toBe('auth');
    expect(result.lastErrorMessage).toBe('401 Unauthorized');
  });

  it('priority: AIError beats "empty tag list" in lastErrorMessage (R20 蓝军 MAJOR #2)', async () => {
    // MAJOR #2 race fix verification. Two stars fail concurrently — one
    // via empty-tag-list (weak signal, line 184 path), one via
    // FakeAIError(auth) (strong signal, catch path). Without the
    // aiErrorSeen latch, last-writer-by-wall-clock would decide
    // lastErrorMessage and the user could see "empty tag list" when 4/5
    // failures were actually auth issues. The latch fixes that.
    //
    // kind='auth' chosen because it's NOT in callWithRetry's transient
    // set — fires the chat exactly once per star (no retry inflation
    // that would conflate "retry happened" with "priority test failed").
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'empty/tags' }),
      makeStar({ id: 2, fullName: 'ai/error' }),
    ]);
    const { fn: updateStar } = makeRecorder();
    class FakeAIError extends Error {
      override readonly name = 'AIError';
      constructor(readonly kind: string, message: string) {
        super(message);
      }
    }
    let call = 0;
    const mixedChat: ChatBatchFn = async (_s, user) => {
      call += 1;
      if (user.includes('empty/tags')) {
        // R20 蓝军 round-2 fix: force empty-tag path to LAND AFTER the
        // AIError via 20ms setTimeout. Without this delay, the test
        // passes on V8's promise-microtask wall-clock ordering luck —
        // not on the latch. With the delay, the AIError fires first
        // (sync throw), latches aiErrorSeen, then THIS empty-tag arm
        // tries to write 'empty tag list...' and the latch BLOCKS it.
        // That's what the contract promises; the test now actually
        // exercises that promise.
        await new Promise((r) => setTimeout(r, 20));
        return {
          text: 'This is a very long sentence that the parser refuses as a tag.',
          inputTokens: 1,
          outputTokens: 1,
          model: 'fake',
        };
      }
      throw new FakeAIError('auth', '401 Unauthorized — bad key');
    };
    const result = await tagStars({
      starStore,
      chat: mixedChat,
      updateStar,
      concurrency: 2,
    });
    expect(result.failed).toBe(2);
    expect(call).toBe(2);
    expect(result.lastErrorKind).toBe('auth');
    // AIError lands FIRST via sync throw, latches aiErrorSeen=true,
    // then empty-tag arm fires 20ms later and is BLOCKED by the latch.
    // This pins the load-bearing claim: weak signal cannot clobber a
    // strong signal that already landed, regardless of wall-clock.
    expect(result.lastErrorMessage).toBe('401 Unauthorized — bad key');
  });

  it('AIError landing AFTER empty-tag signal still wins (latch is priority not recency)', async () => {
    // Deterministic-ordering variant: concurrency=1, empty-tag star
    // processed FIRST (sets weak 'empty tag list' signal), AIError star
    // processed SECOND (auth 401). The latch flips on the SECOND call
    // and overwrites — proving priority is strong-beats-weak regardless
    // of order, not "first wins" or "last wins". This is the other
    // half of the MAJOR #2 contract.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'first/empty' }),
      makeStar({ id: 2, fullName: 'second/aierror' }),
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
      if (user.includes('first/empty')) {
        return {
          text: 'a sentence the tag parser refuses entirely yes really.',
          inputTokens: 1,
          outputTokens: 1,
          model: 'fake',
        };
      }
      throw new FakeAIError('auth', '401 Unauthorized');
    };
    const result = await tagStars({
      starStore,
      chat: orderedChat,
      updateStar,
      concurrency: 1,
    });
    expect(result.failed).toBe(2);
    expect(result.lastErrorKind).toBe('auth');
    expect(result.lastErrorMessage).toBe('401 Unauthorized');
  });

  it('reverse order: AIError FIRST, empty-tag SECOND — latch still prevents overwrite', async () => {
    // Critical MAJOR #2 corner: the latch must prevent the SECOND
    // empty-tag signal from clobbering the AIError that landed FIRST.
    // Without aiErrorSeen, "if (!aiErrorSeen) lastErrorMessage = ..."
    // would still overwrite because lastErrorMessage was set on a
    // strong path that doesn't otherwise gate the weak path. Pin it.
    //
    // bad_request chosen because it's also permanent (no retry) — same
    // rationale as the auth choice above.
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1, fullName: 'first/aierror' }),
      makeStar({ id: 2, fullName: 'second/empty' }),
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
      if (user.includes('first/aierror')) {
        throw new FakeAIError('bad_request', '400 malformed request');
      }
      return {
        text: 'a long sentence the parser refuses really yes.',
        inputTokens: 1,
        outputTokens: 1,
        model: 'fake',
      };
    };
    const result = await tagStars({
      starStore,
      chat: orderedChat,
      updateStar,
      concurrency: 1,
    });
    expect(result.failed).toBe(2);
    expect(result.lastErrorKind).toBe('bad_request');
    expect(result.lastErrorMessage).toBe('400 malformed request'); // NOT 'empty tag list...'
  });
});

describe('tagStars — signal + progress', () => {
  it('aborts cooperatively when signal fires (no more workers pick up stars)', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany(
      Array.from({ length: 20 }, (_, i) =>
        makeStar({ id: i + 1, fullName: `r/${i + 1}` })
      )
    );
    const { fn: updateStar } = makeRecorder();

    const controller = new AbortController();
    let processedAfterAbort = 0;
    const chat: ChatBatchFn = async () => {
      // Abort once we've handled the first star
      if (controller.signal.aborted) {
        processedAfterAbort += 1;
      } else {
        controller.abort();
      }
      return { text: 'a, b, c', inputTokens: 1, outputTokens: 1, model: 'fake' };
    };

    await expect(
      tagStars({
        starStore,
        chat,
        updateStar,
        concurrency: 1,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The post-await abort check should stop progress almost immediately.
    expect(processedAfterAbort).toBeLessThanOrEqual(1);
  });

  it('fires onProgress with the running done/total tally', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([
      makeStar({ id: 1 }),
      makeStar({ id: 2 }),
      makeStar({ id: 3 }),
    ]);
    const { fn: updateStar } = makeRecorder();
    const progress: Array<[number, number]> = [];

    await tagStars({
      starStore,
      chat: makeFakeChat(() => 'a, b'),
      updateStar,
      concurrency: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });

    // First fire = baseline (0 done out of 3); then one per processed star.
    expect(progress[0]).toEqual([0, 3]);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });
});

describe('tagStars — input validation', () => {
  it('rejects concurrency < 1', async () => {
    const starStore = new StarStoreMemory();
    const { fn: updateStar } = makeRecorder();
    await expect(
      tagStars({
        starStore,
        chat: makeFakeChat(() => ''),
        updateStar,
        concurrency: 0,
      })
    ).rejects.toThrow(/concurrency must be >= 1/);
  });
});
