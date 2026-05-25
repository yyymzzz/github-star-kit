import { describe, expect, it, vi } from 'vitest';
import type { StarredRepo } from '../schema.js';
import type { ChatBatchFn } from '../tagging/orchestrator.js';
import type { DigestEntry } from './orchestrator.js';
import {
  buildDigestSummaryPrompt,
  buildDigestSummarySystemPrompt,
  DIGEST_SUMMARY_SYSTEM_PROMPT,
  summarizeDigestEntries,
} from './summarize.js';

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
    pushedAt: '2026-05-22T00:00:00Z',
    stargazersCount: 26000,
    defaultBranch: 'master',
    archived: false,
    isFork: false,
    subscribedToReleases: false,
    deepIndexed: false,
    aiTags: ['async runtime', 'concurrency'],
    aiSummary: null,
    userNote: null,
    lastEmbeddedAt: null,
    lastSyncedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DigestEntry> = {}): DigestEntry {
  return {
    star: overrides.star ?? makeStar(),
    score: overrides.score ?? 0.85,
    relevance: overrides.relevance ?? 0.9,
    recency: overrides.recency ?? 0.5,
    ...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
  };
}

describe('DIGEST_SUMMARY_SYSTEM_PROMPT', () => {
  it('asks for 1-2 sentence hook + no markdown / preamble', () => {
    expect(DIGEST_SUMMARY_SYSTEM_PROMPT).toMatch(/1-2 sentence/);
    expect(DIGEST_SUMMARY_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(DIGEST_SUMMARY_SYSTEM_PROMPT).toMatch(/no preamble/i);
  });
});

describe('buildDigestSummaryPrompt', () => {
  it('includes repo metadata + AI tags + score in the prompt', () => {
    const p = buildDigestSummaryPrompt(makeStar(), 0.85);
    expect(p).toContain('Repo: tokio-rs/tokio');
    expect(p).toContain('Language: Rust');
    expect(p).toContain('Description: Async runtime for Rust.');
    expect(p).toContain('GitHub topics: async, rust');
    expect(p).toContain('Tags: async runtime, concurrency');
    expect(p).toMatch(/Relevance to your interest profile:\s+85%/);
  });

  it('omits optional fields gracefully when absent', () => {
    const star = makeStar({
      description: null,
      language: null,
      topics: [],
      aiTags: [],
    });
    const p = buildDigestSummaryPrompt(star, 0.5);
    expect(p).toContain('Repo: tokio-rs/tokio');
    expect(p).not.toContain('Language:');
    expect(p).not.toContain('Description:');
    expect(p).not.toContain('GitHub topics:');
    expect(p).not.toContain('Tags:');
  });
});

describe('summarizeDigestEntries — happy paths', () => {
  const fakeChat = (textFor: (user: string) => string): ChatBatchFn => {
    return async (_system, user) => ({
      text: textFor(user),
      inputTokens: 100,
      outputTokens: 30,
      model: 'fake-chat',
    });
  };

  it('attaches a summary to every entry when chat succeeds', async () => {
    const entries = [
      makeEntry({ star: makeStar({ id: 1, fullName: 'a/a' }) }),
      makeEntry({ star: makeStar({ id: 2, fullName: 'b/b' }) }),
    ];
    const result = await summarizeDigestEntries(
      entries,
      fakeChat((u) => `Hook for ${u.split('\n')[0]}`)
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.summary).toContain('Hook for Repo: a/a');
    expect(result[1]!.summary).toContain('Hook for Repo: b/b');
  });

  it('preserves all other entry fields unchanged', async () => {
    const entries = [
      makeEntry({
        star: makeStar({ id: 1 }),
        score: 0.77,
        relevance: 0.88,
        recency: 0.33,
      }),
    ];
    const result = await summarizeDigestEntries(entries, fakeChat(() => 'hook'));
    expect(result[0]!.score).toBe(0.77);
    expect(result[0]!.relevance).toBe(0.88);
    expect(result[0]!.recency).toBe(0.33);
  });

  it('returns empty array on empty input without calling chat', async () => {
    const chat = vi.fn(fakeChat(() => 'hook'));
    const result = await summarizeDigestEntries([], chat);
    expect(result).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('honors bounded concurrency (peak in-flight <= concurrency)', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ star: makeStar({ id: i + 1 }) })
    );
    let inFlight = 0;
    let peak = 0;
    const slowChat: ChatBatchFn = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { text: 'hook', inputTokens: 1, outputTokens: 1, model: 'fake' };
    };
    await summarizeDigestEntries(entries, slowChat, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // Confirms concurrency was actually used
  });
});

describe('summarizeDigestEntries — robustness', () => {
  const failingChat: ChatBatchFn = async () => {
    throw new Error('provider 503');
  };

  it('leaves summary undefined when chat throws (non-abort)', async () => {
    const entries = [makeEntry({ star: makeStar({ id: 1 }) })];
    const result = await summarizeDigestEntries(entries, failingChat);
    expect(result[0]!.summary).toBeUndefined();
    // Original entry is otherwise preserved
    expect(result[0]!.star.id).toBe(1);
  });

  it('mixes successes and failures correctly (per-entry isolation)', async () => {
    const entries = [
      makeEntry({ star: makeStar({ id: 1 }) }),
      makeEntry({ star: makeStar({ id: 2 }) }),
      makeEntry({ star: makeStar({ id: 3 }) }),
    ];
    let call = 0;
    const flakyChat: ChatBatchFn = async () => {
      call += 1;
      if (call === 2) throw new Error('boom');
      return { text: `hook-${call}`, inputTokens: 1, outputTokens: 1, model: 'fake' };
    };
    const result = await summarizeDigestEntries(entries, flakyChat, {
      concurrency: 1,
    });
    expect(result[0]!.summary).toBe('hook-1');
    expect(result[1]!.summary).toBeUndefined();
    expect(result[2]!.summary).toBe('hook-3');
  });

  it('skips entries whose chat response is empty / whitespace-only', async () => {
    const entries = [makeEntry({ star: makeStar({ id: 1 }) })];
    const emptyChat: ChatBatchFn = async () => ({
      text: '   ',
      inputTokens: 1,
      outputTokens: 1,
      model: 'fake',
    });
    const result = await summarizeDigestEntries(entries, emptyChat);
    expect(result[0]!.summary).toBeUndefined();
  });

  it('propagates AbortError when CALLER signal is aborted', async () => {
    // R20 蓝军 semantics: AbortError propagates only when caller's signal
    // is aborted. A bare AbortError without signal.aborted is treated as
    // a network-side timeout — callWithRetry retries then the entry just
    // keeps an undefined summary (no throw).
    const entries = [makeEntry({ star: makeStar({ id: 1 }) })];
    const controller = new AbortController();
    controller.abort();
    const abortChat: ChatBatchFn = async () => {
      throw new DOMException('Aborted', 'AbortError');
    };
    await expect(
      summarizeDigestEntries(entries, abortChat, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats bare AbortError (no signal) as transient → retries then leaves summary undefined', async () => {
    // R20 蓝军 fix: bare AbortError used to propagate and kill the whole
    // digest summary pass (so a single transient inner-timeout = "all
    // entries have no hooks"). Now callWithRetry retries up to 3x; if all
    // attempts fail the entry just keeps its undefined summary.
    const entries = [makeEntry({ star: makeStar({ id: 1 }) })];
    let calls = 0;
    const flakyChat: ChatBatchFn = async () => {
      calls += 1;
      throw new DOMException('inner timeout', 'AbortError');
    };
    const result = await summarizeDigestEntries(entries, flakyChat);
    expect(result[0]!.summary).toBeUndefined();
    expect(calls).toBeGreaterThan(1); // retried at least once
  });

  it('rejects concurrency < 1', async () => {
    await expect(
      summarizeDigestEntries(
        [makeEntry()],
        async () => ({ text: 'x', inputTokens: 1, outputTokens: 1, model: 'f' }),
        { concurrency: 0 }
      )
    ).rejects.toThrow(/concurrency must be >= 1/);
  });
});

describe('buildDigestSummarySystemPrompt — v0.3 locale support', () => {
  it('returns English-only prompt when no locale given (back-compat)', () => {
    const p = buildDigestSummarySystemPrompt();
    expect(p).not.toMatch(/简体中文|日本語|Русский/);
    expect(p).toMatch(/senior developer/);
    // Identical to the legacy constant export
    expect(p).toBe(DIGEST_SUMMARY_SYSTEM_PROMPT);
  });

  it('returns English-only prompt when targetLocale="en" explicitly', () => {
    expect(buildDigestSummarySystemPrompt('en')).toBe(DIGEST_SUMMARY_SYSTEM_PROMPT);
  });

  it('instructs Chinese output for zh-CN', () => {
    const p = buildDigestSummarySystemPrompt('zh-CN');
    expect(p).toContain('简体中文');
    expect(p).toContain('zh-CN');
    expect(p).toContain('proper nouns');
  });

  it('instructs Japanese output for ja', () => {
    const p = buildDigestSummarySystemPrompt('ja');
    expect(p).toContain('日本語');
    expect(p).toContain('ja');
  });

  it('falls back to English (fail-open) on unknown locale', () => {
    // 'zz-XX' isn't in TRANSLATE_LOCALE_NAMES — should not crash, should
    // not add bogus locale instruction. Same as no-arg call.
    expect(buildDigestSummarySystemPrompt('zz-XX')).toBe(
      DIGEST_SUMMARY_SYSTEM_PROMPT
    );
  });
});

describe('summarizeDigestEntries — v0.3 targetLocale plumbing', () => {
  it('passes the locale-aware system prompt through to chat', async () => {
    const seenSystems: string[] = [];
    const chat: ChatBatchFn = async (system, _user) => {
      seenSystems.push(system);
      return { text: 'hook', inputTokens: 1, outputTokens: 1, model: 'f' };
    };
    await summarizeDigestEntries(
      [makeEntry({ star: makeStar({ id: 1 }) })],
      chat,
      { targetLocale: 'zh-CN' }
    );
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).toContain('简体中文');
  });

  it('reuses the SAME system prompt across all entries (cache-friendly)', async () => {
    const seenSystems: string[] = [];
    const chat: ChatBatchFn = async (system, _user) => {
      seenSystems.push(system);
      return { text: 'h', inputTokens: 1, outputTokens: 1, model: 'f' };
    };
    await summarizeDigestEntries(
      [
        makeEntry({ star: makeStar({ id: 1 }) }),
        makeEntry({ star: makeStar({ id: 2 }) }),
        makeEntry({ star: makeStar({ id: 3 }) }),
      ],
      chat,
      { targetLocale: 'ja', concurrency: 1 }
    );
    expect(seenSystems).toHaveLength(3);
    // Every system prompt should be IDENTICAL (referential or value equality)
    // so Anthropic/OpenAI prompt caching kicks in.
    expect(new Set(seenSystems).size).toBe(1);
  });
});
