/**
 * W3 Day 3 — popup with semantic search wiring.
 *
 * Mode progression (state machine, top-to-bottom in render):
 *   1. no PAT          → render PAT input
 *   2. PAT set, no key → render OpenAI key input + cached stars (no search)
 *   3. both keys, no index → "Build search index" + cached stars
 *   4. both + index ready → search bar live; empty query = top-10 stars,
 *                           non-empty = top-5 semantic results
 *
 * State machine compresses linearly: each unlock reveals one new affordance.
 * The user can always re-open settings to rotate keys or rebuild.
 *
 * Search performance budget (W3 demo gate): "rust async runtime" → top-5 in
 * <500ms. Breakdown on 1000 stars × 1536-dim:
 *   - query embed (1 OpenAI call):  ~150-300ms
 *   - cosine top-K in memory store:  ~5ms
 *   - starStore.getMany rehydrate:   ~10ms (IDB warm)
 *   - render:                        ~5ms
 *   Total: ~200-350ms, well under budget.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createGithubClient,
  embedStars,
  fetchRepoSource,
  formatError,
  formatRelativeTime,
  formatSyncSummary,
  generateDigest,
  indexRepoCode,
  summarizeDigestEntries,
  syncStarsWithStore,
  tagStars,
  type DigestResult,
  type StarredRepo,
  type SyncCursor,
} from '@starkit/core';
// Direct OpenAIProvider import — popup v1 hardcodes OpenAI. createProvider
// would pull in the whole factory tree (Anthropic / Voyage / Ollama /
// openai-compatible) and ~30-40KB of dead code into the popup bundle.
// When provider selection becomes a user-facing setting, switch back.
// R10 蓝军 fix #1.
import { OpenAIProvider } from '@starkit/ai';
import { MemoryVectorStore, type VectorSearchResult } from '@starkit/vector';
import { releaseSyncLock, tryAcquireSyncLock } from '../shared/lock.js';
import { KV_KEY_OPENAI_KEY, KV_KEY_PAT, getStores } from './db.js';

/** Identifier the popup uses when grabbing the cross-context sync lock. */
const POPUP_OWNER_ID = 'popup-manual';

/** Default embed model — text-embedding-3-small balances cost ($0.02/M tokens)
 *  with quality. Future settings UI may swap this. */
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

type SyncState = 'idle' | 'syncing';
type EmbedState = 'idle' | 'embedding';
type SearchState = 'idle' | 'searching';
type TagState = 'idle' | 'tagging';
type DeepIndexState = 'idle' | 'indexing';

/** How many stars to deep-index per "Deep index top N" click. Higher = more
 *  code coverage in search results but a longer wall-clock + GitHub quota
 *  hit. 3 is the v1 default: enough to demonstrate cross-repo code search
 *  on the demo gate; cheap enough to run twice without scary numbers. */
const DEEP_INDEX_TOP_N = 3;

/** Default chat model for auto-tag. gpt-4o-mini is the cost/quality sweet
 *  spot for one-shot classification — $0.15/$0.60 per M tokens. */
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';

/** A star-level search hit — semantic match on the repo's
 *  description / topics / language composition. */
interface StarHit {
  readonly kind: 'star';
  readonly star: StarredRepo;
  readonly score: number;
}

/** A code-chunk-level search hit — semantic match on a function / class
 *  / method body inside a deep-indexed repo. metadata fields were stamped
 *  by indexRepoCode at embed time, so the UI doesn't need to re-fetch
 *  source to render the snippet preview + permalink. */
interface CodeHit {
  readonly kind: 'code';
  readonly star: StarredRepo;
  readonly score: number;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly headerLine: string;
  readonly snippet: string;
}

type SearchHit = StarHit | CodeHit;

export function App(): JSX.Element {
  // null = loading from IDB; string = persisted value; '' = user clearing
  const [pat, setPat] = useState<string | null>(null);
  const [patDraft, setPatDraft] = useState<string>('');
  const [openaiKey, setOpenaiKey] = useState<string | null>(null);
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState<string>('');

  const [stars, setStars] = useState<ReadonlyArray<StarredRepo>>([]);
  const [knownCount, setKnownCount] = useState<number>(0);
  const [indexedCount, setIndexedCount] = useState<number>(0);
  const [untaggedCount, setUntaggedCount] = useState<number>(0);
  const [cursor, setCursor] = useState<SyncCursor | null>(null);

  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [embedState, setEmbedState] = useState<EmbedState>('idle');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [tagState, setTagState] = useState<TagState>('idle');
  const [deepIndexState, setDeepIndexState] = useState<DeepIndexState>('idle');
  const [deepIndexProgress, setDeepIndexProgress] = useState<{
    repo: string;
    done: number;
    total: number;
  } | null>(null);
  const [deepIndexedCount, setDeepIndexedCount] = useState<number>(0);

  const [error, setError] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [tagProgress, setTagProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const [query, setQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ReadonlyArray<SearchHit>>(
    []
  );
  const [digest, setDigest] = useState<DigestResult | null>(null);

  // The popup-lifetime hot index. Pre-filled from IDB at mount; mutated by
  // every embed pass (dual-upsert) so it stays in sync without re-loading.
  const memVecRef = useRef<MemoryVectorStore | null>(null);

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stores = await getStores();
        const [storedPat, storedKey, top, cnt, cur, vecRows] =
          await Promise.all([
            stores.kvStore.get<string>(KV_KEY_PAT),
            stores.kvStore.get<string>(KV_KEY_OPENAI_KEY),
            stores.starStore.list({ limit: 10 }),
            stores.starStore.count(),
            stores.cursorStore.get(),
            stores.vectorStore.list(),
          ]);
        if (cancelled) return;

        // Hot-seed the memory store. ~12MB for 1000×1536 — well within popup
        // budget. memVecRef survives across React re-renders.
        const mem = new MemoryVectorStore();
        await mem.upsertMany(vecRows);
        memVecRef.current = mem;

        setPat(storedPat ?? '');
        setOpenaiKey(storedKey ?? '');
        setStars(top);
        setKnownCount(cnt);
        setCursor(cur);
        setIndexedCount(vecRows.length);
        // Untagged count drives the "Auto-tag" button label + visibility.
        // Full-store scan via list() is acceptable at v1 row counts (~1000);
        // a future cursor backend can swap this for an indexed predicate
        // count when row counts justify it.
        const all = await stores.starStore.list();
        setUntaggedCount(all.filter((s) => s.aiTags.length === 0).length);
        setDeepIndexedCount(all.filter((s) => s.deepIndexed).length);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Settings handlers ────────────────────────────────────────────────
  const onSavePat = useCallback(async () => {
    const trimmed = patDraft.trim();
    if (!trimmed) return;
    try {
      const { kvStore } = await getStores();
      await kvStore.set(KV_KEY_PAT, trimmed);
      setPat(trimmed);
      setPatDraft('');
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [patDraft]);

  const onSaveOpenaiKey = useCallback(async () => {
    const trimmed = openaiKeyDraft.trim();
    if (!trimmed) return;
    try {
      const { kvStore } = await getStores();
      await kvStore.set(KV_KEY_OPENAI_KEY, trimmed);
      setOpenaiKey(trimmed);
      setOpenaiKeyDraft('');
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [openaiKeyDraft]);

  const onClearAll = useCallback(async () => {
    try {
      const { kvStore, starStore, cursorStore, vectorStore } = await getStores();
      await Promise.all([
        kvStore.delete(KV_KEY_PAT),
        kvStore.delete(KV_KEY_OPENAI_KEY),
        starStore.clear(),
        cursorStore.clear(),
        vectorStore.clear(),
        // R10 蓝军 fix #7: clear sync.lock too — chrome.storage.local lives
        // separately from IDB, so a "reset cache" that forgets the lock
        // could leave the user unable to sync for up to 2 min (TTL) if a
        // cron fire happened to coincide with the reset.
        chrome.storage.local.remove('sync.lock'),
      ]);
      memVecRef.current = new MemoryVectorStore();
      setPat('');
      setOpenaiKey('');
      setStars([]);
      setKnownCount(0);
      setIndexedCount(0);
      setUntaggedCount(0);
      setDeepIndexedCount(0);
      setCursor(null);
      setLastSyncSummary(null);
      setSearchResults([]);
      setQuery('');
      setDigest(null);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  // ─── Sync handler ─────────────────────────────────────────────────────
  const onSync = useCallback(async () => {
    if (!pat) return;
    setSyncState('syncing');
    setError(null);

    const lockAcquired = await tryAcquireSyncLock(POPUP_OWNER_ID);
    if (!lockAcquired) {
      setError('Another sync is running in the background. Try again in a moment.');
      setSyncState('idle');
      return;
    }

    try {
      const { starStore, cursorStore } = await getStores();
      const client = createGithubClient({
        token: pat,
        userAgent: '@starkit/extension',
      });
      const result = await syncStarsWithStore(client, { starStore, cursorStore });
      const [top, cnt, cur] = await Promise.all([
        starStore.list({ limit: 10 }),
        starStore.count(),
        cursorStore.get(),
      ]);
      setStars(top);
      setKnownCount(cnt);
      setCursor(cur);
      setLastSyncSummary(formatSyncSummary(result));
      // Newly-synced stars start untagged, so the count grows post-sync.
      const all = await starStore.list();
      setUntaggedCount(all.filter((s) => s.aiTags.length === 0).length);
      // R9 蓝军 fix C1: clear stale digest after sync — its ranks are now
      // computed against pre-sync data and could mislead the user.
      setDigest(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      await releaseSyncLock(POPUP_OWNER_ID);
      setSyncState('idle');
    }
  }, [pat]);

  // ─── Embed: build search index ────────────────────────────────────────
  const onBuildIndex = useCallback(async () => {
    if (!openaiKey || embedState === 'embedding') return;
    setEmbedState('embedding');
    setIndexProgress({ done: 0, total: knownCount });
    setError(null);

    try {
      const { starStore, vectorStore } = await getStores();
      const provider = new OpenAIProvider({
        provider: 'openai',
        apiKey: openaiKey,
        embedModel: DEFAULT_EMBED_MODEL,
      });
      const memVec = memVecRef.current ?? new MemoryVectorStore();
      memVecRef.current = memVec;

      await embedStars({
        starStore,
        // Adapter: AIProvider.embed takes an EmbedRequest object;
        // EmbedBatchFn wants positional (inputs, signal).
        embed: (inputs, signal) =>
          provider.embed({ inputs, ...(signal ? { signal } : {}) }).then((r) => ({
            vectors: r.vectors,
            model: r.model,
            inputTokens: r.inputTokens,
          })),
        // Dual-upsert: persistent IDB store + hot memory index. Parallelized
        // because the two stores are independent — IDB latency doesn't gate
        // memory's instant update.
        upsert: async (rows) => {
          const [idbResult] = await Promise.all([
            vectorStore.upsertMany(rows),
            memVec.upsertMany(rows),
          ]);
          return idbResult;
        },
        // Hash-based skip-cache → vectorStore.get returns rows whose
        // metadata.contentHash we already know. Loosened VectorLookupFn
        // makes this assignment direct (R5 fix).
        getExisting: (id) => vectorStore.get(id),
        onProgress: (done, total) => setIndexProgress({ done, total }),
      });

      const newCount = await vectorStore.count();
      setIndexedCount(newCount);
      setIndexProgress(null);
      // R9 蓝军 fix C1: re-embedding rewrites the profile centroid; any
      // on-screen digest's scores are no longer reproducible. Clear it.
      setDigest(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setEmbedState('idle');
    }
  }, [openaiKey, embedState, knownCount]);

  // ─── Auto-tag: LLM-generated tags per repo ────────────────────────────
  const onAutoTag = useCallback(async () => {
    if (!openaiKey || tagState === 'tagging') return;
    setTagState('tagging');
    setTagProgress({ done: 0, total: untaggedCount });
    setError(null);

    try {
      const { starStore } = await getStores();
      const provider = new OpenAIProvider({
        provider: 'openai',
        apiKey: openaiKey,
        chatModel: DEFAULT_CHAT_MODEL,
      });

      await tagStars({
        starStore,
        // Adapter: AIProvider.chat takes a ChatRequest object; ChatBatchFn
        // wants (system, user, signal) positional.
        chat: (system, user, signal) =>
          provider
            .chat({ system, user, ...(signal ? { signal } : {}) })
            .then((r) => ({
              text: r.text,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              model: r.model,
            })),
        // Persist aiTags by re-upserting the star row with the new tags
        // merged in. starStore.upsertMany validates via zod so a malformed
        // aiTags array would fail loudly here rather than silently corrupt
        // the row.
        updateStar: async (id, aiTags) => {
          const existing = await starStore.get(id);
          if (!existing) return;
          await starStore.upsertMany([{ ...existing, aiTags: [...aiTags] }]);
        },
        onProgress: (done, total) => setTagProgress({ done, total }),
      });

      // Refresh: top-10 list re-fetches so tags become visible; untagged
      // count drops to whatever didn't get tagged this pass (parser empty,
      // chat errors, etc.).
      const [top, all] = await Promise.all([
        starStore.list({ limit: 10 }),
        starStore.list(),
      ]);
      setStars(top);
      setUntaggedCount(all.filter((s) => s.aiTags.length === 0).length);
      setTagProgress(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setTagState('idle');
    }
  }, [openaiKey, tagState, untaggedCount]);

  // ─── Deep-index: fetch source for top-N starred + embed code chunks ────
  const onDeepIndex = useCallback(async () => {
    if (!pat || !openaiKey || deepIndexState === 'indexing') return;
    setDeepIndexState('indexing');
    setError(null);

    try {
      const { starStore, vectorStore } = await getStores();
      // Pick top-N by stargazersCount that aren't already deep-indexed.
      // High-star repos are the obvious "code people would search" target;
      // skipping already-indexed ones makes re-clicks cheap.
      const all = await starStore.list();
      const candidates = all
        .filter((s) => !s.deepIndexed && !s.archived && !s.isFork)
        .sort((a, b) => b.stargazersCount - a.stargazersCount)
        .slice(0, DEEP_INDEX_TOP_N);

      if (candidates.length === 0) {
        setError(
          `No new repos to deep-index (already covered top ${DEEP_INDEX_TOP_N} by stars).`
        );
        return;
      }

      const githubClient = createGithubClient({
        token: pat,
        userAgent: '@starkit/extension(deep-index)',
      });
      const provider = new OpenAIProvider({
        provider: 'openai',
        apiKey: openaiKey,
        embedModel: DEFAULT_EMBED_MODEL,
      });
      const memVec = memVecRef.current ?? new MemoryVectorStore();
      memVecRef.current = memVec;

      for (let i = 0; i < candidates.length; i += 1) {
        const star = candidates[i]!;
        setDeepIndexProgress({
          repo: star.fullName,
          done: i,
          total: candidates.length,
        });

        const [owner, repo] = star.fullName.split('/');
        if (!owner || !repo) continue;

        await indexRepoCode({
          starStore,
          repoId: star.id,
          fetchSource: (o, r, signal) =>
            fetchRepoSource({
              client: githubClient,
              owner: o,
              repo: r,
              ref: star.defaultBranch,
              ...(signal ? { signal } : {}),
            }),
          embed: (inputs, signal) =>
            provider
              .embed({ inputs, ...(signal ? { signal } : {}) })
              .then((r) => ({
                vectors: r.vectors,
                model: r.model,
                inputTokens: r.inputTokens,
              })),
          upsert: async (rows) => {
            const [idbRes] = await Promise.all([
              vectorStore.upsertMany(rows),
              memVec.upsertMany(rows),
            ]);
            return idbRes;
          },
          getExisting: (id) => vectorStore.get(id),
        });

        // Mark this repo as deep-indexed so the next click skips it.
        await starStore.upsertMany([{ ...star, deepIndexed: true }]);
      }

      // Refresh the counters that gate the Deep-index button visibility.
      const [newIndexedCount, refreshed] = await Promise.all([
        vectorStore.count(),
        starStore.list(),
      ]);
      setIndexedCount(newIndexedCount);
      setDeepIndexedCount(refreshed.filter((s) => s.deepIndexed).length);
      setDeepIndexProgress(null);
      // Deep-indexing changes the vector population — any open digest is
      // computed against the pre-deep-index profile, so wipe it for the
      // same reason embed/sync do (R10 蓝军 fix C1 pattern).
      setDigest(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setDeepIndexState('idle');
    }
  }, [pat, openaiKey, deepIndexState]);

  // ─── Weekly Digest: rank recently-pushed by relevance to user profile ──
  const onShowDigest = useCallback(async () => {
    if (indexedCount === 0) {
      setError('Build the search index first to enable the weekly digest.');
      return;
    }
    setError(null);
    try {
      const { starStore, vectorStore } = await getStores();
      const result = await generateDigest({
        starStore,
        listVectors: async () => {
          const rows = await vectorStore.list();
          // Map vector rows -> {starId, vector}; drop rows whose metadata
          // doesn't carry a numeric starId (defensive against future
          // schema additions like W5 code-chunk rows that share the store).
          const out: Array<{ starId: number; vector: ReadonlyArray<number> }> = [];
          for (const r of rows) {
            const sid = r.metadata?.['starId'];
            if (typeof sid === 'number') {
              out.push({ starId: sid, vector: r.vector });
            }
          }
          return out;
        },
        windowDays: 7,
        limit: 10,
      });
      setDigest(result);
      setQuery(''); // Search query takes precedence; clear it so digest shows.
      setSearchResults([]);

      // W4 V1: layer the LLM "why this matters" hook on top of the ranking.
      // Async (popup shows the ranked list immediately; summaries fill in
      // as they return). Bounded concurrency = 3 so 10 entries finish in
      // ~3s on a typical OpenAI roundtrip. Errors are per-entry — the
      // ranking still ships even if every summary fails.
      if (openaiKey && result.entries.length > 0) {
        const provider = new OpenAIProvider({
          provider: 'openai',
          apiKey: openaiKey,
          chatModel: DEFAULT_CHAT_MODEL,
        });
        try {
          const withSummaries = await summarizeDigestEntries(
            result.entries,
            (system, user, signal) =>
              provider
                .chat({ system, user, ...(signal ? { signal } : {}) })
                .then((r) => ({
                  text: r.text,
                  inputTokens: r.inputTokens,
                  outputTokens: r.outputTokens,
                  model: r.model,
                })),
            { concurrency: 3 }
          );
          setDigest({ ...result, entries: withSummaries });
        } catch (sumErr) {
          // Summary layer is best-effort. Log + leave ranked list as-is.
          console.warn('[starkit] digest summaries failed:', sumErr);
        }
      }
    } catch (err) {
      setError(formatError(err));
    }
  }, [indexedCount, openaiKey]);

  const onCloseDigest = useCallback(() => {
    setDigest(null);
  }, []);

  // ─── Search ───────────────────────────────────────────────────────────
  const onSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || !openaiKey) {
      setSearchResults([]);
      return;
    }
    if (!memVecRef.current || indexedCount === 0) {
      setError('Build the search index first.');
      return;
    }
    setSearchState('searching');
    setError(null);

    try {
      const provider = new OpenAIProvider({
        provider: 'openai',
        apiKey: openaiKey,
        embedModel: DEFAULT_EMBED_MODEL,
      });
      const { vectors } = await provider.embed({ inputs: [trimmed] });
      const qVec = vectors[0]!;
      // Bump limit to 8: the result set is now a MIX of star + code hits,
      // and the demo gate explicitly asks for "top 5 code snippets" — so
      // give search room to surface enough of each kind.
      const hits = await memVecRef.current.search(qVec, { limit: 8 });

      // Rehydrate each hit. id prefix discriminates: `star:N` → StarHit,
      // `code:N:path:idx` → CodeHit. metadata fields were stamped by the
      // embed / index pipelines so we don't need to re-fetch source.
      const { starStore } = await getStores();
      const rehydrated = await Promise.all(
        hits.map(async (h: VectorSearchResult): Promise<SearchHit | null> => {
          const starId =
            typeof h.metadata?.['starId'] === 'number'
              ? (h.metadata['starId'] as number)
              : null;
          if (starId === null) return null;
          const star = await starStore.get(starId);
          if (!star) return null;

          if (h.id.startsWith('code:')) {
            const path = h.metadata?.['path'];
            const startLine = h.metadata?.['startLine'];
            const endLine = h.metadata?.['endLine'];
            const snippet = h.metadata?.['snippet'];
            if (
              typeof path !== 'string' ||
              typeof startLine !== 'number' ||
              typeof endLine !== 'number'
            ) {
              return null;
            }
            return {
              kind: 'code',
              star,
              score: h.score,
              path,
              startLine,
              endLine,
              headerLine:
                typeof h.metadata?.['headerLine'] === 'string'
                  ? h.metadata['headerLine']
                  : '',
              snippet: typeof snippet === 'string' ? snippet : '',
            };
          }

          return { kind: 'star', star, score: h.score };
        })
      );
      setSearchResults(rehydrated.filter((r): r is SearchHit => r !== null));
    } catch (err) {
      setError(formatError(err));
      setSearchResults([]);
    } finally {
      setSearchState('idle');
    }
  }, [query, openaiKey, indexedCount]);

  // Clear search results when query is wiped
  useEffect(() => {
    if (query.trim() === '') setSearchResults([]);
  }, [query]);

  // ─── Derived view state ───────────────────────────────────────────────
  const indexCoverage = useMemo(() => {
    if (knownCount === 0) return null;
    return Math.round((indexedCount / knownCount) * 100);
  }, [indexedCount, knownCount]);

  const needsRebuild = knownCount > 0 && indexedCount < knownCount;
  const canSearch = indexedCount > 0 && openaiKey !== null && openaiKey !== '';
  const showSearchResults = query.trim() !== '' && searchResults.length > 0;

  // ─── Render ───────────────────────────────────────────────────────────

  if (pat === null || openaiKey === null) {
    return (
      <main style={styles.shell}>
        <Header subtitle="loading…" />
      </main>
    );
  }

  if (pat === '') {
    return (
      <main style={styles.shell}>
        <Header subtitle="paste a GitHub PAT to begin" />
        <SettingsCard
          label="GitHub Personal Access Token"
          help="Needs public_repo scope (or repo for private). Stored locally; sent only to api.github.com."
          placeholder="ghp_…"
          value={patDraft}
          onChange={setPatDraft}
          onSave={() => void onSavePat()}
        />
        {error && <ErrorBanner message={error} />}
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <Header
        subtitle={
          cursor
            ? `${knownCount} stars · ${indexedCount} indexed · last synced ${formatRelativeTime(
                cursor.updatedAt
              )}`
            : `${knownCount} stars · ${indexedCount} indexed · never synced`
        }
        rightAction={
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={syncState === 'syncing'}
            style={styles.smallButton}
          >
            {syncState === 'syncing' ? 'Syncing…' : 'Sync'}
          </button>
        }
      />

      {error && <ErrorBanner message={error} />}
      {lastSyncSummary && !error && (
        <div style={styles.notice}>{lastSyncSummary}</div>
      )}

      {/* Search bar — always rendered when keys are set, but onSearch
          guards against running without an index. */}
      {canSearch && (
        <div style={styles.searchRow}>
          <input
            type="search"
            placeholder="Search starred repos… (semantic)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSearch();
            }}
            style={styles.searchInput}
          />
          <button
            type="button"
            onClick={() => void onSearch()}
            disabled={searchState === 'searching' || query.trim() === ''}
            style={styles.smallButton}
          >
            {searchState === 'searching' ? '…' : 'Go'}
          </button>
        </div>
      )}

      {/* OpenAI key section — only when missing; shows under the search row
          so a configured user doesn't see it. */}
      {openaiKey === '' && (
        <SettingsCard
          label="OpenAI API Key (for search)"
          help="Used only for embedding your starred repos. Stored locally; sent only to api.openai.com. ~$0.02 to index 1000 stars."
          placeholder="sk-…"
          value={openaiKeyDraft}
          onChange={setOpenaiKeyDraft}
          onSave={() => void onSaveOpenaiKey()}
        />
      )}

      {/* Build index button — gated on having OpenAI key + stars to index */}
      {openaiKey !== '' && needsRebuild && embedState === 'idle' && (
        <button
          type="button"
          onClick={() => void onBuildIndex()}
          disabled={knownCount === 0}
          style={styles.primaryButton}
        >
          {indexedCount === 0
            ? `Build search index (${knownCount} stars)`
            : `Update search index (${knownCount - indexedCount} new)`}
        </button>
      )}

      {embedState === 'embedding' && indexProgress && (
        <div style={styles.notice}>
          Embedding {indexProgress.done}/{indexProgress.total}
          {indexCoverage !== null ? ` · ${indexCoverage}% indexed` : ''}…
        </div>
      )}

      {/* Auto-tag + Weekly Digest action row */}
      {openaiKey !== '' && (untaggedCount > 0 || indexedCount > 0) && (
        <div style={styles.searchRow}>
          {untaggedCount > 0 && tagState === 'idle' && (
            <button
              type="button"
              onClick={() => void onAutoTag()}
              style={{ ...styles.secondaryButton, flex: 1 }}
            >
              Auto-tag {untaggedCount} repo{untaggedCount === 1 ? '' : 's'}
            </button>
          )}
          {indexedCount > 0 && !digest && (
            <button
              type="button"
              onClick={() => void onShowDigest()}
              style={{ ...styles.secondaryButton, flex: 1 }}
            >
              📰 Weekly digest
            </button>
          )}
          {knownCount > 0 && deepIndexState === 'idle' && (
            <button
              type="button"
              onClick={() => void onDeepIndex()}
              style={{ ...styles.secondaryButton, flex: 1 }}
              title={`Fetch source from top-${DEEP_INDEX_TOP_N} unindexed starred repos and embed their code so it shows up in semantic search.`}
            >
              {deepIndexedCount === 0
                ? `🔧 Deep-index top ${DEEP_INDEX_TOP_N}`
                : `🔧 Deep-index +${DEEP_INDEX_TOP_N} more`}
            </button>
          )}
        </div>
      )}

      {deepIndexState === 'indexing' && deepIndexProgress && (
        <div style={styles.notice}>
          Deep-indexing {deepIndexProgress.repo} ({deepIndexProgress.done + 1}/
          {deepIndexProgress.total})…
        </div>
      )}

      {tagState === 'tagging' && tagProgress && (
        <div style={styles.notice}>
          Tagging {tagProgress.done}/{tagProgress.total}…
        </div>
      )}

      {/* Results list — render priority:
          1. Search has results: show them
          2. Digest view active: show digest entries
          3. Otherwise: top-10 most-recently-starred */}
      {showSearchResults ? (
        <ol style={styles.list}>
          {searchResults.map((hit, idx) => (
            <li
              key={hit.kind === 'code' ? `${hit.star.id}:${hit.path}:${hit.startLine}` : `s:${hit.star.id}:${idx}`}
              style={styles.listItem}
            >
              {hit.kind === 'star' ? (
                <RepoLink star={hit.star} score={hit.score} />
              ) : (
                <CodeSnippet hit={hit} />
              )}
            </li>
          ))}
        </ol>
      ) : digest !== null ? (
        <>
          <div style={styles.digestHeader}>
            <span>
              📰 Weekly digest — top {digest.entries.length} of{' '}
              {digest.candidateCount} this week
              {digest.unembeddedCount > 0
                ? ` (+${digest.unembeddedCount} unranked, not yet embedded)`
                : ''}
            </span>
            <button
              type="button"
              onClick={onCloseDigest}
              style={styles.linkButton}
            >
              ← Recent
            </button>
          </div>
          {digest.entries.length === 0 ? (
            <section style={styles.card}>
              <strong>No recent activity.</strong>
              <p style={styles.helpText}>
                No starred repos have been pushed in the last 7 days.
              </p>
            </section>
          ) : (
            <ol style={styles.list}>
              {digest.entries.map((entry) => (
                <li key={entry.star.id} style={styles.listItem}>
                  <RepoLink star={entry.star} score={entry.score} />
                  {entry.summary && (
                    <div style={styles.digestSummary}>{entry.summary}</div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : stars.length === 0 ? (
        <section style={styles.card}>
          <strong>No stars cached yet.</strong>
          <p style={styles.helpText}>
            Click <b>Sync</b> to pull your stars from GitHub.
          </p>
        </section>
      ) : (
        <ol style={styles.list}>
          {stars.map((s) => (
            <li key={s.id} style={styles.listItem}>
              <RepoLink star={s} />
            </li>
          ))}
        </ol>
      )}

      <footer style={styles.footer}>
        <button type="button" onClick={() => void onClearAll()} style={styles.linkButton}>
          Reset keys &amp; clear cache
        </button>
      </footer>
    </main>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function Header(props: {
  readonly subtitle: string;
  readonly rightAction?: React.ReactNode;
}): JSX.Element {
  return (
    <header style={styles.header}>
      <div>
        <h1 style={styles.title}>GitHub Star Kit</h1>
        <p style={styles.subtitle}>{props.subtitle}</p>
      </div>
      {props.rightAction}
    </header>
  );
}

function ErrorBanner(props: { readonly message: string }): JSX.Element {
  return (
    <div role="alert" style={styles.errorBanner}>
      ⚠ {props.message}
    </div>
  );
}

function SettingsCard(props: {
  readonly label: string;
  readonly help: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly onSave: () => void;
}): JSX.Element {
  return (
    <section style={styles.card}>
      <label style={styles.label}>{props.label}</label>
      <input
        type="password"
        placeholder={props.placeholder}
        autoComplete="off"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSave();
        }}
        style={styles.input}
      />
      <p style={styles.helpText}>{props.help}</p>
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.value.trim().length === 0}
        style={styles.primaryButton}
      >
        Save
      </button>
    </section>
  );
}

function CodeSnippet(props: { readonly hit: CodeHit }): JSX.Element {
  const { hit } = props;
  // GitHub permalink format: /{owner}/{repo}/blob/{ref}#L{start}-L{end}
  // Using defaultBranch is acceptable for v1 — a future tightening could
  // pin the commit SHA we deep-indexed at to immortalize the link.
  const permalink = `${hit.star.htmlUrl}/blob/${hit.star.defaultBranch}/${hit.path}#L${hit.startLine}-L${hit.endLine}`;
  return (
    <>
      <div style={styles.repoLink}>
        <span style={styles.repoName}>
          <span style={styles.codeBadge}>code</span>
          {hit.star.fullName}
        </span>
        <span style={styles.repoMetaRight}>
          <span style={styles.scoreBadge}>{hit.score.toFixed(2)}</span>
        </span>
      </div>
      <div style={styles.repoMeta}>
        {hit.path} · L{hit.startLine}-{hit.endLine}
        {hit.headerLine ? ` · ${truncate(hit.headerLine, 60)}` : ''}
      </div>
      {hit.snippet && (
        <pre style={styles.snippetPreview}>{truncate(hit.snippet, 200)}</pre>
      )}
      <div style={styles.repoMeta}>
        <a
          href={permalink}
          target="_blank"
          rel="noreferrer"
          style={styles.snippetPermalink}
        >
          View on GitHub →
        </a>
      </div>
    </>
  );
}

function RepoLink(props: {
  readonly star: StarredRepo;
  readonly score?: number;
}): JSX.Element {
  const { star, score } = props;
  return (
    <>
      <a
        href={star.htmlUrl}
        target="_blank"
        rel="noreferrer"
        style={styles.repoLink}
        title={star.description ?? undefined}
      >
        <span style={styles.repoName}>{star.fullName}</span>
        <span style={styles.repoMetaRight}>
          {score !== undefined && (
            <span style={styles.scoreBadge}>{score.toFixed(2)}</span>
          )}
          {star.language && <span style={styles.repoLang}>{star.language}</span>}
        </span>
      </a>
      {star.description && (
        <div style={styles.repoDesc}>{truncate(star.description, 120)}</div>
      )}
      {star.aiTags.length > 0 && (
        <div style={styles.tagRow}>
          {star.aiTags.map((t) => (
            <span key={t} style={styles.tagChip}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div style={styles.repoMeta}>
        ★ {star.stargazersCount.toLocaleString()} · starred{' '}
        {formatRelativeTime(star.starredAt)}
      </div>
    </>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

// ─── Styles ───────────────────────────────────────────────────────────

const styles = {
  shell: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    minHeight: '480px',
    minWidth: '380px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  title: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
  },
  subtitle: {
    margin: '2px 0 0',
    fontSize: '11px',
    opacity: 0.7,
  },
  card: {
    padding: '12px',
    background: 'rgba(127, 127, 127, 0.08)',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    fontSize: '13px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 600,
    opacity: 0.85,
  },
  input: {
    padding: '8px 10px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: 'inherit',
    background: 'transparent',
    color: 'inherit',
  },
  helpText: {
    margin: '0',
    fontSize: '11px',
    opacity: 0.65,
    lineHeight: 1.5,
  },
  primaryButton: {
    padding: '8px 12px',
    border: 'none',
    background: '#2563eb',
    color: 'white',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '7px 12px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
  },
  tagRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    marginTop: '2px',
  },
  digestHeader: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    fontSize: '11px',
    fontWeight: 600,
    opacity: 0.75,
    padding: '4px 2px',
  },
  digestSummary: {
    fontSize: '11px',
    opacity: 0.8,
    lineHeight: 1.5,
    padding: '4px 8px',
    background: 'rgba(99, 102, 241, 0.05)',
    borderLeft: '2px solid rgba(99, 102, 241, 0.3)',
    borderRadius: '3px',
    fontStyle: 'italic' as const,
  },
  tagChip: {
    fontSize: '10px',
    padding: '1px 6px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '10px',
    fontWeight: 500,
  },
  smallButton: {
    padding: '4px 10px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    background: 'transparent',
    color: 'inherit',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  linkButton: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    opacity: 0.55,
    textDecoration: 'underline',
    fontSize: '11px',
    padding: 0,
    cursor: 'pointer',
  },
  searchRow: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center' as const,
  },
  searchInput: {
    flex: 1,
    padding: '7px 10px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '6px',
    fontSize: '13px',
    background: 'transparent',
    color: 'inherit',
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  listItem: {
    padding: '8px 10px',
    border: '1px solid rgba(127, 127, 127, 0.15)',
    borderRadius: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  repoLink: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'baseline' as const,
    gap: '8px',
    textDecoration: 'none',
    color: 'inherit',
  },
  repoName: {
    fontWeight: 600,
    fontSize: '13px',
  },
  repoMetaRight: {
    display: 'flex',
    gap: '6px',
    alignItems: 'baseline' as const,
    flexShrink: 0,
  },
  repoLang: {
    fontSize: '10px',
    opacity: 0.6,
  },
  scoreBadge: {
    fontSize: '10px',
    fontFamily: 'ui-monospace, monospace',
    padding: '1px 5px',
    background: 'rgba(34, 197, 94, 0.15)',
    color: 'rgb(22, 101, 52)',
    borderRadius: '3px',
  },
  codeBadge: {
    fontSize: '9px',
    fontFamily: 'ui-monospace, monospace',
    padding: '1px 4px',
    background: 'rgba(99, 102, 241, 0.18)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '3px',
    marginRight: '6px',
    textTransform: 'uppercase' as const,
    fontWeight: 700,
    letterSpacing: '0.5px',
  },
  snippetPreview: {
    fontSize: '10.5px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    background: 'rgba(127, 127, 127, 0.07)',
    border: '1px solid rgba(127, 127, 127, 0.15)',
    borderRadius: '4px',
    padding: '6px 8px',
    margin: '4px 0',
    overflowX: 'auto' as const,
    whiteSpace: 'pre' as const,
    lineHeight: 1.35,
  },
  snippetPermalink: {
    fontSize: '10.5px',
    color: '#2563eb',
    textDecoration: 'none',
  },
  repoDesc: {
    fontSize: '12px',
    opacity: 0.75,
    lineHeight: 1.4,
  },
  repoMeta: {
    fontSize: '10px',
    opacity: 0.55,
  },
  notice: {
    fontSize: '11px',
    padding: '6px 10px',
    background: 'rgba(34, 197, 94, 0.1)',
    color: 'rgb(22, 101, 52)',
    borderRadius: '6px',
  },
  errorBanner: {
    fontSize: '12px',
    padding: '8px 10px',
    background: 'rgba(239, 68, 68, 0.12)',
    color: 'rgb(153, 27, 27)',
    borderRadius: '6px',
  },
  footer: {
    marginTop: 'auto',
    paddingTop: '8px',
    borderTop: '1px solid rgba(127, 127, 127, 0.12)',
    textAlign: 'center' as const,
  },
} as const;
