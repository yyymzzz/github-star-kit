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
  formatRelativeTime,
  formatSyncSummary,
  generateDigest,
  GithubError,
  indexRepoCode,
  starNeedsTranslation,
  summarizeDigestEntries,
  syncStarsWithStore,
  tagStars,
  translateStars,
  type DigestResult,
  type StarredRepo,
  type SyncCursor,
} from '@starkit/core';
// Direct OpenAICompatibleProvider import — popup picks at runtime which
// concrete API host (SiliconFlow / DashScope / OpenAI) to talk to via the
// AI_PRESETS table. Avoiding the createProvider factory still saves the
// Anthropic / Voyage / Ollama branches (~6KB) from the bundle. R10 蓝军
// fix #1 stays in effect — we just expanded the "compatible" surface to
// the China-region presets the GFW reality demands.
import { OpenAICompatibleProvider } from '@starkit/ai';
import { MemoryVectorStore, type VectorSearchResult } from '@starkit/vector';
import { localizeError } from '../shared/error-i18n.js';
import { releaseSyncLock, tryAcquireSyncLock } from '../shared/lock.js';
import {
  AI_PRESETS,
  AI_PRESET_ORDER,
  DEFAULT_AI_PRESET,
  type AiPresetId,
} from '../shared/ai-presets.js';
import {
  LOCALE_LABELS,
  LOCALE_ORDER,
  useI18n,
  type LocaleId,
} from '../shared/i18n.js';
import { KV_KEY_AI_KEY, KV_KEY_AI_PROVIDER, KV_KEY_PAT, getStores } from './db.js';

/** Identifier the popup uses when grabbing the cross-context sync lock. */
const POPUP_OWNER_ID = 'popup-manual';

/**
 * Build an OpenAI-compatible provider from the selected preset + the user's
 * API key. Centralized so every embed / chat / search / digest / deep-index
 * codepath gets identical config (baseUrl + chatModel + embedModel) without
 * each one having to re-read AI_PRESETS independently.
 *
 * Returns the configured provider; throws AIError immediately if the key is
 * empty or the preset's baseUrl somehow fails `isSafeBaseUrl` — though every
 * shipped preset is https, that guard exists for the v0.2 "Custom baseUrl"
 * input we'll add later.
 */
function buildProvider(presetId: AiPresetId, apiKey: string): OpenAICompatibleProvider {
  const p = AI_PRESETS[presetId];
  return new OpenAICompatibleProvider({
    provider: 'openai-compatible',
    apiKey,
    baseUrl: p.baseUrl,
    chatModel: p.chatModel,
    embedModel: p.embedModel,
  });
}

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
  const { t, locale } = useI18n();
  // null = loading from IDB; string = persisted value; '' = user clearing
  const [pat, setPat] = useState<string | null>(null);
  const [patDraft, setPatDraft] = useState<string>('');
  const [aiKey, setAiKey] = useState<string | null>(null);
  const [aiKeyDraft, setAiKeyDraft] = useState<string>('');
  /** Currently-selected AI provider preset. null = still loading from IDB;
   *  defaults to DEFAULT_AI_PRESET if KV had nothing stored. */
  const [aiProvider, setAiProvider] = useState<AiPresetId | null>(null);
  /** Dropdown selection while user is still on the setup form. Once they
   *  click Save the key, this gets persisted into `aiProvider` + KV. */
  const [aiProviderDraft, setAiProviderDraft] = useState<AiPresetId>(DEFAULT_AI_PRESET);

  const [stars, setStars] = useState<ReadonlyArray<StarredRepo>>([]);
  const [knownCount, setKnownCount] = useState<number>(0);
  const [indexedCount, setIndexedCount] = useState<number>(0);
  const [untaggedCount, setUntaggedCount] = useState<number>(0);
  /** Stars whose description is non-empty AND lacks a translation for
   *  the currently-active UI locale. Computed lazily — derived from
   *  allStars + locale on demand, not stored in state, because re-keying
   *  state every locale switch is fragile. See `untranslatedCount` useMemo. */
  const [allStarsForTrCount, setAllStarsForTrCount] = useState<
    ReadonlyArray<StarredRepo>
  >([]);
  const [cursor, setCursor] = useState<SyncCursor | null>(null);

  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [embedState, setEmbedState] = useState<EmbedState>('idle');
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [tagState, setTagState] = useState<TagState>('idle');
  const [translateState, setTranslateState] = useState<'idle' | 'translating'>('idle');
  const [translateProgress, setTranslateProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [deepIndexState, setDeepIndexState] = useState<DeepIndexState>('idle');
  const [deepIndexProgress, setDeepIndexProgress] = useState<{
    repo: string;
    done: number;
    total: number;
  } | null>(null);
  const [deepIndexedCount, setDeepIndexedCount] = useState<number>(0);

  const [error, setError] = useState<string | null>(null);
  /**
   * Epoch-ms when the rate-limit cooldown clears. Set when a GithubError
   * with kind=rate_limit lands; the Sync button stays disabled until
   * `Date.now() >= rateLimitResetAt`. R10 蓝军 fix #8 — without this the
   * user could click Sync repeatedly during the cap window and get the
   * same red banner without understanding why.
   */
  const [rateLimitResetAt, setRateLimitResetAt] = useState<number | null>(null);
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
  // R39 audit MINOR close: filter search results by hit kind. Ephemeral
  // state (not KV-persisted) — resets between popup opens since most
  // sessions are short and the default ('all') is rarely wrong.
  const [searchFilter, setSearchFilter] = useState<'all' | 'star' | 'code'>(
    'all'
  );
  // R40 audit MAJOR close: user-driven AbortController. ONE shared
  // controller per active long-running op (translate / autotag /
  // deep-index). The 3 ops are mutually exclusive in the UI (buttons
  // disable each other), so sharing the state is safe. Cancel button
  // renders when activeAbort !== null. AbortError thrown by
  // orchestrators is caught + treated as user cancel (subtle notice,
  // not error banner) via the catch branch in each handler.
  const [activeAbort, setActiveAbort] = useState<AbortController | null>(
    null
  );
  const [digest, setDigest] = useState<DigestResult | null>(null);

  // The popup-lifetime hot index. Pre-filled from IDB at mount; mutated by
  // every embed pass (dual-upsert) so it stays in sync without re-loading.
  const memVecRef = useRef<MemoryVectorStore | null>(null);
  // R37 蓝军 borrow from favbox: CmdK / Ctrl+K focuses the search bar.
  // Saved in a ref because the input only renders when `canSearch` is
  // true; we want the hotkey listener attached at mount regardless and
  // gracefully no-op when the input isn't currently in the DOM.
  // RefObject<HTMLInputElement> (no `| null` in generic) matches
  // React's `input ref` prop type.
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Generation counter for digest invocations. Incremented at the start
  // of every onShowDigest; the async summary block writes back only when
  // its captured generation still matches. Prevents a slow ~3s
  // summarizeDigestEntries from clobbering newer state if the user
  // re-triggered, cleared, or reset between the trigger and the write.
  // R10 蓝军 fix #9.
  const digestGenRef = useRef<number>(0);

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stores = await getStores();
        const [storedPat, storedKey, storedProvider, top, cnt, cur, vecRows] =
          await Promise.all([
            stores.kvStore.get<string>(KV_KEY_PAT),
            stores.kvStore.get<string>(KV_KEY_AI_KEY),
            stores.kvStore.get<string>(KV_KEY_AI_PROVIDER),
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

        // Validate persisted provider id against the known preset list — a
        // user who downgrades / upgrades from a future v0.2 with extra
        // presets should fall back cleanly rather than crash on lookup.
        const validProvider: AiPresetId =
          storedProvider && storedProvider in AI_PRESETS
            ? (storedProvider as AiPresetId)
            : DEFAULT_AI_PRESET;
        setAiProvider(validProvider);
        setAiProviderDraft(validProvider);

        setPat(storedPat ?? '');
        setAiKey(storedKey ?? '');
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
        setAllStarsForTrCount(all);
        setDeepIndexedCount(all.filter((s) => s.deepIndexed).length);
      } catch (err) {
        if (!cancelled) setError(localizeError(err, t));
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
      setError(localizeError(err, t));
    }
  }, [patDraft]);

  const onSaveAiKey = useCallback(async () => {
    const trimmed = aiKeyDraft.trim();
    if (!trimmed) return;
    try {
      const { kvStore, vectorStore, starStore } = await getStores();
      const newPreset = AI_PRESETS[aiProviderDraft];

      // R48 蓝军 P0 (audit agent #3): China-region presets (siliconflow /
      // dashscope) are NOT in static host_permissions — only in
      // optional_host_permissions per manifest. Auto-request the origin so
      // first-time China users don't hit a silent CORS-style fetch failure
      // on their first Sync/Translate. Same call is a no-op if the user
      // already granted it. `chrome.permissions.request` requires a user
      // gesture; Save-AI-Key is exactly that.
      try {
        const origin = `${new URL(newPreset.baseUrl).origin}/*`;
        await chrome.permissions.request({ origins: [origin] });
      } catch (permErr) {
        // Non-fatal — the user can still grant later if the fetch fails;
        // we don't want to block key save if Chrome's permission API
        // misbehaves (e.g. in test environments).
        console.warn('[starkit] host permission request failed:', permErr);
      }

      // R48 蓝军 P0 (audit agent #3): provider switch → dim mismatch. If
      // user previously indexed with provider A (e.g. SiliconFlow bge-m3
      // 1024-d) and now switches to provider B (e.g. OpenAI text-
      // embedding-3-small 1536-d), the next search throws
      // "Vector dim mismatch" from packages/vector/src/memory.ts:125 and
      // the entire search returns nothing. Worse: even when dims match
      // (DashScope text-embedding-v3 1024 vs bge-m3 1024) the semantic
      // embeddings are incomparable — recall drops to noise.
      //
      // Fix: when the embedModel name changes vs the previously-saved
      // provider, wipe the vector store + reset deepIndexed flags so a
      // fresh "Build index" run repopulates with the new model's vectors.
      // We preserve aiTags / userNote / descriptionI18n (locale-data, not
      // vector-data) by only rewriting deepIndexed flags, not full rows.
      const previousPreset =
        aiProvider !== null && aiProvider in AI_PRESETS ? AI_PRESETS[aiProvider] : null;
      const modelChanged =
        previousPreset !== null && previousPreset.embedModel !== newPreset.embedModel;

      if (modelChanged) {
        // Clear ALL vectors (stars + code chunks both keyed off embedModel)
        await vectorStore.clear();
        memVecRef.current = new MemoryVectorStore();
        // Reset deepIndexed flag on every star so the manage page re-shows
        // the Deep Index button. Stars keep aiTags + userNote + i18n.
        const refreshed = await starStore.list();
        const toReset = refreshed
          .filter((s) => s.deepIndexed)
          .map((s) => ({ ...s, deepIndexed: false, lastDeepIndexedAt: null }));
        if (toReset.length > 0) {
          await starStore.upsertMany(toReset);
        }
        setIndexedCount(0);
        setDeepIndexedCount(0);
        // Wipe digest too — it was computed against the old model's centroid.
        digestGenRef.current += 1;
        setDigest(null);
      }

      // Persist BOTH the key and the chosen preset atomically so the next
      // popup mount reads a consistent pair. If the user later switches
      // providers, they re-enter the new key + Save again.
      await Promise.all([
        kvStore.set(KV_KEY_AI_KEY, trimmed),
        kvStore.set(KV_KEY_AI_PROVIDER, aiProviderDraft),
      ]);
      setAiKey(trimmed);
      setAiProvider(aiProviderDraft);
      setAiKeyDraft('');
      setError(null);
    } catch (err) {
      setError(localizeError(err, t));
    }
  }, [aiKeyDraft, aiProviderDraft, aiProvider, t]);

  const onClearAll = useCallback(async () => {
    try {
      const { kvStore, starStore, cursorStore, vectorStore } = await getStores();
      await Promise.all([
        kvStore.delete(KV_KEY_PAT),
        kvStore.delete(KV_KEY_AI_KEY),
        kvStore.delete(KV_KEY_AI_PROVIDER),
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
      setAiKey('');
      setAiProvider(DEFAULT_AI_PRESET);
      setAiProviderDraft(DEFAULT_AI_PRESET);
      setStars([]);
      setKnownCount(0);
      setIndexedCount(0);
      setUntaggedCount(0);
      setAllStarsForTrCount([]);
      setDeepIndexedCount(0);
      setCursor(null);
      setLastSyncSummary(null);
      setSearchResults([]);
      setQuery('');
      // Bump digest generation so any in-flight summarize from before
      // the reset can't write back stale state. R10 蓝军 fix #9.
      digestGenRef.current += 1;
      setDigest(null);
      setError(null);
    } catch (err) {
      setError(localizeError(err, t));
    }
  }, []);

  // ─── Sync handler ─────────────────────────────────────────────────────
  const onSync = useCallback(async () => {
    if (!pat) return;
    setSyncState('syncing');
    setError(null);

    const lockAcquired = await tryAcquireSyncLock(POPUP_OWNER_ID);
    if (!lockAcquired) {
      setError(t('sync.conflict'));
      setSyncState('idle');
      return;
    }

    try {
      const { starStore, cursorStore, vectorStore } = await getStores();
      const client = createGithubClient({
        token: pat,
        userAgent: '@starkit/extension',
      });
      const result = await syncStarsWithStore(
        client,
        { starStore, cursorStore },
        {
          // R33 蓝军 CRITICAL #1.2 fix: when sync detects un-stars, also
          // remove the corresponding vector rows. v1 left orphans
          // (star:N + code:N:path:idx) — they bloated IDB and the
          // indexedCount gauge lied. The rehydrate path at App.tsx:936
          // already filtered hits with null star so search results
          // weren't visibly wrong; this fix prevents the leak at root.
          onUnstar: async (deletedIds: ReadonlyArray<number>) => {
            // R51 P2 fix: replaced the prior O(N+M) list+regex scan with
            // store-native prefix delete. For 5k stars × ~3 code chunks,
            // the old path materialized 15k+ rows into JS heap and ran a
            // regex per row on popup focus after un-starring — visibly
            // janky. IndexedDBVectorStore.deleteByPrefix uses an IDB
            // key-range cursor → O(matched) instead of O(N).
            for (const id of deletedIds) {
              await vectorStore.delete(`star:${id}`);
              await vectorStore.deleteByPrefix(`code:${id}:`);
            }
          },
        }
      );
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
      setAllStarsForTrCount(all);
      // R9 蓝军 fix C1: clear stale digest after sync — its ranks are now
      // computed against pre-sync data and could mislead the user.
      digestGenRef.current += 1;
      setDigest(null);
      // Successful sync clears any prior rate-limit cooldown.
      setRateLimitResetAt(null);
    } catch (err) {
      setError(localizeError(err, t));
      // R10 蓝军 fix #8: structured rate-limit handling. If GitHub returned
      // a 403/429 with a Retry-After / x-ratelimit-reset, persist the
      // deadline so the button stays disabled + the user sees a countdown
      // instead of a generic "rate limit" message and no recovery hint.
      if (err instanceof GithubError && err.kind === 'rate_limit') {
        const sec = err.context.rateLimitResetSeconds;
        if (typeof sec === 'number' && sec > 0) {
          setRateLimitResetAt(Date.now() + sec * 1000);
        }
      }
    } finally {
      await releaseSyncLock(POPUP_OWNER_ID);
      setSyncState('idle');
    }
  }, [pat]);

  // ─── Embed: build search index ────────────────────────────────────────
  const onBuildIndex = useCallback(async () => {
    if (!aiKey || !aiProvider || embedState === 'embedding') return;
    setEmbedState('embedding');
    setIndexProgress({ done: 0, total: knownCount });
    setError(null);
    // R45: cancel for build-search-index (~30s-5min depending on
    // provider + library size).
    const abortCtrl = new AbortController();
    setActiveAbort(abortCtrl);

    try {
      const { starStore, vectorStore } = await getStores();
      const provider = buildProvider(aiProvider, aiKey);
      const memVec = memVecRef.current ?? new MemoryVectorStore();
      memVecRef.current = memVec;

      const embedResult = await embedStars({
        starStore,
        signal: abortCtrl.signal,
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

      // R20 蓝军 fix: surface partial failures. v1 discarded the result, so
      // a run where every batch failed (auth/network) silently looked like
      // success — user clicks search and gets "0 results". Now we show the
      // provider's actual message inline so the user knows what to fix.
      if (embedResult.failed > 0) {
        const reason = embedResult.lastErrorMessage
          ? `: ${embedResult.lastErrorMessage}`
          : '';
        setError(
          t('index.partialFailure', {
            failed: embedResult.failed,
            embedded: embedResult.embedded,
            skipped: embedResult.skipped,
            reason,
          })
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(t('common.cancelled'));
      } else {
        setError(localizeError(err, t));
      }
    } finally {
      setEmbedState('idle');
      setActiveAbort(null);
    }
  }, [aiKey, aiProvider, embedState, knownCount]);

  // ─── Translate: render repo descriptions in the user's UI locale ─────
  //
  // Stars whose description is non-empty AND lacks a cached translation
  // for the currently-active locale. en is treated as "no translation
  // needed" — we assume GitHub descriptions are English-default; if the
  // user's UI locale IS English, the original is what they want anyway.
  // Recomputes when locale changes (drives the button label + visibility).
  // R50 root-cause fix (5th iteration): delegate to the SINGLE source of
  // truth `starNeedsTranslation` so this counter, the orchestrator skip-loop,
  // and the UI render's `displayTags` fallback all agree. The old hand-rolled
  // "missing-cache only" check counted stars whose aiTags were ALREADY in
  // the user's locale (Chinese aiTags generated by zh model) as untranslated
  // → user saw Chinese tags but count stuck at 9 → click button → LLM
  // translated Chinese→Chinese noisily → count never moved. The shared
  // helper detects "already in target locale" via Unicode script ranges
  // (CJK / Cyrillic / Hangul / Hiragana / Katakana / Vietnamese diacritics)
  // and excludes those from the count. The orchestrator simultaneously
  // backfills their cache for free (no LLM call) so subsequent renders are
  // consistent.
  const untranslatedCount = useMemo(() => {
    if (locale === 'en') return 0;
    let n = 0;
    for (const s of allStarsForTrCount) {
      if (starNeedsTranslation(s, locale)) n += 1;
    }
    return n;
  }, [allStarsForTrCount, locale]);

  const onTranslate = useCallback(async () => {
    if (!aiKey || !aiProvider || translateState === 'translating') return;
    if (locale === 'en') {
      // Defensive guard — the button shouldn't even render in this case.
      setError(t('translate.englishGuard'));
      return;
    }
    setTranslateState('translating');
    setTranslateProgress({ done: 0, total: untranslatedCount });
    setError(null);
    // R40: user can cancel mid-batch. Translate runs for minutes on
    // large libraries — without cancel, the user has to wait or
    // forcibly close popup (which doesn't actually kill in-flight
    // fetches inside the orchestrator's worker pool).
    const abortCtrl = new AbortController();
    setActiveAbort(abortCtrl);

    try {
      const { starStore } = await getStores();
      const provider = buildProvider(aiProvider, aiKey);

      const translateResult = await translateStars({
        starStore,
        signal: abortCtrl.signal,
        chat: (system, user, signal) =>
          provider
            .chat({
              system,
              user,
              // R20 蓝军 #1 (subagent B): without an explicit maxTokens,
              // SiliconFlow / some OpenAI-compatible proxies default to
              // ≤512 tokens. A 200-char English description translated
              // into compound-heavy German/Russian can blow past 512 →
              // response truncated mid-sentence → parseTranslateResponse
              // accepts the half-string as valid → user sees "翻译不到位".
              // 1024 covers description-only (~700 max observed). The
              // tags translation also flows through this adapter; tags
              // are tiny (~50 tokens), so 1024 is generous overhead.
              maxTokens: 1024,
              ...(signal ? { signal } : {}),
            })
            .then((r) => ({
              text: r.text,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              model: r.model,
            })),
        // R17 蓝军 fix B: route description vs tags translation to the
        // right schema bag. v1 only had description here; the `field`
        // discriminator lets one updateStar callback serve both calls
        // the orchestrator now makes per-star (description + tags when
        // alsoTags=true, which is the new default).
        updateStar: async (id, localeCode, translatedText, field) => {
          const existing = await starStore.get(id);
          if (!existing) return;
          if (field === 'description') {
            const nextI18n = {
              ...existing.descriptionI18n,
              [localeCode]: translatedText,
            };
            await starStore.upsertMany([
              {
                ...existing,
                descriptionI18n: nextI18n,
                lastTranslatedAt: new Date().toISOString(),
              },
            ]);
          } else {
            // field === 'tags'
            const nextTagsI18n = {
              ...existing.aiTagsI18n,
              [localeCode]: translatedText,
            };
            await starStore.upsertMany([
              {
                ...existing,
                aiTagsI18n: nextTagsI18n,
                lastTranslatedAt: new Date().toISOString(),
              },
            ]);
          }
        },
        targetLocale: locale,
        alsoTags: true,
        onProgress: (done, total) => setTranslateProgress({ done, total }),
      });

      // R17 蓝军 fix A3 + R20 蓝军 MAJOR #1: surface failed count + repo
      // names so user can see what didn't translate. R20 adds the actual
      // provider error message (rate_limit / network / parse / auth) so
      // the user knows whether to "wait and retry" vs "fix your key".
      //
      // R49 root cause: the `failed > 0` gate alone was silent when desc-
      // already-cached stars hit tag-chat failures (failed=0, tagsFailed=N).
      // User clicked Translate → button vanished → tag calls all errored →
      // setError never fired → button reappeared → count unchanged → the
      // "闪烁后毫无反应" symptom. Now OR-gate on tagsFailed and aggregate
      // the count so the partialFailure toast reflects total user-visible
      // failures (desc + tags). failedStarIds still tracks desc-only by
      // design (popup retry CTA focuses on desc); tag-only failures fall
      // back to a count-only message which is acceptable for the partial-
      // failure toast.
      const totalFailed = translateResult.failed + translateResult.tagsFailed;
      if (totalFailed > 0) {
        const failedNames = translateResult.failedStarIds
          .slice(0, 3)
          .map((id) => allStarsForTrCount.find((s) => s.id === id)?.fullName)
          .filter((n): n is string => typeof n === 'string')
          .join(', ');
        const more =
          translateResult.failedStarIds.length > 3
            ? ` +${translateResult.failedStarIds.length - 3}…`
            : '';
        const reason = translateResult.lastErrorMessage
          ? `: ${translateResult.lastErrorMessage}`
          : '';
        setError(
          t('translate.partialFailure', {
            failed: totalFailed,
            names: failedNames,
            more,
            reason,
          })
        );
      }

      // Refresh: top-10 list + the bulk array that feeds untranslatedCount.
      const [top, all] = await Promise.all([
        starStore.list({ limit: 10 }),
        starStore.list(),
      ]);
      setStars(top);
      setAllStarsForTrCount(all);
      setTranslateProgress(null);
    } catch (err) {
      // R40: AbortError is user-cancel → subtle notice, not red banner.
      // Any other Error → existing localized banner path.
      if (err instanceof Error && err.name === 'AbortError') {
        setError(t('common.cancelled'));
      } else {
        setError(localizeError(err, t));
      }
    } finally {
      setTranslateState('idle');
      setActiveAbort(null);
    }
  }, [aiKey, aiProvider, locale, translateState, untranslatedCount, allStarsForTrCount]);

  // ─── Auto-tag: LLM-generated tags per repo ────────────────────────────
  const onAutoTag = useCallback(async () => {
    if (!aiKey || !aiProvider || tagState === 'tagging') return;
    setTagState('tagging');
    setTagProgress({ done: 0, total: untaggedCount });
    setError(null);
    // R40: user cancel for long autotag runs.
    const abortCtrl = new AbortController();
    setActiveAbort(abortCtrl);

    try {
      const { starStore } = await getStores();
      const provider = buildProvider(aiProvider, aiKey);

      const tagResult = await tagStars({
        starStore,
        signal: abortCtrl.signal,
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
      setAllStarsForTrCount(all);
      setTagProgress(null);

      // R20 蓝军 fix: surface partial failures (provider error / empty parse).
      // v1 discarded the result so "0 tagged, all failed" looked like success.
      if (tagResult.failed > 0) {
        const reason = tagResult.lastErrorMessage
          ? `: ${tagResult.lastErrorMessage}`
          : '';
        setError(
          t('tag.partialFailure', {
            failed: tagResult.failed,
            tagged: tagResult.tagged,
            reason,
          })
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(t('common.cancelled'));
      } else {
        setError(localizeError(err, t));
      }
    } finally {
      setTagState('idle');
      setActiveAbort(null);
    }
  }, [aiKey, aiProvider, tagState, untaggedCount]);

  // ─── Deep-index: fetch source for top-N starred + embed code chunks ────
  const onDeepIndex = useCallback(async () => {
    if (!pat || !aiKey || !aiProvider || deepIndexState === 'indexing') return;
    setDeepIndexState('indexing');
    setError(null);
    // R40: cancel for deep-index loop. The for-loop in this handler
    // does N indexRepoCode calls; each accepts signal. AbortError
    // bubbles up to the catch below which treats it as user cancel.
    const abortCtrl = new AbortController();
    setActiveAbort(abortCtrl);

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
        setError(t('deepIndex.noNewRepos', { n: DEEP_INDEX_TOP_N }));
        return;
      }

      const githubClient = createGithubClient({
        token: pat,
        userAgent: '@starkit/extension(deep-index)',
      });
      const provider = buildProvider(aiProvider, aiKey);
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

        // R20 蓝军 fix: capture indexRepoCode's result so we can detect
        // and surface partial / total failures. The v1 code did
        // `await indexRepoCode({...})` with NO destructure — silent fails
        // (AIError swallowed inside) returned `{indexed: 0}` and the next
        // line marked the repo deepIndexed=true regardless, POISONING the
        // candidate filter so subsequent re-clicks skipped the dead repo.
        const result = await indexRepoCode({
          starStore,
          repoId: star.id,
          signal: abortCtrl.signal,
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

        // R20 蓝军 fix: only mark deepIndexed=true when the pass actually
        // landed chunks. A 0-indexed repo means the embed pipeline failed
        // (auth / rate-limit / network / empty fetch); marking it "done"
        // would permanently hide the repo from future Deep-index clicks.
        if (result.indexed > 0) {
          // R21 蓝军 round-2 (subagent A defense-in-depth): re-read the
          // star from starStore before the spread. The `star` in this
          // loop's local var is from `candidates` (frozen at click time);
          // if cron sync OR a concurrent manage-page translate ran during
          // the indexRepoCode call (typically 30-90s per repo), the
          // captured `star` would be stale and wipe fresh descriptionI18n.
          // Same data-loss class as R21 P0 sync-wipes-i18n.
          const fresh = await starStore.get(star.id);
          if (fresh) {
            // R36: stamp lastDeepIndexedAt so sync can invalidate on
            // future pushedAt change (auto-reset deepIndexed=false).
            await starStore.upsertMany([
              {
                ...fresh,
                deepIndexed: true,
                lastDeepIndexedAt: new Date().toISOString(),
              },
            ]);
          }
          // else: user un-starred during the run; don't synthesize.
        } else if (result.failed > 0 || result.chunks > 0) {
          // chunks > 0 but indexed === 0 = every batch failed.
          // chunks === 0 + failed === 0 = empty fetch / all-skipped files
          // (e.g. monorepo where src/ lives under a deep path that
          // pathPreferenceScore drops). Both are user-actionable; surface.
          const reason = result.lastErrorMessage
            ? `: ${result.lastErrorMessage}`
            : result.chunks === 0
              ? ': no source files matched the language whitelist'
              : '';
          throw new Error(
            t('deepIndex.zeroChunks', {
              fullName: star.fullName,
              failed: result.failed,
              chunks: result.chunks,
              reason,
            })
          );
        }
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
      if (err instanceof Error && err.name === 'AbortError') {
        setError(t('common.cancelled'));
      } else {
        setError(localizeError(err, t));
      }
    } finally {
      setDeepIndexState('idle');
      setActiveAbort(null);
    }
  }, [pat, aiKey, aiProvider, deepIndexState]);

  // ─── Weekly Digest: rank recently-pushed by relevance to user profile ──
  const onShowDigest = useCallback(async () => {
    if (indexedCount === 0) {
      setError(t('search.buildFirst'));
      return;
    }
    setError(null);
    // Take a new generation token. Any prior in-flight summarize that's
    // still running at write-time will see its captured generation no
    // longer match and abort its setDigest write.
    digestGenRef.current += 1;
    const myGen = digestGenRef.current;
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
      // First write: ranking only. If a later invocation already bumped
      // the generation, this is a stale call — bail without touching state.
      if (digestGenRef.current !== myGen) return;
      setDigest(result);
      setQuery(''); // Search query takes precedence; clear it so digest shows.
      setSearchResults([]);

      // W4 V1: layer the LLM "why this matters" hook on top of the ranking.
      // Async (popup shows the ranked list immediately; summaries fill in
      // as they return). Bounded concurrency = 3 so 10 entries finish in
      // ~3s on a typical OpenAI roundtrip. Errors are per-entry — the
      // ranking still ships even if every summary fails.
      if (aiKey && aiProvider && result.entries.length > 0) {
        const provider = buildProvider(aiProvider, aiKey);
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
            {
              concurrency: 3,
              // R4 v0.3 fix: pass current UI locale so digest hooks
              // generate directly in user's language. Chinese-UI users
              // no longer see English "why this matters" alongside
              // translated descriptions — full content parity.
              targetLocale: locale,
            }
          );
          // Second write: summaries layered on. Same generation gate —
          // a new onShowDigest / onClearAll / re-embed in the ~3s window
          // bumped the generation, so the summary write is now stale.
          if (digestGenRef.current !== myGen) return;
          setDigest({ ...result, entries: withSummaries });
        } catch (sumErr) {
          // Summary layer is best-effort. Log + leave ranked list as-is.
          console.warn('[starkit] digest summaries failed:', sumErr);
        }
      }
    } catch (err) {
      setError(localizeError(err, t));
    }
  }, [indexedCount, aiKey, aiProvider]);

  const onCloseDigest = useCallback(() => {
    // Bump generation too — a pending summarize() from a re-open during
    // close-then-reopen cycle should never write back over the new view.
    digestGenRef.current += 1;
    setDigest(null);
  }, []);

  // ─── Search ───────────────────────────────────────────────────────────
  const onSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || !aiKey || !aiProvider) {
      setSearchResults([]);
      return;
    }
    if (!memVecRef.current || indexedCount === 0) {
      setError(t('search.buildFirst'));
      return;
    }
    setSearchState('searching');
    setError(null);

    try {
      const provider = buildProvider(aiProvider, aiKey);
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
      setError(localizeError(err, t));
      setSearchResults([]);
    } finally {
      setSearchState('idle');
    }
  }, [query, aiKey, aiProvider, indexedCount]);

  // Clear search results when query is wiped
  useEffect(() => {
    if (query.trim() === '') setSearchResults([]);
  }, [query]);

  // R37 favbox-inspired hotkey: Cmd+K (macOS) / Ctrl+K (others) focuses
  // the search bar. Safe to preventDefault inside a Chrome extension
  // popup — the popup is its own window context, not the browser
  // chrome, so we're not stealing the address-bar hotkey users rely
  // on outside. Also handles '/' as a secondary trigger (GitHub-style)
  // but only when no input is already focused, to avoid intercepting
  // typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'k' || e.key === 'K');
      const target = e.target as HTMLElement | null;
      const isTyping =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      const slashAlone = e.key === '/' && !cmdK && !isTyping;
      if (cmdK || slashAlone) {
        const input = searchInputRef.current;
        if (input !== null) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─── Derived view state ───────────────────────────────────────────────
  const indexCoverage = useMemo(() => {
    if (knownCount === 0) return null;
    return Math.round((indexedCount / knownCount) * 100);
  }, [indexedCount, knownCount]);

  const needsRebuild = knownCount > 0 && indexedCount < knownCount;
  const canSearch = indexedCount > 0 && aiKey !== null && aiKey !== '';
  const showSearchResults = query.trim() !== '' && searchResults.length > 0;
  // Re-derived on every render so countdown stays accurate without a
  // setInterval (popup is a short-lived view; re-renders happen often
  // enough on user input that ~minute precision is fine).
  const rateLimitedFor =
    rateLimitResetAt !== null
      ? Math.max(0, Math.ceil((rateLimitResetAt - Date.now()) / 1000))
      : 0;
  const rateLimited = rateLimitedFor > 0;

  // ─── Render ───────────────────────────────────────────────────────────

  if (pat === null || aiKey === null || aiProvider === null) {
    return (
      <main style={styles.shell}>
        <Header subtitle={t('common.loading')} />
      </main>
    );
  }

  if (pat === '') {
    return (
      <main style={styles.shell}>
        <Header subtitle={t('settings.pat.promptSubtitle')} />
        <SettingsCard
          label={t('settings.pat.label')}
          help={t('settings.pat.help')}
          placeholder={t('settings.pat.placeholder')}
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
            ? `${t('stars.summary', { n: knownCount, indexed: indexedCount })} · ${t('header.lastSynced')} ${formatRelativeTime(
                cursor.updatedAt
              )}`
            : `${t('stars.summary', { n: knownCount, indexed: indexedCount })} · ${t('common.neverSynced')}`
        }
        rightAction={
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={syncState === 'syncing' || rateLimited}
            title={
              rateLimited
                ? t('sync.waitMin', { n: Math.ceil(rateLimitedFor / 60) })
                : undefined
            }
            style={styles.smallButton}
          >
            {syncState === 'syncing'
              ? t('sync.syncing')
              : rateLimited
                ? t('sync.waitMin', { n: Math.ceil(rateLimitedFor / 60) })
                : t('sync.button')}
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
            ref={searchInputRef}
            type="search"
            placeholder={
              deepIndexedCount > 0
                ? t('search.codeHintPlaceholder')
                : t('search.placeholder')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSearch();
            }}
            style={styles.searchInput}
            aria-keyshortcuts="Control+K Meta+K"
          />
          <button
            type="button"
            onClick={() => void onSearch()}
            disabled={searchState === 'searching' || query.trim() === ''}
            style={styles.smallButton}
          >
            {searchState === 'searching' ? '…' : t('search.go')}
          </button>
        </div>
      )}

      {/* AI provider setup — only when key is missing. v1 ships 3 OpenAI-
          compatible presets covering both China-region (SiliconFlow + Qwen)
          and global (OpenAI). Custom baseUrl deferred to v0.2.
          Always rendered with the LanguagePicker so user can switch UI
          language even before any AI key is configured. */}
      {aiKey === '' && (
        <AiProviderCard
          providerDraft={aiProviderDraft}
          onProviderChange={setAiProviderDraft}
          keyDraft={aiKeyDraft}
          onKeyChange={setAiKeyDraft}
          onSave={() => void onSaveAiKey()}
        />
      )}
      {/* Language picker — always available as a standalone control so
          a user who already saved their AI key can still switch UI lang. */}
      {aiKey !== '' && <LanguageQuickPicker />}

      {/* Build index button — gated on having OpenAI key + stars to index */}
      {aiKey !== '' && needsRebuild && embedState === 'idle' && (
        <button
          type="button"
          onClick={() => void onBuildIndex()}
          disabled={knownCount === 0}
          style={styles.primaryButton}
        >
          {indexedCount === 0
            ? t('index.buildButton', { n: knownCount })
            : t('index.updateButton', { n: knownCount - indexedCount })}
        </button>
      )}

      {embedState === 'embedding' && indexProgress && (
        <div style={styles.noticeWithCancel}>
          <span>
            {t('index.embeddingProgress', {
              done: indexProgress.done,
              total: indexProgress.total,
            })}
            {indexCoverage !== null
              ? ' · ' + t('index.percentIndexed', { pct: indexCoverage })
              : ''}
            …
          </span>
          {/* R45: Cancel for embed run */}
          {activeAbort && (
            <button
              type="button"
              onClick={() => activeAbort.abort()}
              style={styles.cancelLinkButton}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {/* Auto-tag + Weekly Digest action row */}
      {/* Translate progress notice — shown even when the button row is
       *  collapsed, so the in-flight pass stays visible. */}
      {translateState === 'translating' && translateProgress && (
        <div style={styles.noticeWithCancel}>
          <span>
            🌐{' '}
            {t('translate.translating', {
              done: translateProgress.done,
              total: translateProgress.total,
            })}
          </span>
          {/* R40 Cancel button — minimal text-only link to keep the
           *  progress notice compact. Disabled briefly post-click
           *  so the user can't double-abort while the controller's
           *  abort() ripples through workers. */}
          {activeAbort && (
            <button
              type="button"
              onClick={() => activeAbort.abort()}
              style={styles.cancelLinkButton}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {aiKey !== '' && (untaggedCount > 0 || indexedCount > 0 || untranslatedCount > 0) && (
        <div style={styles.searchRow}>
          {untaggedCount > 0 && tagState === 'idle' && (
            <button
              type="button"
              onClick={() => void onAutoTag()}
              style={{ ...styles.secondaryButton, flex: 1 }}
            >
              {untaggedCount === 1
                ? t('tag.autoTagButtonOne', { n: untaggedCount })
                : t('tag.autoTagButton', { n: untaggedCount })}
            </button>
          )}
          {untranslatedCount > 0 && translateState === 'idle' && locale !== 'en' && (
            <button
              type="button"
              onClick={() => void onTranslate()}
              style={{ ...styles.secondaryButton, flex: 1 }}
              title={t('translate.title', { n: untranslatedCount, locale })}
            >
              {t('translate.button', { n: untranslatedCount })}
            </button>
          )}
          {indexedCount > 0 && !digest && (
            <button
              type="button"
              onClick={() => void onShowDigest()}
              style={{ ...styles.secondaryButton, flex: 1 }}
            >
              {t('digest.button')}
            </button>
          )}
          {knownCount > 0 && deepIndexState === 'idle' && (
            <button
              type="button"
              onClick={() => void onDeepIndex()}
              style={{ ...styles.secondaryButton, flex: 1 }}
              title={t('deepIndex.buttonTooltip', { n: DEEP_INDEX_TOP_N })}
            >
              {deepIndexedCount === 0
                ? t('deepIndex.button', { n: DEEP_INDEX_TOP_N })
                : t('deepIndex.buttonMore', { n: DEEP_INDEX_TOP_N })}
            </button>
          )}
        </div>
      )}

      {deepIndexState === 'indexing' && deepIndexProgress && (
        <div style={styles.noticeWithCancel}>
          <span>
            {t('deepIndex.progress', {
              repo: deepIndexProgress.repo,
              done: deepIndexProgress.done + 1,
              total: deepIndexProgress.total,
            })}
          </span>
          {activeAbort && (
            <button
              type="button"
              onClick={() => activeAbort.abort()}
              style={styles.cancelLinkButton}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {tagState === 'tagging' && tagProgress && (
        <div style={styles.noticeWithCancel}>
          <span>
            {t('tag.taggingProgress', {
              done: tagProgress.done,
              total: tagProgress.total,
            })}
          </span>
          {activeAbort && (
            <button
              type="button"
              onClick={() => activeAbort.abort()}
              style={styles.cancelLinkButton}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {/* Results list — render priority:
          1. Search has results: show them
          2. Digest view active: show digest entries
          3. Otherwise: top-10 most-recently-starred */}
      {showSearchResults ? (
        <>
          {/* R39 audit MINOR close: search-kind filter pills. Only
           *  render the Code chip when there ARE code hits (avoids a
           *  dead button when deep-index isn't set up). Filter applied
           *  inline to searchResults at render time — no separate
           *  filtered-state needed since searchResults already small
           *  (top-10 results). */}
          {(() => {
            const starCount = searchResults.filter((h) => h.kind === 'star').length;
            const codeCount = searchResults.filter((h) => h.kind === 'code').length;
            if (starCount === 0 || codeCount === 0) return null; // No filter UI when mixed view is moot
            return (
              <div
                style={styles.searchFilterRow}
                role="group"
                aria-label={t('search.filterTitle')}
              >
                {(
                  [
                    { key: 'all' as const, label: t('search.filterAll', { n: searchResults.length }) },
                    { key: 'star' as const, label: t('search.filterStars', { n: starCount }) },
                    { key: 'code' as const, label: t('search.filterCode', { n: codeCount }) },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSearchFilter(opt.key)}
                    style={
                      searchFilter === opt.key
                        ? styles.searchFilterChipActive
                        : styles.searchFilterChip
                    }
                    aria-pressed={searchFilter === opt.key}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            );
          })()}
          <ol style={styles.list}>
            {searchResults
              .filter((h) => searchFilter === 'all' || h.kind === searchFilter)
              .map((hit, idx) => (
                <li
                  key={
                    hit.kind === 'code'
                      ? `${hit.star.id}:${hit.path}:${hit.startLine}`
                      : `s:${hit.star.id}:${idx}`
                  }
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
        </>
      ) : digest !== null ? (
        <>
          <div style={styles.digestHeader}>
            <span>
              {t('digest.headerSummary', {
                shown: digest.entries.length,
                total: digest.candidateCount,
              })}
              {digest.unembeddedCount > 0
                ? ' ' + t('digest.unrankedSuffix', { n: digest.unembeddedCount })
                : ''}
            </span>
            <button
              type="button"
              onClick={onCloseDigest}
              style={styles.linkButton}
            >
              {t('digest.backToRecent')}
            </button>
          </div>
          {digest.entries.length === 0 ? (
            <section style={styles.card}>
              <strong>{t('digest.noActivity')}</strong>
              <p style={styles.helpText}>{t('digest.noActivityHelp')}</p>
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
          <strong>{t('stars.noStarsCached')}</strong>
          <p style={styles.helpText}>{t('stars.syncPrompt')}</p>
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
        <div style={styles.footerLinks}>
          {knownCount > 0 && (
            <>
              <button
                type="button"
                onClick={() =>
                  void chrome.tabs.create({
                    url: chrome.runtime.getURL('src/manage/index.html'),
                  })
                }
                style={styles.footerLink}
              >
                {t('settings.footer.manageAll', {
                  n: knownCount.toLocaleString(),
                })}
              </button>
              <span style={styles.footerSep}>·</span>
            </>
          )}
          <a
            href="https://github.com/yyymzzz/github-star-kit#readme"
            target="_blank"
            rel="noreferrer"
            style={styles.footerLink}
          >
            {t('settings.footer.readme')}
          </a>
          <span style={styles.footerSep}>·</span>
          <button
            type="button"
            onClick={() => void onClearAll()}
            style={styles.linkButton}
          >
            {t('settings.footer.reset')}
          </button>
        </div>
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
      {/* min-width:0 + overflow:hidden lets a long subtitle truncate inside
       *  the flex item instead of pushing the right action off-screen — the
       *  W6 popup-truncation bug surfaced by user feedback when 1000+
       *  starred users saw "Syn" instead of "Sync" because the long status
       *  string ("1234 stars · 567 indexed · last synced 5m ago") forced
       *  the title div to grow past the right edge. */}
      <div style={styles.headerTitleSlot}>
        <h1 style={styles.title}>GitHub Star Kit</h1>
        <p style={styles.subtitle}>{props.subtitle}</p>
      </div>
      {props.rightAction && (
        <div style={styles.headerActionSlot}>{props.rightAction}</div>
      )}
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

/**
 * AI provider setup card — three-preset dropdown + a single API key input
 * that adapts its placeholder + help text + sign-up link based on which
 * preset is selected. Replaces the old "OpenAI API Key" SettingsCard so
 * the user can pick SiliconFlow (DeepSeek) / DashScope (Qwen) / OpenAI
 * before pasting a key.
 */
function AiProviderCard(props: {
  readonly providerDraft: AiPresetId;
  readonly onProviderChange: (id: AiPresetId) => void;
  readonly keyDraft: string;
  readonly onKeyChange: (v: string) => void;
  readonly onSave: () => void;
}): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const preset = AI_PRESETS[props.providerDraft];
  return (
    <section style={styles.card}>
      {/* Language picker top — set this first so the rest of the setup
       *  flow renders in the user's preferred locale. */}
      <label style={styles.label}>{t('settings.ai.language')}</label>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as LocaleId)}
        style={styles.input}
      >
        {LOCALE_ORDER.map((id) => (
          <option key={id} value={id}>
            {LOCALE_LABELS[id]}
          </option>
        ))}
      </select>
      <label style={styles.label}>{t('settings.ai.providerLabel')}</label>
      <select
        value={props.providerDraft}
        onChange={(e) => props.onProviderChange(e.target.value as AiPresetId)}
        style={styles.input}
      >
        {AI_PRESET_ORDER.map((id) => (
          <option key={id} value={id}>
            {AI_PRESETS[id].label}
          </option>
        ))}
      </select>
      <p style={styles.helpText}>
        {preset.description}
        <br />
        <span style={{ opacity: 0.85 }}>{preset.priceHint}</span>
        <br />
        Get a key:{' '}
        <a
          href={preset.signupUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.snippetPermalink}
        >
          {preset.signupUrl}
        </a>
      </p>
      <label style={styles.label}>{preset.label} API Key</label>
      <input
        type="password"
        placeholder="sk-…"
        autoComplete="off"
        value={props.keyDraft}
        onChange={(e) => props.onKeyChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSave();
        }}
        style={styles.input}
      />
      <p style={styles.helpText}>
        {t('settings.ai.storedLocallyPrefix')}
        <code>{new URL(preset.baseUrl).host}</code>.
      </p>
      <button
        type="button"
        onClick={props.onSave}
        disabled={props.keyDraft.trim().length === 0}
        style={styles.primaryButton}
      >
        {t('common.save')}
      </button>
    </section>
  );
}

/**
 * Compact language-only picker for the case where the user already saved
 * an AI key (so AiProviderCard isn't on screen) but still wants to switch
 * UI language. Renders a single &lt;select&gt; with no surrounding card,
 * minimal visual weight so it doesn't compete with the main action row.
 */
function LanguageQuickPicker(): JSX.Element {
  const { t, locale, setLocale } = useI18n();
  return (
    <div style={styles.langPickerRow}>
      <label style={styles.langPickerLabel}>{t('settings.ai.language')}:</label>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as LocaleId)}
        style={styles.langPickerSelect}
      >
        {LOCALE_ORDER.map((id) => (
          <option key={id} value={id}>
            {LOCALE_LABELS[id]}
          </option>
        ))}
      </select>
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
  const { t } = useI18n();
  // GitHub permalink format: /{owner}/{repo}/blob/{ref}#L{start}-L{end}
  // Using defaultBranch is acceptable for v1 — a future tightening could
  // pin the commit SHA we deep-indexed at to immortalize the link.
  const permalink = `${hit.star.htmlUrl}/blob/${hit.star.defaultBranch}/${hit.path}#L${hit.startLine}-L${hit.endLine}`;
  return (
    <>
      <div style={styles.repoLink}>
        <span style={styles.repoName}>
          <span style={styles.codeBadge}>{t('code.badge')}</span>
          {hit.star.fullName}
        </span>
        <span style={styles.repoMetaRight}>
          <span style={styles.scoreBadge}>{hit.score.toFixed(2)}</span>
        </span>
      </div>
      <div style={styles.repoMeta}>
        {hit.path} ·{' '}
        {t('code.lineRange', { start: hit.startLine, end: hit.endLine })}
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
          {t('code.viewOnGitHub')}
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
  const { locale } = useI18n();
  // Localized description: prefer the cached translation for the active
  // UI locale, fall back to the GitHub-original `description`. Empty
  // `descriptionI18n[locale]` (translation in progress / failed) also
  // falls back. `title` (tooltip) keeps the original for verifiability.
  const displayDesc =
    locale !== 'en' && star.descriptionI18n?.[locale]
      ? star.descriptionI18n[locale]!
      : star.description;
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
      {displayDesc && (
        <div style={styles.repoDesc}>{truncate(displayDesc, 120)}</div>
      )}
      {/* Localized tag chips (R17 蓝军 fix B): when the user's UI locale
       *  has cached translations in aiTagsI18n, parse + render those.
       *  Fall back to the English aiTags otherwise. Empty / malformed
       *  cache entry → fall back too. */}
      {(() => {
        const localizedRaw =
          locale !== 'en' && star.aiTagsI18n?.[locale]
            ? star.aiTagsI18n[locale]
            : null;
        const displayTags =
          localizedRaw && localizedRaw.length > 0
            ? localizedRaw.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
            : star.aiTags;
        if (displayTags.length === 0) return null;
        return (
          <div style={styles.tagRow}>
            {displayTags.map((tg) => (
              <span key={tg} style={styles.tagChip}>
                {tg}
              </span>
            ))}
          </div>
        );
      })()}
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
    // No explicit width here — body sets 480px (index.html); shell fills.
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  /** Title + subtitle column. min-width:0 is the trick that lets flex
   *  shrink THIS child to make room for the right action, so a long
   *  subtitle truncates with an ellipsis instead of pushing siblings out. */
  headerTitleSlot: {
    minWidth: 0,
    flex: '1 1 auto',
    overflow: 'hidden' as const,
  },
  /** Right-side action slot. flex-shrink:0 pins the button at its natural
   *  width regardless of how long the title gets. white-space:nowrap on the
   *  button itself (styles.smallButton) keeps "Sync" / "Syncing…" / "Wait Nm"
   *  on one line. */
  headerActionSlot: {
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: '17px',
    fontWeight: 600,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  subtitle: {
    margin: '2px 0 0',
    fontSize: '11px',
    opacity: 0.7,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
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
    whiteSpace: 'nowrap' as const,
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
  // R39: filter chip group above search results. Mimics the FilterBar
  // tag chip styling from manage page so it's visually familiar.
  searchFilterRow: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap' as const,
  },
  searchFilterChip: {
    fontSize: '11px',
    padding: '3px 9px',
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '11px',
    cursor: 'pointer',
    fontWeight: 400,
  },
  searchFilterChipActive: {
    fontSize: '11px',
    padding: '3px 9px',
    background: 'rgba(99, 102, 241, 0.18)',
    color: 'rgb(67, 56, 202)',
    border: '1px solid rgba(99, 102, 241, 0.4)',
    borderRadius: '11px',
    cursor: 'pointer',
    fontWeight: 600,
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
  // R40: notice with inline Cancel button. Same green tone, but flexbox
  // for right-aligned cancel link.
  noticeWithCancel: {
    fontSize: '11px',
    padding: '6px 10px',
    background: 'rgba(34, 197, 94, 0.1)',
    color: 'rgb(22, 101, 52)',
    borderRadius: '6px',
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  cancelLinkButton: {
    fontSize: '11px',
    padding: '2px 6px',
    background: 'transparent',
    color: 'rgb(153, 27, 27)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 500,
    flexShrink: 0,
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
  footerLinks: {
    display: 'flex',
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    gap: '6px',
    flexWrap: 'wrap' as const,
  },
  footerLink: {
    fontSize: '11px',
    color: 'inherit',
    opacity: 0.65,
    textDecoration: 'none',
    fontWeight: 500,
  },
  footerSep: {
    fontSize: '11px',
    opacity: 0.35,
  },
  langPickerRow: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '6px',
    padding: '4px 2px',
    fontSize: '11px',
    opacity: 0.7,
  },
  langPickerLabel: {
    fontWeight: 500,
  },
  langPickerSelect: {
    padding: '2px 6px',
    border: '1px solid rgba(127, 127, 127, 0.25)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    fontSize: '11px',
  },
} as const;
