import { describe, expect, it } from 'vitest';
import type { StarredRepo } from '../schema.js';
import { buildStarEmbeddingInput, contentHash } from './text.js';

/**
 * Helper: build a StarredRepo with sensible defaults so each test only spells
 * out the fields it cares about. Mirrors the schema's required keys.
 */
function makeStar(overrides: Partial<StarredRepo> = {}): StarredRepo {
  return {
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
    lastSyncedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

describe('buildStarEmbeddingInput', () => {
  it('includes fullName, language, description, and topics on the canonical case', () => {
    const out = buildStarEmbeddingInput(makeStar());
    expect(out).toBe(
      [
        'tokio-rs/tokio',
        'language: Rust',
        'A runtime for writing reliable asynchronous applications with Rust.',
        'topics: async, rust, runtime',
      ].join('\n')
    );
  });

  it('omits language line when language is null', () => {
    const out = buildStarEmbeddingInput(makeStar({ language: null }));
    expect(out).not.toContain('language:');
    expect(out).toContain('tokio-rs/tokio');
  });

  it('omits language line when language is empty string', () => {
    const out = buildStarEmbeddingInput(makeStar({ language: '' }));
    expect(out).not.toContain('language:');
  });

  it('omits description line when description is null', () => {
    const out = buildStarEmbeddingInput(makeStar({ description: null }));
    // No empty line where description would have been
    expect(out.split('\n')).toEqual([
      'tokio-rs/tokio',
      'language: Rust',
      'topics: async, rust, runtime',
    ]);
  });

  it('omits topics line when topics array is empty', () => {
    const out = buildStarEmbeddingInput(makeStar({ topics: [] }));
    expect(out).not.toContain('topics:');
  });

  it('handles a star with only fullName and nothing else', () => {
    // Minimal valid star — everything optional set to its empty value.
    const out = buildStarEmbeddingInput(
      makeStar({ description: null, language: null, topics: [] })
    );
    expect(out).toBe('tokio-rs/tokio');
  });

  it('joins multi-element topics with comma+space (matches what embeddings expect)', () => {
    const out = buildStarEmbeddingInput(makeStar({ topics: ['a', 'b', 'c'] }));
    expect(out).toContain('topics: a, b, c');
  });
});

describe('contentHash', () => {
  it('is deterministic — same star yields same hash across calls', () => {
    const a = contentHash(makeStar());
    const b = contentHash(makeStar());
    expect(a).toBe(b);
  });

  it('changes when description changes', () => {
    const a = contentHash(makeStar());
    const b = contentHash(makeStar({ description: 'Completely different text.' }));
    expect(a).not.toBe(b);
  });

  it('changes when topics change', () => {
    const a = contentHash(makeStar());
    const b = contentHash(makeStar({ topics: ['async', 'rust'] }));
    expect(a).not.toBe(b);
  });

  it('changes when language changes', () => {
    const a = contentHash(makeStar());
    const b = contentHash(makeStar({ language: 'Go' }));
    expect(a).not.toBe(b);
  });

  it('does NOT change when only embedding-irrelevant fields move', () => {
    // starredAt / stargazersCount / lastSyncedAt are not in the embedding
    // input — so a re-sync that updates them must keep the hash stable, or
    // we'd burn through provider quota re-embedding unchanged content.
    const a = contentHash(makeStar());
    const b = contentHash(
      makeStar({
        starredAt: '2025-01-01T00:00:00Z',
        stargazersCount: 99999,
        lastSyncedAt: '2026-06-01T00:00:00Z',
        pushedAt: '2026-05-01T00:00:00Z',
      })
    );
    expect(a).toBe(b);
  });

  it('returns a short lowercase hex string (fits in IDB metadata cheaply)', () => {
    const h = contentHash(makeStar());
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h.length).toBeLessThanOrEqual(8); // 32-bit unsigned hex max
  });
});

describe('R53 — buildStarEmbeddingInput truncation', () => {
  it('caps composed input at 2000 chars (prevents per-input 413)', () => {
    // User reported: 2 stars persistently failing 413 after R52 split
    // reduced them to single inputs. Root cause: the assembled string
    // exceeded SiliconFlow's per-request body cap. Defense: clamp at
    // build time so no input ever leaves orchestrator over 2000 chars.
    const longDesc = 'x'.repeat(5000);
    const input = buildStarEmbeddingInput(
      makeStar({
        fullName: 'foo/giant-readme',
        description: longDesc,
      })
    );
    expect(input.length).toBeLessThanOrEqual(2000);
    expect(input.startsWith('foo/giant-readme')).toBe(true);
  });

  it('does NOT truncate normal-sized descriptions (typical case)', () => {
    const input = buildStarEmbeddingInput(
      makeStar({
        fullName: 'tokio-rs/tokio',
        description: 'Async runtime for Rust.',
        language: 'Rust',
        topics: ['async', 'rust'],
      })
    );
    expect(input).toContain('tokio-rs/tokio');
    expect(input).toContain('Async runtime');
    expect(input).toContain('language: Rust');
    expect(input).toContain('topics: async, rust');
    expect(input.length).toBeLessThan(200);
  });

  it('contentHash incorporates the truncation (same hash for tail differences past cap)', () => {
    // Force the differentiating bytes well past the 2000-char cap so the
    // truncation strictly removes them. Two descriptions identical for the
    // first ~5000 chars and differing only at positions > cap → same hash.
    const a = makeStar({ id: 1, description: 'a'.repeat(5000) + 'TAIL_A' });
    const b = makeStar({ id: 1, description: 'a'.repeat(5000) + 'TAIL_B' });
    expect(contentHash(a)).toBe(contentHash(b));
  });
});
