/**
 * Canonical zod schemas for the local-first store.
 * Source of truth: GitHub REST `/user/starred` shape, projected to our minimal needs.
 */
import { z } from 'zod';

export const StarredRepoSchema = z.object({
  /** Schema version for forward-compatible migrations. Bump when changing required fields. */
  schemaVersion: z.literal(1).default(1),
  /** GitHub repo id (numeric, stable across renames). Primary key. */
  id: z.number().int().positive(),
  /** `owner/repo` form. */
  fullName: z.string().min(3),
  /** Canonical GitHub page (https://github.com/owner/repo). */
  htmlUrl: z.string().url(),
  /** Owner login (denormalized for cheap filtering by author). */
  ownerLogin: z.string(),
  /** Owner avatar (UI display, cached locally is fine). */
  ownerAvatarUrl: z.string().url().nullable().default(null),
  /** Repo description (may be empty). */
  description: z.string().nullable(),
  /** Topics array from GitHub. */
  topics: z.array(z.string()).default([]),
  /** Primary language reported by GitHub. */
  language: z.string().nullable(),
  /** ISO-8601 of when user starred. */
  starredAt: z.string(),
  /**
   * ISO-8601 of latest push. Nullable: GitHub returns `pushed_at: null` for a
   * repo that has never been pushed to (freshly created / empty). A single
   * such starred repo must not abort the whole sync.
   * Note: IndexedDB's `by-pushedAt` index skips null-keyed rows, so a
   * never-pushed repo is omitted from `list({ orderBy: 'pushedAt' })` — which
   * is the correct behavior for a "what's new" digest anyway.
   */
  pushedAt: z.string().nullable(),
  /** Star count snapshot at last sync. */
  stargazersCount: z.number().int().nonnegative(),
  /** Default branch name (for tarball deep-index later). */
  defaultBranch: z.string().default('main'),
  /** Whether the repo is archived (dead) — filter from W4 digest. */
  archived: z.boolean().default(false),
  /** Whether the repo is a fork — affects digest ranking. */
  isFork: z.boolean().default(false),
  /** User has opted to receive release notifications for this repo (W4). */
  subscribedToReleases: z.boolean().default(false),
  /** User has opted to deep-index source code (W5). */
  deepIndexed: z.boolean().default(false),
  /** Local AI-generated tags (user-editable). */
  aiTags: z.array(z.string()).default([]),
  /** Local AI-generated 1-line summary (cache). */
  aiSummary: z.string().nullable().default(null),
  /** Local user note (free-form). */
  userNote: z.string().nullable().default(null),
  /** ISO-8601 of last embedding refresh (null = never embedded). */
  lastEmbeddedAt: z.string().nullable().default(null),
  /** Last time we synced this row. */
  lastSyncedAt: z.string(),
  /**
   * AI-translated cache of the GitHub-original `description` field, keyed
   * by locale id (e.g. `zh-CN`, `ja`). Populated by translateStars when
   * the user hits "Translate to {locale}"; rendered as a transparent
   * substitute for `description` whenever the UI's active locale has an
   * entry. Original `description` is preserved untouched so a re-translate
   * or locale switch is cheap.
   *
   * Schema-version forward compatibility: pre-Phase-6 rows have no
   * `descriptionI18n` key at all; `.default({})` makes them parse cleanly
   * into an empty cache on first read after the version bump.
   */
  descriptionI18n: z.record(z.string(), z.string()).default({}),
  /** Same shape, for the AI-generated 1-line summary (W4 digest hook). */
  aiSummaryI18n: z.record(z.string(), z.string()).default({}),
  /**
   * Same shape, for the auto-tag output. Stored as one joined string per
   * locale (e.g. `"异步运行时, rust, 并发"`) because tag re-translation
   * round-trips through `parseTagResponse` anyway and a single chat call
   * per repo is cheaper than N small calls.
   */
  aiTagsI18n: z.record(z.string(), z.string()).default({}),
  /** ISO timestamp of last successful translate pass — null = never. */
  lastTranslatedAt: z.string().nullable().default(null),
});
export type StarredRepo = z.infer<typeof StarredRepoSchema>;

export const SyncCursorSchema = z.object({
  /** ETag from last /user/starred page response. */
  etag: z.string().nullable(),
  /** ISO-8601 of the most recent `starredAt` we've seen. */
  since: z.string().nullable(),
  /** Number of stars known locally. */
  knownCount: z.number().int().nonnegative(),
  /** When this cursor was last updated. */
  updatedAt: z.string(),
  /**
   * ISO timestamp of the most recent FULL sync (one that fetched the whole
   * /user/starred list and ran the un-star cleanup pass). Null = never
   * done a full sync; treat the same as "stale" — the orchestrator will
   * force the next sync into full mode. Forward-compatible default:
   * existing cursors written before W2 D3b parse with null here.
   */
  lastFullSyncAt: z.string().nullable().default(null),
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const StarTagSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentTag: z.string().nullable().default(null),
});
export type StarTag = z.infer<typeof StarTagSchema>;
