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

  it('propagates AbortError without counting it as a failed star', async () => {
    const starStore = new StarStoreMemory();
    await starStore.upsertMany([makeStar({ id: 1 })]);
    const { fn: updateStar } = makeRecorder();

    const abortChat: ChatBatchFn = async () => {
      throw new DOMException('Aborted by user', 'AbortError');
    };

    await expect(
      tagStars({ starStore, chat: abortChat, updateStar })
    ).rejects.toMatchObject({ name: 'AbortError' });
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
