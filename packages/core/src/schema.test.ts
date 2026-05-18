import { describe, it, expect } from 'vitest';
import { StarredRepoSchema, SyncCursorSchema, StarTagSchema } from './schema.js';

describe('StarredRepoSchema', () => {
  it('accepts a minimal valid record and applies defaults', () => {
    const minimal = {
      id: 12345,
      fullName: 'rust-lang/rust',
      htmlUrl: 'https://github.com/rust-lang/rust',
      ownerLogin: 'rust-lang',
      description: 'The Rust programming language',
      language: 'Rust',
      starredAt: '2026-01-15T10:00:00Z',
      pushedAt: '2026-05-17T08:30:00Z',
      stargazersCount: 90000,
      lastSyncedAt: '2026-05-18T12:00:00Z',
    };
    const result = StarredRepoSchema.parse(minimal);
    expect(result.schemaVersion).toBe(1);
    expect(result.topics).toEqual([]);
    expect(result.defaultBranch).toBe('main');
    expect(result.archived).toBe(false);
    expect(result.isFork).toBe(false);
    expect(result.subscribedToReleases).toBe(false);
    expect(result.deepIndexed).toBe(false);
    expect(result.aiTags).toEqual([]);
    expect(result.aiSummary).toBeNull();
    expect(result.userNote).toBeNull();
    expect(result.lastEmbeddedAt).toBeNull();
    expect(result.ownerAvatarUrl).toBeNull();
  });

  it('rejects negative or zero id', () => {
    expect(() =>
      StarredRepoSchema.parse({
        id: 0,
        fullName: 'a/b',
        htmlUrl: 'https://github.com/a/b',
        ownerLogin: 'a',
        description: null,
        language: null,
        starredAt: '2026-01-01T00:00:00Z',
        pushedAt: '2026-01-01T00:00:00Z',
        stargazersCount: 0,
        lastSyncedAt: '2026-01-01T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects non-URL htmlUrl', () => {
    expect(() =>
      StarredRepoSchema.parse({
        id: 1,
        fullName: 'a/b',
        htmlUrl: 'not-a-url',
        ownerLogin: 'a',
        description: null,
        language: null,
        starredAt: '2026-01-01T00:00:00Z',
        pushedAt: '2026-01-01T00:00:00Z',
        stargazersCount: 0,
        lastSyncedAt: '2026-01-01T00:00:00Z',
      })
    ).toThrow();
  });
});

describe('SyncCursorSchema', () => {
  it('accepts a fresh cursor with null etag/since', () => {
    const result = SyncCursorSchema.parse({
      etag: null,
      since: null,
      knownCount: 0,
      updatedAt: '2026-05-18T12:00:00Z',
    });
    expect(result.knownCount).toBe(0);
    expect(result.etag).toBeNull();
  });
});

describe('StarTagSchema', () => {
  it('accepts a tag with valid hex color', () => {
    const result = StarTagSchema.parse({ name: 'rust', color: '#ff8800' });
    expect(result.name).toBe('rust');
    expect(result.color).toBe('#ff8800');
    expect(result.parentTag).toBeNull();
  });

  it('rejects invalid hex color', () => {
    expect(() => StarTagSchema.parse({ name: 'rust', color: 'red' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => StarTagSchema.parse({ name: '' })).toThrow();
  });
});
