/**
 * Canonical zod schemas for the local-first store.
 * Source of truth: GitHub REST `/user/starred` shape, projected to our minimal needs.
 */
import { z } from 'zod';

export const StarredRepoSchema = z.object({
  /** GitHub repo id (numeric, stable across renames). Primary key. */
  id: z.number().int().positive(),
  /** `owner/repo` form. */
  fullName: z.string().min(3),
  /** Repo description (may be empty). */
  description: z.string().nullable(),
  /** Topics array from GitHub. */
  topics: z.array(z.string()).default([]),
  /** Primary language reported by GitHub. */
  language: z.string().nullable(),
  /** ISO-8601 of when user starred. */
  starredAt: z.string(),
  /** ISO-8601 of latest push. */
  pushedAt: z.string(),
  /** Star count snapshot at last sync. */
  stargazersCount: z.number().int().nonnegative(),
  /** Default branch name (for tarball deep-index later). */
  defaultBranch: z.string().default('main'),
  /** Local AI-generated tags (user-editable). */
  aiTags: z.array(z.string()).default([]),
  /** Local AI-generated 1-line summary (cache). */
  aiSummary: z.string().nullable().default(null),
  /** Local user note (free-form). */
  userNote: z.string().nullable().default(null),
  /** Last time we synced this row. */
  lastSyncedAt: z.string(),
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
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const StarTagSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentTag: z.string().nullable().default(null),
});
export type StarTag = z.infer<typeof StarTagSchema>;
