/**
 * Deep-index orchestrator — turns a starred repo's source files into vector
 * rows ready for code-context search.
 *
 *   starStore.get(repoId) → fetchRepoSource → chunkSource per file
 *                                          → embed batches → upsert
 *
 * Mirrors the W3 D2 `embedStars` shape: callback-decoupled so @starkit/core
 * stays free of @starkit/ai + @starkit/vector workspace deps. The popup
 * adapts AIProvider.embed + VectorStore.upsertMany + VectorStore.get at
 * the wiring layer.
 *
 * Key id format: `code:{repoId}:{path}:{chunkIndex}` (architecture
 * subagent confirmed; matches the pre-commit comment at idb.ts:62). Lets
 * the search UI filter "code only" via id-prefix without touching metadata.
 */
import type { StarStore } from '../storage/types.js';
import { contentHash } from '../embedding/text.js';
import type {
  EmbedBatchFn,
  EmbeddingRow,
  VectorLookupFn,
  VectorUpsertFn,
} from '../embedding/orchestrator.js';
import { chunkSource, type CodeChunk } from './chunk.js';
import type { SourceFile } from './fetch.js';

export interface IndexRepoCodeOptions {
  readonly starStore: StarStore;
  readonly repoId: number;
  /**
   * Caller-supplied source loader. Implementations: in the popup, this
   * wraps `fetchRepoSource(client, owner, repo, ref)`; in tests, this
   * returns a fixed `SourceFile[]` so the suite doesn't hit GitHub.
   */
  readonly fetchSource: (
    owner: string,
    repo: string,
    signal?: AbortSignal
  ) => Promise<ReadonlyArray<SourceFile>>;
  readonly embed: EmbedBatchFn;
  readonly upsert: VectorUpsertFn;
  /** Optional skip-cache (same contract as embedStars.getExisting). */
  readonly getExisting?: VectorLookupFn;
  /** Embed batch size — chunks per provider.embed call. Default 16
   *  (smaller than embedStars's 32 because code chunks are longer in
   *  tokens; the 16×~600-token chunks stay under the OpenAI 8k input cap
   *  with margin to spare). */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  /** Progress callback. `done` counts chunks (NOT files) so the UI can
   *  render a smooth bar; `total` is reported once after chunking finishes. */
  readonly onProgress?: (done: number, total: number, label?: string) => void;
}

export interface IndexRepoCodeResult {
  readonly indexed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly files: number;
  readonly chunks: number;
  readonly totalInputTokens: number;
  readonly model: string | null;
}

const DEFAULT_BATCH_SIZE = 16;

/**
 * Run one deep-index pass over a single repo.
 *
 * Pipeline:
 *   1. Read the StarredRepo from starStore so we have owner/repo/defaultBranch.
 *   2. Fetch source files via the caller's callback.
 *   3. Chunk every file (semantic when language is known, sliding window
 *      otherwise — see chunk.ts).
 *   4. For each chunk, compute contentHash. If `getExisting` returns a
 *      matching hash at the same id, skip — re-runs are cheap.
 *   5. Batch the remaining chunks through `embed`; upsert results.
 *
 * Mark `star.deepIndexed = true` at the end (caller's responsibility —
 * we don't mutate the starStore record here so the orchestrator stays
 * read-only against StarStore. The popup wraps with a final upsertMany.)
 */
export async function indexRepoCode(
  opts: IndexRepoCodeOptions
): Promise<IndexRepoCodeResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize < 1) {
    throw new Error(`indexRepoCode: batchSize must be >= 1, got ${batchSize}`);
  }

  const star = await opts.starStore.get(opts.repoId);
  if (!star) {
    throw new Error(`indexRepoCode: starStore has no row for id=${opts.repoId}`);
  }

  // Pull repo files (network call; can abort).
  if (opts.signal?.aborted) {
    throw new DOMException('indexRepoCode aborted', 'AbortError');
  }
  const [owner, repo] = star.fullName.split('/');
  if (!owner || !repo) {
    throw new Error(
      `indexRepoCode: malformed fullName "${star.fullName}" — expected owner/repo`
    );
  }
  const files = await opts.fetchSource(owner, repo, opts.signal);

  // Chunk every file. Build the (id, input, hash) tuples up-front so the
  // skip-cache + batching loop downstream is a pure transform.
  type Pending = {
    readonly id: string;
    readonly input: string;
    readonly hash: string;
    readonly chunk: CodeChunk;
    readonly path: string;
  };
  const pending: Pending[] = [];
  for (const file of files) {
    const chunks = chunkSource(file.content, file.language);
    for (let i = 0; i < chunks.length; i += 1) {
      const ch = chunks[i]!;
      // Reuse djb2 contentHash over the chunk text — same definition the
      // embed pipeline uses for stars. A pseudo-StarredRepo built from the
      // chunk text would also work; using contentHash on the text directly
      // keeps this module's surface small.
      const id = `code:${opts.repoId}:${file.path}:${i}`;
      pending.push({
        id,
        input: ch.text,
        hash: textHash(ch.text),
        chunk: ch,
        path: file.path,
      });
    }
  }

  const total = pending.length;
  opts.onProgress?.(0, total, 'chunking');

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let model: string | null = null;
  let done = 0;

  // Batch loop. Same shape as embedStars: parallel getExisting per batch,
  // single embed call, single upsert, per-batch failure isolation.
  for (let i = 0; i < pending.length; i += batchSize) {
    if (opts.signal?.aborted) {
      throw new DOMException('indexRepoCode aborted', 'AbortError');
    }
    const batch = pending.slice(i, i + batchSize);
    const existings = opts.getExisting
      ? await Promise.all(batch.map((p) => opts.getExisting!(p.id)))
      : null;

    const toEmbed: Pending[] = [];
    for (let j = 0; j < batch.length; j += 1) {
      const p = batch[j]!;
      if (existings) {
        const existingHash = existings[j]?.metadata?.['contentHash'];
        if (typeof existingHash === 'string' && existingHash === p.hash) {
          skipped += 1;
          continue;
        }
      }
      toEmbed.push(p);
    }

    if (toEmbed.length === 0) {
      done += batch.length;
      opts.onProgress?.(done, total, 'embedding');
      continue;
    }

    try {
      const embedResult = await opts.embed(
        toEmbed.map((p) => p.input),
        opts.signal
      );
      if (opts.signal?.aborted) {
        throw new DOMException('indexRepoCode aborted', 'AbortError');
      }
      if (embedResult.vectors.length !== toEmbed.length) {
        throw new Error(
          `indexRepoCode: provider returned ${embedResult.vectors.length} vectors for ${toEmbed.length} inputs`
        );
      }
      const now = new Date().toISOString();
      const rows: EmbeddingRow[] = toEmbed.map((p, idx) => ({
        id: p.id,
        vector: embedResult.vectors[idx]!,
        metadata: {
          // Re-use the `starId` key from star embeddings so downstream
          // rehydrate (digest, search rendering) works uniformly.
          starId: opts.repoId,
          contentHash: p.hash,
          model: embedResult.model,
          embeddedAt: now,
          // Code-specific fields the UI uses to render the snippet.
          kind: p.chunk.kind,
          path: p.path,
          startLine: p.chunk.startLine,
          endLine: p.chunk.endLine,
          headerLine: p.chunk.headerLine,
          // First ~240 chars of the chunk so the search UI can render a
          // preview without re-fetching from GitHub. Capped to keep IDB
          // row size reasonable (~200 chunks/repo × 240B = 48KB metadata
          // overhead per opt-in repo, acceptable).
          snippet: p.chunk.text.slice(0, 240),
        },
      }));
      await opts.upsert(rows);
      indexed += toEmbed.length;
      totalInputTokens += embedResult.inputTokens;
      model = embedResult.model;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')
      ) {
        throw err;
      }
      failed += toEmbed.length;
    }

    done += batch.length;
    opts.onProgress?.(done, total, 'embedding');
  }

  return {
    indexed,
    skipped,
    failed,
    files: files.length,
    chunks: total,
    totalInputTokens,
    model,
  };
}

/**
 * djb2 hash over a chunk text. Local copy (vs importing the star one) so
 * `code:` chunks and `star:` rows don't accidentally collide on the rare
 * case that a chunk text equals a star's composed input. The seed differs
 * by 1 from the star hash so the same input → different hex output.
 */
function textHash(s: string): string {
  let h = 5382; // star hash uses 5381 — this seed shifts to disambiguate.
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
