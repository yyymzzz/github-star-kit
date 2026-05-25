/**
 * Full-page star management view.
 *
 * Opened via `chrome.tabs.create({ url: chrome.runtime.getURL('src/manage/index.html') })`
 * from the popup footer. Solves the user feedback "前 9 个 stars 太少了
 * 我都不知道该怎么管理" — popup stays compact for daily search; this
 * page is the power-user surface for browsing / filtering / sorting
 * thousands of stars.
 *
 * Architecture pieces:
 *   - Same IDB origin as the popup → reuse `getStores()` verbatim, no
 *     cross-context messaging.
 *   - react-window FixedSizeList for O(visible-rows) DOM regardless of
 *     total row count. Scales cleanly to 5000+ stars.
 *
 * v0.2 additions over the initial MVP:
 *   - i18n via the same I18nProvider the popup uses; all user-visible
 *     strings now flow through t() keys.
 *   - AI tag chip multi-select filter (AND semantics — all selected
 *     tags must be present on the star).
 *   - "Most relevant" sort that re-uses W4's interest-profile centroid:
 *     score each visible star by `cosine(centroid, star's vector)`, push
 *     unembedded stars to the bottom. Stars without an embedded vector
 *     score 0; user gets the same "covered vs unranked" UX the digest
 *     view introduced.
 *   - Per-row 🔧 Deep-index button: when the star isn't deep-indexed
 *     yet (and AI key + PAT are configured), one-click triggers
 *     indexRepoCode for that one repo. Inline progress on the row, no
 *     batch concurrency to worry about.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import {
  createGithubClient,
  digestCosine,
  fetchRepoSource,
  formatRelativeTime,
  indexRepoCode,
  computeInterestProfile,
  translateStars,
  type StarredRepo,
} from '@starkit/core';
import { OpenAICompatibleProvider } from '@starkit/ai';
import { IndexedDBVectorStore } from '@starkit/vector';
import {
  getStores,
  KV_KEY_AI_KEY,
  KV_KEY_AI_PROVIDER,
  KV_KEY_PAT,
  KV_KEY_VIEW_MODE,
} from '../popup/db.js';
import { AI_PRESETS, DEFAULT_AI_PRESET, type AiPresetId } from '../shared/ai-presets.js';
import { localizeError } from '../shared/error-i18n.js';
import { useI18n } from '../shared/i18n.js';
import { withSyncLock } from '../shared/lock.js';

/**
 * R34 蓝军 CRITICAL #1.1 — owner id the manage page identifies itself
 * by when acquiring the cross-context sync lock. Distinct from popup
 * + cron owner ids so debug logs can attribute lock contention.
 * Bulk AI writers (translate, per-row deep-index) hold the lock for
 * their full duration so a concurrent cron sync skips cleanly (per
 * v1 trade-off: long translate blocks one cron cycle, recovers on
 * next 6h tick).
 */
const MANAGE_OWNER_ID = 'manage-tab';

type SortBy = 'starredAt' | 'pushedAt' | 'stargazersCount' | 'relevance';
type SortOrder = 'asc' | 'desc';

interface Filters {
  readonly language: string; // '' = all
  readonly hideArchived: boolean;
  readonly hideForks: boolean;
  readonly searchText: string;
  readonly tags: ReadonlySet<string>; // AND semantics across selected
}

const DEFAULT_FILTERS: Filters = {
  language: '',
  hideArchived: true,
  hideForks: true,
  searchText: '',
  tags: new Set(),
};

/** Row height — tall enough for repo name + 2-line description + meta +
 *  tag chips + action button row. Bumped slightly from MVP to fit the
 *  per-row Deep-index button without truncation. */
// R25 card-grid layout. Each FixedSizeList row holds N cards arranged in
// CSS grid; N is computed from container width so the layout reflows on
// resize. Picking targets that align with manage's max-width 960px shell:
//   ≥1080px container → 3 cols (cap)
//    720- 1079        → 2 cols
//    < 720            → 1 col (mobile / popup-narrow)
// CARD_WIDTH_TARGET is the minimum per-card width before reflowing down a
// column count. Math.floor((W + gap) / (CARD_WIDTH_TARGET + gap)) gives
// us the column count that keeps every card ≥ target without leaving
// awkward trailing whitespace.
const CARD_WIDTH_TARGET = 320;
const CARD_HEIGHT = 200;
const GRID_GAP = 12;
const ROW_HEIGHT_CARD = CARD_HEIGHT + GRID_GAP;
// R32 ViewMode (favbox-inspired): three display densities. Card is the
// R25 default (multi-col grid for breathing room on wide screens). List
// is single-column with taller rows showing more description (good for
// reading-focused browsing). Compact is single-column with ONE-LINE rows
// for high-density 1000-star browsing where the user only scans names.
const LIST_ROW_HEIGHT = 140;
const COMPACT_ROW_HEIGHT = 52;
type ViewMode = 'card' | 'list' | 'compact';
const isValidViewMode = (v: unknown): v is ViewMode =>
  v === 'card' || v === 'list' || v === 'compact';

/** Max tag chips to surface in the filter bar. Limits visual sprawl on
 *  power-user accounts whose auto-tag run produced 100+ distinct tags;
 *  user can still filter by name to find sparse tags. */
const MAX_TAG_CHIPS = 40;

export function Manage(): JSX.Element {
  const { t, locale } = useI18n();
  const [allStars, setAllStars] = useState<ReadonlyArray<StarredRepo>>([]);
  const [vecByStarId, setVecByStarId] = useState<
    ReadonlyMap<number, ReadonlyArray<number>>
  >(new Map());
  const [profileCentroid, setProfileCentroid] = useState<
    ReadonlyArray<number> | null
  >(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // R27 UX: success toast for deep-index completion. Tells the user
  // "now go to popup to search code" after a per-row deep-index finishes.
  // Auto-clears after 6s to not nag.
  const [successToast, setSuccessToast] = useState<string | null>(null);
  // R28 蓝军 MAJOR #1: stable ref to the toast-clear timer so back-to-back
  // deep-index clicks don't race. Prior code did `setTimeout(... 6000)`
  // without storing the id — overlapping clicks would let an earlier
  // timer prematurely clear a newer toast. Also enables cleanup on
  // unmount to avoid "setState on unmounted component" warning when
  // user navigates away mid-timeout.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R37 favbox-inspired: hotkey-focused search input. Passed down to
  // FilterBar via optional prop so the global keydown listener can
  // focus the input regardless of where it lives in the DOM tree.
  // React's `input ref` expects RefObject<HTMLInputElement> (NOT
  // `<HTMLInputElement | null>`), so type the generic without null
  // even though .current starts null at mount.
  const searchInputRef = useRef<HTMLInputElement>(null);
  // R38 favbox-inspired: note editor dialog. userNote schema field
  // existed since Phase 3 but had no UI. State holds the currently-
  // editing star id + draft text; the <dialog> renders modally and
  // commits via starStore.upsertMany on Save.
  const [noteEditing, setNoteEditing] = useState<{
    starId: number;
    draft: string;
  } | null>(null);
  const noteDialogRef = useRef<HTMLDialogElement>(null);
  // R38: open/close the dialog via DOM API when noteEditing flips.
  // showModal() / close() are the proper way to drive native <dialog>;
  // setting `open` attr declaratively would skip the focus-trap +
  // backdrop behavior. Effect dep on starId only — re-opening with
  // the same star while editing keeps the dialog stable.
  useEffect(() => {
    const dlg = noteDialogRef.current;
    if (!dlg) return;
    if (noteEditing !== null && !dlg.open) {
      dlg.showModal();
    } else if (noteEditing === null && dlg.open) {
      dlg.close();
    }
  }, [noteEditing]);
  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sortBy, setSortBy] = useState<SortBy>('starredAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  // R32 ViewMode (favbox-inspired). Persisted via KV_KEY_VIEW_MODE so
  // user preference survives across page reloads. Default 'card' matches
  // R25 behavior — existing users see no change unless they pick another.
  const [viewMode, setViewMode] = useState<ViewMode>('card');

  /** Per-row in-flight Deep-index state. Map keyed by starId so multiple
   *  rows can show progress independently if user clicks several before
   *  the first finishes (acceptable concurrency for v1; the orchestrator
   *  inside each call is self-contained). */
  const [perRowState, setPerRowState] = useState<
    ReadonlyMap<number, 'indexing'>
  >(new Map());

  /** Translate state mirrors popup. R5 v0.3 — lets manage power-users
   *  trigger translate without bouncing back to the popup. */
  const [translateState, setTranslateState] = useState<'idle' | 'translating'>('idle');
  const [translateProgress, setTranslateProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  /** AI + PAT key shared from the popup KV. Required for Per-row
   *  Deep-index — if missing, button is disabled with a tooltip pointing
   *  the user back at the popup. */
  const [aiKey, setAiKey] = useState<string>('');
  const [aiProvider, setAiProvider] = useState<AiPresetId>(DEFAULT_AI_PRESET);
  const [pat, setPat] = useState<string>('');

  const [listHeight, setListHeight] = useState<number>(
    typeof window !== 'undefined' ? window.innerHeight - 280 : 600
  );
  // R25 card-grid: container width drives columnsPerRow. The shell has
  // max-width 960px (see styles.shell) with 20px side padding, so
  // effective inner width = min(window.innerWidth, 960) - 40.
  const [containerWidth, setContainerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 920;
    return Math.min(window.innerWidth, 960) - 40;
  });
  // R32: columnsPerRow + rowHeight now depend on viewMode. Card mode keeps
  // R25's multi-col reflow. List + Compact are single-column with taller
  // (list) or single-line (compact) row heights for read-focused vs
  // scan-focused browsing density.
  const columnsPerRow = useMemo(() => {
    if (viewMode === 'list' || viewMode === 'compact') return 1;
    return Math.max(
      1,
      Math.floor((containerWidth + GRID_GAP) / (CARD_WIDTH_TARGET + GRID_GAP))
    );
  }, [containerWidth, viewMode]);
  const rowHeight = useMemo(() => {
    if (viewMode === 'compact') return COMPACT_ROW_HEIGHT;
    if (viewMode === 'list') return LIST_ROW_HEIGHT;
    return ROW_HEIGHT_CARD;
  }, [viewMode]);

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { starStore, vectorStore, kvStore } = await getStores();
        const [stars, vecRows, storedPat, storedKey, storedProvider, storedView] =
          await Promise.all([
            starStore.list(),
            vectorStore.list(),
            kvStore.get<string>(KV_KEY_PAT),
            kvStore.get<string>(KV_KEY_AI_KEY),
            kvStore.get<string>(KV_KEY_AI_PROVIDER),
            kvStore.get<string>(KV_KEY_VIEW_MODE),
          ]);
        if (cancelled) return;
        if (isValidViewMode(storedView)) setViewMode(storedView);

        // Index vectors by starId so per-star cosine is O(1).
        const byId = new Map<number, ReadonlyArray<number>>();
        const allVectors: ReadonlyArray<number>[] = [];
        for (const row of vecRows) {
          const sid = row.metadata?.['starId'];
          if (typeof sid === 'number') {
            byId.set(sid, row.vector);
            allVectors.push(row.vector);
          }
        }
        setVecByStarId(byId);
        // Centroid feeds the relevance sort. Computed once at mount —
        // doesn't shift between filter changes.
        setProfileCentroid(
          allVectors.length > 0 ? computeInterestProfile(allVectors) : null
        );

        setAllStars(stars);
        setPat(storedPat ?? '');
        setAiKey(storedKey ?? '');
        if (storedProvider && storedProvider in AI_PRESETS) {
          setAiProvider(storedProvider as AiPresetId);
        }
      } catch (err) {
        if (!cancelled) setError(localizeError(err, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Persist viewMode to KV on change (R32) ──────────────────────────
  // Fire-and-forget; failure here is non-fatal (next page load will fall
  // back to default 'card'). Doesn't block render.
  useEffect(() => {
    void (async () => {
      const { kvStore } = await getStores();
      await kvStore.set(KV_KEY_VIEW_MODE, viewMode);
    })();
  }, [viewMode]);

  // ─── List-height + container-width recompute on window resize ────────
  // R25: tracks horizontal width for the responsive card grid.
  // R35 蓝军 MAJOR #3.3 fix: rAF-debounce the listener. Without debounce,
  // dragging the window edge fires onResize 60+ times/sec, each call
  // does TWO setStates → React re-render → useMemo recompute on
  // columnsPerRow → FixedSizeList re-layout 184 stars. Real jank on
  // mid-tier laptops. rAF coalesces multiple fires into ONE per frame
  // (max 60Hz update) — same recompute work runs but at frame cadence.
  useEffect(() => {
    let rafId: number | null = null;
    const apply = () => {
      rafId = null;
      setListHeight(window.innerHeight - 280);
      setContainerWidth(Math.min(window.innerWidth, 960) - 40);
    };
    const onResize = () => {
      if (rafId !== null) return; // Already scheduled this frame.
      rafId = window.requestAnimationFrame(apply);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  // R37 favbox-inspired Cmd+K / Ctrl+K / "/" hotkey to focus the search
  // input. Same shape as popup App.tsx — extracted-by-copy because the
  // helper is 20 lines and pulling it into a shared module would
  // require passing the ref + onKey factory + DOM target conventions
  // through a useImperativeHandle dance. Trade-off: 2 copies vs an
  // abstraction tax for a 20-line function. Revisit if a 3rd surface
  // (options page?) needs it.
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

  // ─── Language facets — computed ONCE per data load ────────────────────
  const languageFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allStars) {
      const lang = s.language ?? '(none)';
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [allStars]);

  // ─── AI tag facets — similarly cached. Cap surface area at MAX_TAG_CHIPS
  // so 100+ unique tags don't sprawl the filter bar. ─────────────────────
  const tagFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allStars) {
      for (const tag of s.aiTags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TAG_CHIPS);
  }, [allStars]);

  // ─── Filter + sort pipeline ───────────────────────────────────────────
  const visible = useMemo(() => {
    const lowerSearch = filters.searchText.trim().toLowerCase();
    const filtered = allStars.filter((s) => {
      if (filters.hideArchived && s.archived) return false;
      if (filters.hideForks && s.isFork) return false;
      if (filters.language) {
        const repoLang = s.language ?? '(none)';
        if (repoLang !== filters.language) return false;
      }
      if (lowerSearch) {
        const hay = `${s.fullName} ${s.description ?? ''}`.toLowerCase();
        if (!hay.includes(lowerSearch)) return false;
      }
      if (filters.tags.size > 0) {
        // AND semantics — every selected tag must be on the star
        for (const required of filters.tags) {
          if (!s.aiTags.includes(required)) return false;
        }
      }
      return true;
    });

    const factor = sortOrder === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      if (sortBy === 'stargazersCount') {
        return factor * (a.stargazersCount - b.stargazersCount);
      }
      if (sortBy === 'relevance') {
        // Cosine vs centroid. Stars without vectors get -Infinity so they
        // always sink to the bottom regardless of order — they can't be
        // meaningfully scored, so don't pretend they can.
        const av = vecByStarId.get(a.id);
        const bv = vecByStarId.get(b.id);
        if (!profileCentroid || !profileCentroid.length) return 0;
        const as = av ? digestCosine(profileCentroid, av) : -Infinity;
        const bs = bv ? digestCosine(profileCentroid, bv) : -Infinity;
        return factor * (as - bs);
      }
      const av = a[sortBy];
      const bv = b[sortBy];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return 0;
      return factor * (av < bv ? -1 : 1);
    });
    return filtered;
  }, [allStars, filters, sortBy, sortOrder, vecByStarId, profileCentroid]);

  // ─── Handlers ─────────────────────────────────────────────────────────
  const onFilterChange = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => {
      setFilters((f) => ({ ...f, [key]: value }));
    },
    []
  );

  const toggleTag = useCallback((tag: string) => {
    setFilters((f) => {
      const next = new Set(f.tags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...f, tags: next };
    });
  }, []);

  // ─── Translate: same content-translation pipeline as the popup ───────
  // Count derived live so locale switches update without re-fetching.
  const untranslatedCount = useMemo(() => {
    if (locale === 'en') return 0;
    let n = 0;
    for (const s of allStars) {
      if (!s.description || s.description.trim().length === 0) continue;
      if (s.descriptionI18n?.[locale]) continue;
      n += 1;
    }
    return n;
  }, [allStars, locale]);

  const onTranslate = useCallback(async () => {
    if (!aiKey || translateState === 'translating') return;
    if (locale === 'en') {
      setError(t('translate.englishGuard'));
      return;
    }
    setTranslateState('translating');
    setTranslateProgress({ done: 0, total: untranslatedCount });
    setError(null);

    try {
      // R34 蓝军 CRITICAL #1.1: hold the sync lock for the full translate
      // run. The orchestrator's per-repo `updateStar` callback does
      // read-modify-write on starStore; a concurrent cron sync's
      // `mergeLocalFields` does the same and would last-write-wins
      // clobber the translation. Holding the lock for the whole batch
      // serializes correctly — cron sees the lock and skips this 6h
      // tick (its next 6h tick is plenty fresh). If the lock is held
      // by sync when user clicks Translate, surface the conflict via
      // the existing sync.conflict i18n key.
      const lockOutcome = await withSyncLock(MANAGE_OWNER_ID, async () => {
      const { starStore } = await getStores();
      const preset = AI_PRESETS[aiProvider];
      const provider = new OpenAICompatibleProvider({
        provider: 'openai-compatible',
        apiKey: aiKey,
        baseUrl: preset.baseUrl,
        chatModel: preset.chatModel,
      });

      const translateResult = await translateStars({
        starStore,
        chat: (system, user, signal) =>
          provider
            .chat({
              system,
              user,
              // R20 蓝军 #1: match popup — explicit maxTokens prevents
              // SiliconFlow truncating compound-heavy translations.
              maxTokens: 1024,
              ...(signal ? { signal } : {}),
            })
            .then((r) => ({
              text: r.text,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              model: r.model,
            })),
        // Same dual-field write-back as popup. `field` discriminator
        // routes to descriptionI18n vs aiTagsI18n.
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

      // Refresh local allStars so row renders pick up the new
      // descriptionI18n / aiTagsI18n entries without a full reload.
      const fresh = await starStore.list();
      setAllStars(fresh);
      setTranslateProgress(null);

      if (translateResult.failed > 0) {
        const failedNames = translateResult.failedStarIds
          .slice(0, 3)
          .map((id) => fresh.find((s) => s.id === id)?.fullName)
          .filter((n): n is string => typeof n === 'string')
          .join(', ');
        const more =
          translateResult.failedStarIds.length > 3
            ? ` +${translateResult.failedStarIds.length - 3}…`
            : '';
        // R20 蓝军 MAJOR #1: surface the provider error message so the
        // user knows whether to wait (rate_limit), fix their key (auth),
        // or retry (network/parse). Matches popup translate handler.
        const reason = translateResult.lastErrorMessage
          ? `: ${translateResult.lastErrorMessage}`
          : '';
        setError(
          t('translate.partialFailure', {
            failed: translateResult.failed,
            names: failedNames,
            more,
            reason,
          })
        );
      }
      });
      // R34: lock was held by another sync source (popup or cron). Tell
      // the user instead of silently dropping the click.
      if (!lockOutcome.ran) {
        setError(t('sync.conflict'));
      }
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setTranslateState('idle');
    }
  }, [aiKey, aiProvider, locale, translateState, untranslatedCount]);

  const onPerRowDeepIndex = useCallback(
    async (star: StarredRepo) => {
      if (!aiKey || !pat) {
        setError(t('manage.needsKeys'));
        return;
      }
      if (perRowState.has(star.id)) return; // Already in flight
      setError(null);
      setPerRowState((m) => new Map(m).set(star.id, 'indexing'));

      try {
        // R34 蓝军 CRITICAL #1.1: same sync-lock discipline as bulk
        // translate. Per-row deep-index also does read-modify-write
        // (deepIndexed=true) at the end — without the lock, a concurrent
        // cron sync's mergeLocalFields could clobber the deepIndexed
        // flag (or vice versa, this write could clobber sync's fresh
        // GitHub fields). Lock for the whole indexRepoCode + write.
        const lockOutcome = await withSyncLock(MANAGE_OWNER_ID, async () => {
        const { starStore, vectorStore } = await getStores();
        const preset = AI_PRESETS[aiProvider];
        const provider = new OpenAICompatibleProvider({
          provider: 'openai-compatible',
          apiKey: aiKey,
          baseUrl: preset.baseUrl,
          embedModel: preset.embedModel,
        });
        const githubClient = createGithubClient({
          token: pat,
          userAgent: '@starkit/extension(manage-per-row)',
        });

        const [owner, repo] = star.fullName.split('/');
        if (!owner || !repo) {
          throw new Error(t('manage.malformedFullName', { name: star.fullName }));
        }

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
          upsert: (rows) => vectorStore.upsertMany(rows),
          getExisting: (id) => vectorStore.get(id),
        });

        // R21 蓝军 round-2 MAJOR (subagent A): re-read the star from
        // starStore BEFORE the upsert. The `star` parameter is captured
        // by the row's click closure at render time; if a concurrent
        // onTranslate updated descriptionI18n/aiTagsI18n between render
        // and this click, the stale spread `{ ...star, deepIndexed: true }`
        // would WIPE those freshly-translated fields — same data-loss
        // class as the R21 P0 sync-wipes-i18n bug. Mirrors the read-
        // then-merge pattern popup onAutoTag uses (App.tsx:625).
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
          setAllStars((prev) =>
            prev.map((s) => (s.id === star.id ? { ...s, deepIndexed: true } : s))
          );
          // R27 UX: positive feedback — tells the user where to use the
          // index. R28 蓝军 MAJOR #1: cancel any pending prior toast
          // timer before scheduling a new one, so overlapping clicks
          // don't race and prematurely clear a newer toast.
          setSuccessToast(
            t('manage.deepIndexDoneToast', { repo: fresh.fullName })
          );
          if (toastTimerRef.current !== null) {
            clearTimeout(toastTimerRef.current);
          }
          toastTimerRef.current = setTimeout(() => {
            setSuccessToast(null);
            toastTimerRef.current = null;
          }, 6000);
        }
        // else: star vanished (user un-starred during the run); do not
        // synthesize from the stale closure. Caller's allStars will
        // reflect the un-star on next sync — no UI inconsistency.
        });
        // R34: lock held by another sync source. Surface the conflict.
        if (!lockOutcome.ran) {
          setError(t('sync.conflict'));
        }
      } catch (err) {
        setError(localizeError(err, t));
      } finally {
        setPerRowState((m) => {
          const next = new Map(m);
          next.delete(star.id);
          return next;
        });
      }
    },
    [aiKey, aiProvider, pat, perRowState, t]
  );

  // ─── Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <main style={styles.shell}>
        <Header subtitle={t('manage.loadingSubtitle')} />
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <Header
        subtitle={
          allStars.length === 0
            ? t('manage.noStarsSubtitle')
            : t('manage.showingOfTotal', {
                shown: visible.length.toLocaleString(),
                total: allStars.length.toLocaleString(),
              })
        }
      />

      {error && (
        <div role="alert" style={styles.errorBanner}>
          ⚠ {error}
        </div>
      )}

      {/* R27 UX: deep-index success toast. Self-clearing 6s timer set
       *  inside onPerRowDeepIndex. Doesn't block other UI — sits above
       *  the filter bar so the user notices it after a long index run. */}
      {successToast && (
        <div role="status" style={styles.successToast}>
          {successToast}
        </div>
      )}

      {/* R27 UX: Deep-index hint banner. Renders only when the user has
       *  configured PAT + AI key (so the per-row button is actionable)
       *  AND has at least one not-yet-deep-indexed candidate. Hidden
       *  once everything is indexed (no need to keep nagging). Addresses
       *  the "什么是深度索引/等了很久没变化" cognition gap — tells the
       *  user WHY they'd click + WHERE the output lands (popup search). */}
      {aiKey !== '' && pat !== '' && allStars.some((s) => !s.deepIndexed) && (
        <div style={styles.deepIndexHint}>{t('manage.deepIndexHint')}</div>
      )}

      {/* R30 蓝军 round-4 MINOR #4: when user hasn't configured PAT or
       *  AI key yet, the per-row Deep-index button is disabled with
       *  only a tooltip explaining why. On touch / fast-scroll users
       *  may click the disabled button thinking it's broken. This
       *  banner gives explicit guidance about where to configure keys.
       *  Mutually exclusive with deepIndexHint (the dependency on
       *  aiKey/pat being non-empty above means only one shows at a time). */}
      {(aiKey === '' || pat === '') && allStars.length > 0 && (
        <div style={styles.deepIndexHint}>{t('manage.needsKeysHint')}</div>
      )}

      {/* Translate progress + button row (R5 v0.3). Renders only when
       *  the user can act on it: non-English UI, has AI key, and there
       *  are stars left to translate. Button hides during translation
       *  (the progress notice replaces it). */}
      {locale !== 'en' && (translateState === 'translating' || (aiKey !== '' && untranslatedCount > 0)) && (
        <div style={styles.actionBar}>
          {translateState === 'translating' && translateProgress ? (
            <span style={styles.actionBarNotice}>
              🌐{' '}
              {t('translate.translating', {
                done: translateProgress.done,
                total: translateProgress.total,
              })}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void onTranslate()}
              style={styles.actionBarButton}
              title={t('translate.title', { n: untranslatedCount, locale })}
            >
              {t('translate.button', { n: untranslatedCount })}
            </button>
          )}
        </div>
      )}

      {allStars.length > 0 && (
        <>
          <FilterBar
            filters={filters}
            languageFacets={languageFacets}
            tagFacets={tagFacets}
            sortBy={sortBy}
            sortOrder={sortOrder}
            hasProfile={profileCentroid !== null}
            onFilterChange={onFilterChange}
            onToggleTag={toggleTag}
            onSortByChange={setSortBy}
            onSortOrderChange={setSortOrder}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            searchInputRef={searchInputRef}
          />

          {visible.length === 0 ? (
            <section style={styles.emptyCard}>
              <strong>{t('manage.noMatch')}</strong>
              <p style={styles.helpText}>{t('manage.noMatchHelp')}</p>
            </section>
          ) : (
            <FixedSizeList
              height={listHeight}
              width="100%"
              // R25 card-grid + R32 ViewMode: items are ROWS of N cards
              // (N=1 for list/compact mode, dynamic for card mode based
              // on container width). Total item count = ceil(stars / N).
              itemCount={Math.ceil(visible.length / columnsPerRow)}
              itemSize={rowHeight}
              overscanCount={3}
              itemData={{
                stars: visible,
                perRowState,
                onDeepIndex: onPerRowDeepIndex,
                canDeepIndex: aiKey !== '' && pat !== '',
                columnsPerRow,
                viewMode,
                onEditNote: (star: StarredRepo) =>
                  setNoteEditing({
                    starId: star.id,
                    draft: star.userNote ?? '',
                  }),
              }}
            >
              {GridRow}
            </FixedSizeList>
          )}
        </>
      )}

      {/* R38 favbox-inspired note editor — modal <dialog>. Native
       *  element handles backdrop + focus trap + ESC-to-close. Form
       *  method="dialog" closes on submit (Save button). Cancel just
       *  flips state to null which triggers dlg.close() in useEffect. */}
      <dialog ref={noteDialogRef} style={styles.noteDialog}>
        {noteEditing !== null && (
          <form
            method="dialog"
            style={styles.noteDialogForm}
            onSubmit={async (e) => {
              e.preventDefault();
              // Re-read fresh row to avoid clobbering concurrent writes
              // (R21 P0 + R22 race-fix patterns apply here too).
              const { starStore } = await getStores();
              const fresh = await starStore.get(noteEditing.starId);
              if (fresh) {
                const trimmed = noteEditing.draft.trim();
                await starStore.upsertMany([
                  {
                    ...fresh,
                    userNote: trimmed.length > 0 ? trimmed : null,
                  },
                ]);
                setAllStars((prev) =>
                  prev.map((s) =>
                    s.id === noteEditing.starId
                      ? { ...s, userNote: trimmed.length > 0 ? trimmed : null }
                      : s
                  )
                );
              }
              setNoteEditing(null);
            }}
          >
            <h2 style={styles.noteDialogHeader}>
              {t('manage.noteDialogTitle', {
                repo:
                  allStars.find((s) => s.id === noteEditing.starId)
                    ?.fullName ?? '',
              })}
            </h2>
            <textarea
              autoFocus
              value={noteEditing.draft}
              onChange={(e) =>
                setNoteEditing({
                  starId: noteEditing.starId,
                  draft: e.target.value.slice(0, 2000),
                })
              }
              placeholder={t('manage.noteDialogPlaceholder')}
              style={styles.noteDialogTextarea}
              maxLength={2000}
            />
            <div style={styles.noteDialogFooter}>
              <span style={styles.noteDialogCount}>
                {t('manage.noteDialogCount', { n: noteEditing.draft.length })}
              </span>
              <div style={styles.noteDialogButtons}>
                <button
                  type="button"
                  onClick={() => setNoteEditing(null)}
                  style={styles.noteDialogCancelBtn}
                >
                  {t('manage.noteDialogCancel')}
                </button>
                <button type="submit" style={styles.noteDialogSaveBtn}>
                  {t('manage.noteDialogSave')}
                </button>
              </div>
            </div>
          </form>
        )}
      </dialog>
    </main>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function Header(props: { readonly subtitle: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <header style={styles.header}>
      <h1 style={styles.title}>{t('manage.title')}</h1>
      <p style={styles.subtitle}>{props.subtitle}</p>
    </header>
  );
}

function FilterBar(props: {
  readonly filters: Filters;
  readonly languageFacets: ReadonlyArray<readonly [string, number]>;
  readonly tagFacets: ReadonlyArray<readonly [string, number]>;
  readonly sortBy: SortBy;
  readonly sortOrder: SortOrder;
  readonly hasProfile: boolean;
  readonly onFilterChange: <K extends keyof Filters>(
    key: K,
    value: Filters[K]
  ) => void;
  readonly onToggleTag: (tag: string) => void;
  readonly onSortByChange: (v: SortBy) => void;
  readonly onSortOrderChange: (v: SortOrder) => void;
  readonly viewMode: ViewMode;
  readonly onViewModeChange: (v: ViewMode) => void;
  // R37 favbox-inspired: parent passes a ref so the global CmdK / Ctrl+K
  // hotkey can focus this search input. Optional so callers without a
  // hotkey listener don't need to wire it. RefObject<HTMLInputElement>
  // matches React's `input ref` type — see useRef declaration.
  readonly searchInputRef?: React.RefObject<HTMLInputElement>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section style={styles.filterBar}>
      <input
        ref={props.searchInputRef}
        type="search"
        placeholder={t('manage.searchPlaceholder')}
        value={props.filters.searchText}
        onChange={(e) => props.onFilterChange('searchText', e.target.value)}
        style={styles.searchInput}
        aria-keyshortcuts="Control+K Meta+K"
      />
      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>
          {t('manage.languageLabel')}:
          <select
            value={props.filters.language}
            onChange={(e) => props.onFilterChange('language', e.target.value)}
            style={styles.filterControl}
          >
            <option value="">
              {t('manage.languageAll')} (
              {props.languageFacets.reduce((a, [, c]) => a + c, 0)})
            </option>
            {props.languageFacets.map(([lang, count]) => (
              <option key={lang} value={lang}>
                {lang} ({count})
              </option>
            ))}
          </select>
        </label>

        <label style={styles.filterLabel}>
          {t('manage.sortBy')}:
          <select
            value={props.sortBy}
            onChange={(e) => props.onSortByChange(e.target.value as SortBy)}
            style={styles.filterControl}
          >
            <option value="starredAt">{t('manage.sortStarred')}</option>
            <option value="pushedAt">{t('manage.sortPushed')}</option>
            <option value="stargazersCount">{t('manage.sortStars')}</option>
            <option value="relevance" disabled={!props.hasProfile}>
              {t('manage.sortRelevance')}
              {props.hasProfile ? '' : t('manage.sortRelevanceNeedsIndex')}
            </option>
          </select>
        </label>

        <button
          type="button"
          onClick={() =>
            props.onSortOrderChange(props.sortOrder === 'desc' ? 'asc' : 'desc')
          }
          style={styles.sortDirButton}
          title={t('manage.sortOrderTitle', {
            order: props.sortOrder.toUpperCase(),
          })}
        >
          {props.sortOrder === 'desc' ? '↓' : '↑'}
        </button>

        {/* R32 ViewMode toggle — 3-button group (Cards / List / Compact) */}
        <div
          style={styles.viewModeGroup}
          role="group"
          aria-label={t('manage.viewModeTitle')}
        >
          {(['card', 'list', 'compact'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => props.onViewModeChange(m)}
              style={
                props.viewMode === m
                  ? styles.viewModeButtonActive
                  : styles.viewModeButton
              }
              title={t('manage.viewModeTitle')}
              aria-pressed={props.viewMode === m}
            >
              {t(
                m === 'card'
                  ? 'manage.viewModeCard'
                  : m === 'list'
                    ? 'manage.viewModeList'
                    : 'manage.viewModeCompact'
              )}
            </button>
          ))}
        </div>

        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={props.filters.hideArchived}
            onChange={(e) => props.onFilterChange('hideArchived', e.target.checked)}
          />
          {t('manage.hideArchived')}
        </label>

        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={props.filters.hideForks}
            onChange={(e) => props.onFilterChange('hideForks', e.target.checked)}
          />
          {t('manage.hideForks')}
        </label>
      </div>

      {props.tagFacets.length > 0 && (
        <div style={styles.tagFilterRow}>
          <span style={styles.tagFilterLabel}>{t('manage.tagsLabel')}</span>
          {props.tagFacets.map(([tag, count]) => {
            const active = props.filters.tags.has(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => props.onToggleTag(tag)}
                style={active ? styles.tagChipActive : styles.tagChipInactive}
                title={t('manage.tagCountTitle', { n: count })}
              >
                {tag} {active ? '✓' : `· ${count}`}
              </button>
            );
          })}
          {props.filters.tags.size > 0 && (
            <button
              type="button"
              onClick={() => props.onFilterChange('tags', new Set())}
              style={styles.tagClearButton}
            >
              {t('manage.tagsClear', { n: props.filters.tags.size })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface GridData {
  readonly stars: ReadonlyArray<StarredRepo>;
  readonly perRowState: ReadonlyMap<number, 'indexing'>;
  readonly onDeepIndex: (star: StarredRepo) => void;
  readonly canDeepIndex: boolean;
  readonly columnsPerRow: number;
  readonly viewMode: ViewMode;
  // R38 favbox-inspired note editor: opens the dialog with this
  // star's current userNote as draft. Callback (not a JSX prop)
  // so cards across all 3 view modes can call it uniformly.
  readonly onEditNote: (star: StarredRepo) => void;
}

/**
 * R25 card-grid: a single "row" inside react-window's FixedSizeList that
 * holds `columnsPerRow` Cards in a CSS grid. The previous v0.3 version
 * rendered one full-width card per virtual row, which wasted ~70% of the
 * 960px shell on wide screens. Multi-col reflows from 1 → 2 → 3 cards
 * based on container width without changing virtualization perf (item
 * count drops from N to ceil(N/cols) so virtualized DOM stays bounded).
 *
 * Layout note: the inline `style` prop comes from react-window with
 * `position: absolute; top/left/width/height` for placement. We spread
 * it first then add `display: grid` + padding for the inner layout —
 * positioning props remain intact because we don't redefine them.
 */
function GridRow(props: {
  readonly index: number;
  readonly style: React.CSSProperties;
  readonly data: GridData;
}): JSX.Element {
  const { index, style, data } = props;
  const start = index * data.columnsPerRow;
  const end = Math.min(start + data.columnsPerRow, data.stars.length);
  const slice = data.stars.slice(start, end);
  // R32: dispatch to the right repo-row component based on viewMode.
  // Card mode keeps R25's CSS grid; list/compact use a single full-
  // width row so we keep the FixedSizeList virtualization but render
  // a denser layout per row.
  if (data.viewMode === 'compact') {
    const star = slice[0];
    if (!star) return <div style={style} />;
    return (
      <div style={{ ...style, padding: '0 4px' }}>
        <CompactRow
          star={star}
          indexing={data.perRowState.has(star.id)}
          canDeepIndex={data.canDeepIndex}
          onDeepIndex={data.onDeepIndex}
          onEditNote={data.onEditNote}
        />
      </div>
    );
  }
  if (data.viewMode === 'list') {
    const star = slice[0];
    if (!star) return <div style={style} />;
    return (
      <div style={{ ...style, padding: `0 4px ${GRID_GAP / 2}px 4px` }}>
        <ListRow
          star={star}
          indexing={data.perRowState.has(star.id)}
          canDeepIndex={data.canDeepIndex}
          onDeepIndex={data.onDeepIndex}
          onEditNote={data.onEditNote}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        ...style,
        display: 'grid',
        gridTemplateColumns: `repeat(${data.columnsPerRow}, minmax(0, 1fr))`,
        gap: `${GRID_GAP}px`,
        padding: `0 4px ${GRID_GAP}px 4px`,
      }}
    >
      {slice.map((star) => (
        <Card
          key={star.id}
          star={star}
          indexing={data.perRowState.has(star.id)}
          canDeepIndex={data.canDeepIndex}
          onDeepIndex={data.onDeepIndex}
          onEditNote={data.onEditNote}
        />
      ))}
    </div>
  );
}

/**
 * R32 ViewMode 'list' — single-column wide row with more description
 * lines visible than Card. Optimized for reading-focused browsing
 * where the user wants to scan summaries / aiTags carefully.
 */
function ListRow(props: {
  readonly star: StarredRepo;
  readonly indexing: boolean;
  readonly canDeepIndex: boolean;
  readonly onDeepIndex: (star: StarredRepo) => void;
  readonly onEditNote: (star: StarredRepo) => void;
}): JSX.Element {
  const { star, indexing, canDeepIndex, onDeepIndex, onEditNote } = props;
  const { t, locale } = useI18n();
  const displayDesc =
    locale !== 'en' && star.descriptionI18n?.[locale]
      ? star.descriptionI18n[locale]!
      : star.description;
  const localizedRaw =
    locale !== 'en' && star.aiTagsI18n?.[locale] ? star.aiTagsI18n[locale] : null;
  const displayTags =
    localizedRaw && localizedRaw.length > 0
      ? localizedRaw.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 0)
      : star.aiTags;
  return (
    <div style={styles.listRow}>
      <div style={styles.cardHeader}>
        <a
          href={star.htmlUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.repoName}
          title={star.description ?? undefined}
        >
          {star.fullName}
        </a>
        <div style={styles.cardHeaderRight}>
          {star.language && <span style={styles.lang}>{star.language}</span>}
          <span style={styles.stars}>
            ★ {star.stargazersCount.toLocaleString()}
          </span>
        </div>
      </div>
      {displayDesc && <p style={styles.listDesc}>{displayDesc}</p>}
      {displayTags.length > 0 && (
        <div style={styles.tagRow}>
          {displayTags.slice(0, 6).map((tg) => (
            <span key={tg} style={styles.tagChipDisplay}>{tg}</span>
          ))}
          {displayTags.length > 6 && (
            <span style={styles.tagChipOverflow}>+{displayTags.length - 6}</span>
          )}
        </div>
      )}
      {star.userNote && star.userNote.length > 0 && (
        <button
          type="button"
          style={styles.notePreview}
          onClick={() => onEditNote(star)}
          title={t('manage.noteButtonTitle')}
        >
          📝 {star.userNote}
        </button>
      )}
      <div style={styles.cardFooter}>
        <span style={styles.rowMeta}>
          {formatRelativeTime(star.starredAt)}
          {star.pushedAt && ` · ${formatRelativeTime(star.pushedAt)}`}
          {star.archived && ` · ${t('manage.metaArchived')}`}
          {star.isFork && ` · ${t('manage.metaFork')}`}
        </span>
        <button
          type="button"
          onClick={() => onEditNote(star)}
          style={styles.noteIconButton}
          title={t('manage.noteButtonTitle')}
          aria-label={t('manage.noteButtonTitle')}
        >
          {t('manage.noteButton')}
        </button>
        {star.deepIndexed ? (
          <span style={styles.deepIndexedBadge}>{t('deepIndex.rowDone')}</span>
        ) : (
          <button
            type="button"
            onClick={() => onDeepIndex(star)}
            disabled={!canDeepIndex || indexing}
            style={styles.deepIndexButton}
            title={
              !canDeepIndex
                ? t('deepIndex.rowTitleDisabled')
                : indexing
                  ? t('deepIndex.rowTitleInProgress')
                  : t('deepIndex.rowTitleEnabled')
            }
          >
            {indexing ? t('deepIndex.rowIndexing') : t('deepIndex.rowButton')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * R32 ViewMode 'compact' — single-line per repo for high-density
 * scanning of 1000+ stars. Truncates description to one line; shows
 * only the count of aiTags (not the chips themselves) to save space.
 */
function CompactRow(props: {
  readonly star: StarredRepo;
  readonly indexing: boolean;
  readonly canDeepIndex: boolean;
  readonly onDeepIndex: (star: StarredRepo) => void;
  readonly onEditNote: (star: StarredRepo) => void;
}): JSX.Element {
  const { star, indexing, canDeepIndex, onDeepIndex, onEditNote } = props;
  const { t, locale } = useI18n();
  const displayDesc =
    locale !== 'en' && star.descriptionI18n?.[locale]
      ? star.descriptionI18n[locale]!
      : star.description;
  const hasNote = star.userNote !== null && star.userNote.length > 0;
  return (
    <div style={styles.compactRow}>
      <a
        href={star.htmlUrl}
        target="_blank"
        rel="noreferrer"
        style={styles.compactRepoName}
        title={star.description ?? undefined}
      >
        {star.fullName}
      </a>
      <span style={styles.compactDesc}>{displayDesc ?? ''}</span>
      <div style={styles.compactMetaGroup}>
        {star.language && <span style={styles.lang}>{star.language}</span>}
        <span style={styles.stars}>★ {star.stargazersCount.toLocaleString()}</span>
        {star.aiTags.length > 0 && (
          <span style={styles.compactTagCount}>#{star.aiTags.length}</span>
        )}
        {/* R38: note icon — filled when note exists, faded when empty. */}
        <button
          type="button"
          onClick={() => onEditNote(star)}
          style={hasNote ? styles.compactNoteButtonHas : styles.compactNoteButton}
          title={
            hasNote && star.userNote
              ? star.userNote.length > 80
                ? `${star.userNote.slice(0, 80)}…`
                : star.userNote
              : t('manage.noteButtonTitle')
          }
          aria-label={t('manage.noteButtonTitle')}
        >
          {t('manage.noteButton')}
        </button>
        {star.deepIndexed ? (
          <span style={styles.deepIndexedBadge}>🔧</span>
        ) : (
          <button
            type="button"
            onClick={() => onDeepIndex(star)}
            disabled={!canDeepIndex || indexing}
            style={styles.compactDeepIndexButton}
            title={
              !canDeepIndex
                ? t('deepIndex.rowTitleDisabled')
                : indexing
                  ? t('deepIndex.rowTitleInProgress')
                  : t('deepIndex.rowTitleEnabled')
            }
          >
            {indexing ? '⏳' : '🔧'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Single repo card. Extracted from the old Row component so GridRow can
 * compose N of them. Same render contract: name + lang/stars on top,
 * description (2-line clamp), AI tags chips, footer meta + Deep-index
 * button. Locale-aware via useI18n — descriptionI18n / aiTagsI18n
 * fallbacks preserved from R17.
 */
function Card(props: {
  readonly star: StarredRepo;
  readonly indexing: boolean;
  readonly canDeepIndex: boolean;
  readonly onDeepIndex: (star: StarredRepo) => void;
  readonly onEditNote: (star: StarredRepo) => void;
}): JSX.Element {
  const { star, indexing, canDeepIndex, onDeepIndex, onEditNote } = props;
  const { t, locale } = useI18n();
  const displayDesc =
    locale !== 'en' && star.descriptionI18n?.[locale]
      ? star.descriptionI18n[locale]!
      : star.description;
  // R17 蓝军 fix B: localized tags fallback.
  const localizedRaw =
    locale !== 'en' && star.aiTagsI18n?.[locale] ? star.aiTagsI18n[locale] : null;
  const displayTags =
    localizedRaw && localizedRaw.length > 0
      ? localizedRaw
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : star.aiTags;
  return (
    <div style={styles.cardCard}>
      <div style={styles.cardHeader}>
        <a
          href={star.htmlUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.repoName}
          title={star.description ?? undefined}
        >
          {star.fullName}
        </a>
        <div style={styles.cardHeaderRight}>
          {star.language && <span style={styles.lang}>{star.language}</span>}
          <span style={styles.stars}>
            ★ {star.stargazersCount.toLocaleString()}
          </span>
        </div>
      </div>
      {displayDesc && <p style={styles.cardDesc}>{displayDesc}</p>}
      <div style={styles.cardMiddle}>
        {displayTags.length > 0 && (
          <div style={styles.tagRow}>
            {displayTags.slice(0, 4).map((tg) => (
              <span key={tg} style={styles.tagChipDisplay}>
                {tg}
              </span>
            ))}
            {displayTags.length > 4 && (
              <span style={styles.tagChipOverflow}>
                +{displayTags.length - 4}
              </span>
            )}
          </div>
        )}
      </div>
      {/* R38: note preview — shown above footer when userNote exists.
       *  Click = open editor. Subtle italic, 1-line truncate. */}
      {star.userNote && star.userNote.length > 0 && (
        <button
          type="button"
          style={styles.notePreview}
          onClick={() => onEditNote(star)}
          title={t('manage.noteButtonTitle')}
        >
          📝 {star.userNote}
        </button>
      )}
      <div style={styles.cardFooter}>
        <span style={styles.rowMeta}>
          {formatRelativeTime(star.starredAt)}
          {star.pushedAt && ` · ${formatRelativeTime(star.pushedAt)}`}
          {star.archived && ` · ${t('manage.metaArchived')}`}
          {star.isFork && ` · ${t('manage.metaFork')}`}
        </span>
        {/* R38: note edit button — always rendered. */}
        <button
          type="button"
          onClick={() => onEditNote(star)}
          style={styles.noteIconButton}
          title={t('manage.noteButtonTitle')}
          aria-label={t('manage.noteButtonTitle')}
        >
          {t('manage.noteButton')}
        </button>
        {star.deepIndexed ? (
          <span style={styles.deepIndexedBadge}>{t('deepIndex.rowDone')}</span>
        ) : (
          <button
            type="button"
            onClick={() => onDeepIndex(star)}
            disabled={!canDeepIndex || indexing}
            style={styles.deepIndexButton}
            title={
              !canDeepIndex
                ? t('deepIndex.rowTitleDisabled')
                : indexing
                  ? t('deepIndex.rowTitleInProgress')
                  : t('deepIndex.rowTitleEnabled')
            }
          >
            {indexing ? t('deepIndex.rowIndexing') : t('deepIndex.rowButton')}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────

const styles = {
  shell: {
    maxWidth: '960px',
    margin: '0 auto',
    padding: '24px 20px 40px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  },
  header: {
    borderBottom: '1px solid rgba(127, 127, 127, 0.18)',
    paddingBottom: '12px',
  },
  title: {
    margin: 0,
    fontSize: '22px',
    fontWeight: 600,
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: '13px',
    opacity: 0.65,
  },
  errorBanner: {
    fontSize: '13px',
    padding: '10px 14px',
    background: 'rgba(239, 68, 68, 0.12)',
    color: 'rgb(153, 27, 27)',
    borderRadius: '6px',
  },
  actionBar: {
    display: 'flex',
    justifyContent: 'flex-end' as const,
    alignItems: 'center' as const,
    padding: '4px 0',
  },
  actionBarButton: {
    padding: '6px 14px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 500,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  actionBarNotice: {
    fontSize: '12px',
    padding: '6px 12px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '6px',
    fontWeight: 500,
  },
  filterBar: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
    padding: '12px 14px',
    background: 'rgba(127, 127, 127, 0.07)',
    borderRadius: '8px',
  },
  searchInput: {
    padding: '8px 12px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '6px',
    fontSize: '13px',
    background: 'transparent',
    color: 'inherit',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  filterRow: {
    display: 'flex',
    gap: '14px',
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
    fontSize: '12px',
  },
  filterLabel: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '6px',
    opacity: 0.8,
  },
  filterControl: {
    padding: '5px 8px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '5px',
    fontSize: '12px',
    background: 'transparent',
    color: 'inherit',
    minWidth: '180px',
  },
  sortDirButton: {
    padding: '4px 10px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '5px',
    fontSize: '14px',
    fontWeight: 600,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  toggleLabel: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '6px',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  tagFilterRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '5px',
    alignItems: 'center' as const,
    paddingTop: '4px',
    borderTop: '1px dashed rgba(127, 127, 127, 0.18)',
  },
  tagFilterLabel: {
    fontSize: '11px',
    opacity: 0.6,
    fontWeight: 600,
    marginRight: '4px',
  },
  tagChipInactive: {
    fontSize: '11px',
    padding: '3px 9px',
    background: 'rgba(127, 127, 127, 0.08)',
    color: 'inherit',
    border: '1px solid rgba(127, 127, 127, 0.18)',
    borderRadius: '11px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  tagChipActive: {
    fontSize: '11px',
    padding: '3px 9px',
    background: 'rgba(99, 102, 241, 0.18)',
    color: 'rgb(67, 56, 202)',
    border: '1px solid rgba(99, 102, 241, 0.4)',
    borderRadius: '11px',
    cursor: 'pointer',
    fontWeight: 600,
  },
  tagClearButton: {
    fontSize: '11px',
    padding: '3px 9px',
    background: 'transparent',
    color: 'rgb(239, 68, 68)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '11px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  emptyCard: {
    padding: '24px',
    background: 'rgba(127, 127, 127, 0.07)',
    borderRadius: '8px',
    textAlign: 'center' as const,
  },
  // R27: subtle info hint above the filter bar — explains what deep-
  // index does + where to use it. Distinct from errorBanner (warning
  // red) — uses friendly blue tone so users learn rather than worry.
  deepIndexHint: {
    padding: '10px 14px',
    background: 'rgba(99, 102, 241, 0.08)',
    border: '1px solid rgba(99, 102, 241, 0.22)',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: 1.55,
    color: 'inherit',
    opacity: 0.92,
  },
  // R27: success toast on deep-index completion. Green/positive tone
  // to distinguish from errorBanner (red). Self-clears after 6s via
  // setTimeout in onPerRowDeepIndex.
  successToast: {
    padding: '10px 14px',
    background: 'rgba(34, 197, 94, 0.10)',
    border: '1px solid rgba(34, 197, 94, 0.30)',
    color: 'rgb(22, 101, 52)',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
  },
  helpText: {
    fontSize: '12px',
    opacity: 0.65,
    margin: '8px 0 0',
  },
  // R25 card-grid: each card occupies a CSS grid cell sized by GridRow's
  // template. Height is the grid-row's full track height (= ROW_HEIGHT
  // minus the GRID_GAP padding-bottom of the row container).
  cardCard: {
    height: `${CARD_HEIGHT}px`,
    padding: '12px 14px',
    background: 'rgba(127, 127, 127, 0.03)',
    border: '1px solid rgba(127, 127, 127, 0.18)',
    borderRadius: '8px',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    overflow: 'hidden' as const,
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'baseline' as const,
    gap: '8px',
  },
  cardHeaderRight: {
    display: 'flex',
    gap: '8px',
    fontSize: '11px',
    opacity: 0.7,
    flexShrink: 0,
  },
  repoName: {
    fontWeight: 600,
    fontSize: '13.5px',
    color: 'inherit',
    textDecoration: 'none',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    flex: 1,
  },
  lang: { fontSize: '10.5px' },
  stars: { fontSize: '10.5px', fontFamily: 'ui-monospace, monospace' },
  cardDesc: {
    margin: 0,
    fontSize: '12px',
    opacity: 0.78,
    lineHeight: 1.4,
    overflow: 'hidden' as const,
    display: '-webkit-box' as const,
    WebkitBoxOrient: 'vertical' as const,
    WebkitLineClamp: 3,
  },
  cardMiddle: {
    minHeight: '18px',
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
    marginTop: 'auto',
    paddingTop: '4px',
  },
  tagRow: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap' as const,
    overflow: 'hidden' as const,
  },
  tagChipDisplay: {
    fontSize: '10px',
    padding: '1px 6px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '10px',
    fontWeight: 500,
  },
  // R25 card-grid: shown when a card has >4 aiTags, so the visible
  // count stays predictable for the fixed CARD_HEIGHT. Neutral color
  // distinguishes it from real tags (not clickable, just an overflow
  // indicator — full tag list still in DOM via title attribute if
  // future spec wants it).
  tagChipOverflow: {
    fontSize: '10px',
    padding: '1px 6px',
    background: 'rgba(127, 127, 127, 0.12)',
    color: 'rgb(75, 85, 99)',
    borderRadius: '10px',
    fontWeight: 500,
  },
  // R32 ViewMode 'list': taller single-column row with bigger description
  // area than Card. Tag chips truncated at 6 instead of 4.
  listRow: {
    height: `${LIST_ROW_HEIGHT - GRID_GAP / 2}px`,
    padding: '12px 16px',
    background: 'rgba(127, 127, 127, 0.03)',
    border: '1px solid rgba(127, 127, 127, 0.18)',
    borderRadius: '8px',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    overflow: 'hidden' as const,
  },
  listDesc: {
    margin: 0,
    fontSize: '12.5px',
    opacity: 0.8,
    lineHeight: 1.45,
    overflow: 'hidden' as const,
    display: '-webkit-box' as const,
    WebkitBoxOrient: 'vertical' as const,
    WebkitLineClamp: 2,
  },
  // R32 ViewMode 'compact': single-line layout for high-density browse.
  compactRow: {
    height: `${COMPACT_ROW_HEIGHT - 4}px`,
    padding: '6px 12px',
    border: '1px solid rgba(127, 127, 127, 0.12)',
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center' as const,
    gap: '10px',
    overflow: 'hidden' as const,
    fontSize: '12px',
  },
  compactRepoName: {
    fontWeight: 600,
    fontSize: '12.5px',
    color: 'inherit',
    textDecoration: 'none',
    flexShrink: 0,
    maxWidth: '280px',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  compactDesc: {
    flex: 1,
    minWidth: 0,
    fontSize: '11.5px',
    opacity: 0.7,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  compactMetaGroup: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '10px',
    flexShrink: 0,
    fontSize: '10.5px',
    opacity: 0.75,
  },
  compactTagCount: {
    fontSize: '10px',
    padding: '1px 5px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '8px',
    fontWeight: 500,
  },
  compactDeepIndexButton: {
    fontSize: '11px',
    padding: '2px 6px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
  },
  // R38: note UI styles. notePreview = clickable italic line above
  // footer (Card+List); noteIconButton = inline 📝 next to deep-index.
  notePreview: {
    fontSize: '11.5px',
    fontStyle: 'italic' as const,
    background: 'rgba(245, 158, 11, 0.08)',
    border: '1px solid rgba(245, 158, 11, 0.22)',
    color: 'inherit',
    borderRadius: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    width: '100%',
  },
  noteIconButton: {
    fontSize: '12px',
    padding: '2px 6px',
    border: '1px solid rgba(127, 127, 127, 0.25)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
  },
  compactNoteButton: {
    fontSize: '12px',
    padding: '1px 4px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    opacity: 0.4,
    flexShrink: 0,
  },
  compactNoteButtonHas: {
    fontSize: '12px',
    padding: '1px 4px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    opacity: 1,
    flexShrink: 0,
  },
  noteDialog: {
    // R41 fix: removed `background: 'inherit'` — it made the dialog
    // transparent against the card grid behind. Backdrop dim + opaque
    // per-theme bg now lives in manage/index.html (theme-aware via
    // prefers-color-scheme media query, which inline style can't do).
    borderRadius: '8px',
    padding: 0,
    maxWidth: '560px',
    width: '90vw',
    maxHeight: '80vh',
  },
  noteDialogForm: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    padding: '16px',
  },
  noteDialogHeader: {
    margin: 0,
    fontSize: '14px',
    fontWeight: 600,
  },
  noteDialogTextarea: {
    width: '100%',
    minHeight: '160px',
    padding: '8px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  noteDialogFooter: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  noteDialogCount: {
    fontSize: '11px',
    opacity: 0.6,
  },
  noteDialogButtons: {
    display: 'flex',
    gap: '8px',
  },
  noteDialogCancelBtn: {
    padding: '6px 12px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
  },
  noteDialogSaveBtn: {
    padding: '6px 12px',
    border: 'none',
    borderRadius: '4px',
    background: 'rgb(99, 102, 241)',
    color: 'white',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 500,
  },
  // R32 ViewModeToggle: 3-button group on FilterBar. Active mode uses
  // indigo accent matching tagChipActive; inactive uses neutral surface.
  viewModeGroup: {
    display: 'inline-flex',
    borderRadius: '6px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    overflow: 'hidden' as const,
  },
  viewModeButton: {
    fontSize: '11px',
    padding: '4px 10px',
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 500,
  },
  viewModeButtonActive: {
    fontSize: '11px',
    padding: '4px 10px',
    background: 'rgba(99, 102, 241, 0.18)',
    color: 'rgb(67, 56, 202)',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 600,
  },
  rowMeta: {
    fontSize: '10px',
    opacity: 0.55,
    flexShrink: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  deepIndexedBadge: {
    fontSize: '10px',
    padding: '2px 8px',
    background: 'rgba(34, 197, 94, 0.12)',
    color: 'rgb(22, 101, 52)',
    borderRadius: '4px',
    fontWeight: 500,
    flexShrink: 0,
  },
  deepIndexButton: {
    fontSize: '10.5px',
    padding: '3px 9px',
    border: '1px solid rgba(127, 127, 127, 0.3)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontWeight: 500,
    flexShrink: 0,
  },
} as const;
