import { describe, expect, it } from 'vitest';
import type { StarredRepo } from '../schema.js';
import {
  TAG_SYSTEM_PROMPT,
  buildTagUserPrompt,
  parseTagResponse,
} from './text.js';

function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
    schemaVersion: 1,
    id: 1,
    fullName: 'tokio-rs/tokio',
    htmlUrl: 'https://github.com/tokio-rs/tokio',
    ownerLogin: 'tokio-rs',
    ownerAvatarUrl: null,
    description: 'A runtime for writing reliable asynchronous applications with Rust.',
    topics: ['async', 'rust', 'runtime'],
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

describe('TAG_SYSTEM_PROMPT', () => {
  it('mentions 3-5 tags + comma-separated requirement', () => {
    expect(TAG_SYSTEM_PROMPT).toMatch(/3 to 5/);
    expect(TAG_SYSTEM_PROMPT).toMatch(/comma-separated/);
  });
});

describe('buildTagUserPrompt', () => {
  it('includes Repo / Language / Description / Topics labels on the canonical case', () => {
    const p = buildTagUserPrompt(makeStar());
    expect(p).toContain('Repo: tokio-rs/tokio');
    expect(p).toContain('Language: Rust');
    expect(p).toContain('Description: A runtime');
    expect(p).toContain('GitHub topics: async, rust, runtime');
  });

  it('omits Language line when null', () => {
    const p = buildTagUserPrompt(makeStar({ language: null }));
    expect(p).not.toContain('Language:');
  });

  it('omits Description line when null', () => {
    const p = buildTagUserPrompt(makeStar({ description: null }));
    expect(p).not.toContain('Description:');
  });

  it('omits Topics line when empty', () => {
    const p = buildTagUserPrompt(makeStar({ topics: [] }));
    expect(p).not.toContain('GitHub topics:');
  });
});

describe('parseTagResponse — happy path', () => {
  it('parses the prompt-shaped "tag1, tag2, tag3" format', () => {
    expect(parseTagResponse('async runtime, rust, concurrency')).toEqual([
      'async runtime',
      'rust',
      'concurrency',
    ]);
  });

  it('trims whitespace around tags', () => {
    expect(parseTagResponse('  tag1  ,  tag2  ,tag3')).toEqual([
      'tag1',
      'tag2',
      'tag3',
    ]);
  });

  it('tolerates one-tag-per-line responses', () => {
    expect(parseTagResponse('async\nrust\nruntime')).toEqual([
      'async',
      'rust',
      'runtime',
    ]);
  });

  it('caps at 5 tags', () => {
    expect(parseTagResponse('a, b, c, d, e, f, g')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });
});

describe('parseTagResponse — robustness against hallucinated formatting', () => {
  it('strips a "Tags:" / "Output:" prefix', () => {
    expect(parseTagResponse('Tags: rust, async')).toEqual(['rust', 'async']);
    expect(parseTagResponse('Output: rust, async')).toEqual(['rust', 'async']);
    expect(parseTagResponse('Result: rust, async')).toEqual(['rust', 'async']);
  });

  it('strips numbered list prefixes', () => {
    expect(parseTagResponse('1. rust\n2. async\n3. runtime')).toEqual([
      'rust',
      'async',
      'runtime',
    ]);
  });

  it('strips bullet/dash prefixes', () => {
    expect(parseTagResponse('- rust\n- async\n- runtime')).toEqual([
      'rust',
      'async',
      'runtime',
    ]);
    expect(parseTagResponse('* rust\n* async')).toEqual(['rust', 'async']);
  });

  it('strips surrounding quotes', () => {
    expect(parseTagResponse('"rust", "async", `runtime`')).toEqual([
      'rust',
      'async',
      'runtime',
    ]);
  });

  it('strips trailing sentence punctuation', () => {
    expect(parseTagResponse('rust, async, runtime.')).toEqual([
      'rust',
      'async',
      'runtime',
    ]);
  });

  it('drops case-folded duplicates, keeping first casing', () => {
    expect(parseTagResponse('Rust, rust, RUST, Async')).toEqual([
      'Rust',
      'Async',
    ]);
  });

  it('drops sentence-length entries (>40 chars)', () => {
    expect(
      parseTagResponse(
        'rust, This is a Rust async runtime for writing reliable, async'
      )
    ).toEqual(['rust', 'async']);
  });

  it('drops empty entries from trailing commas / double commas', () => {
    expect(parseTagResponse('rust, , , async,,')).toEqual(['rust', 'async']);
  });
});

describe('parseTagResponse — edge cases', () => {
  it('returns [] on empty input', () => {
    expect(parseTagResponse('')).toEqual([]);
    expect(parseTagResponse('   ')).toEqual([]);
  });

  it('returns [] when given a non-string (defensive)', () => {
    expect(parseTagResponse(null as unknown as string)).toEqual([]);
    expect(parseTagResponse(undefined as unknown as string)).toEqual([]);
  });

  it('returns [] when every entry exceeds the 40-char tag-length threshold', () => {
    // Each comma-separated piece must be >40 chars to test the drop path —
    // "way too long" alone is only 12 chars and would otherwise be kept.
    const allTooLong =
      'this is way too long to be considered a real tag, ' +
      'and this one is also way too long to be a tag either';
    expect(parseTagResponse(allTooLong)).toEqual([]);
  });
});
