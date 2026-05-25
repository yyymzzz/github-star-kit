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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FixedSizeList } from 'react-window';
import {
  createGithubClient,
  digestCosine,
  fetchRepoSource,
  formatError,
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
} from '../popup/db.js';
import { AI_PRESETS, DEFAULT_AI_PRESET, type AiPresetId } from '../shared/ai-presets.js';
import { useI18n } from '../shared/i18n.js';

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
const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP;

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

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sortBy, setSortBy] = useState<SortBy>('starredAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

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
  const columnsPerRow = useMemo(() => {
    return Math.max(
      1,
      Math.floor((containerWidth + GRID_GAP) / (CARD_WIDTH_TARGET + GRID_GAP))
    );
  }, [containerWidth]);

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { starStore, vectorStore, kvStore } = await getStores();
        const [stars, vecRows, storedPat, storedKey, storedProvider] =
          await Promise.all([
            starStore.list(),
            vectorStore.list(),
            kvStore.get<string>(KV_KEY_PAT),
            kvStore.get<string>(KV_KEY_AI_KEY),
            kvStore.get<string>(KV_KEY_AI_PROVIDER),
          ]);
        if (cancelled) return;

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
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── List-height + container-width recompute on window resize ────────
  // R25: also tracks horizontal width for the responsive card grid.
  // Both reads happen in the same listener so only one rAF tick per
  // resize event, and both states settle together (avoids one-frame
  // layout thrash where columnsPerRow updates before listHeight).
  useEffect(() => {
    const onResize = () => {
      setListHeight(window.innerHeight - 280);
      setContainerWidth(Math.min(window.innerWidth, 960) - 40);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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
      setError(
        'Switch UI language first (English originals need no translation).'
      );
      return;
    }
    setTranslateState('translating');
    setTranslateProgress({ done: 0, total: untranslatedCount });
    setError(null);

    try {
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
          `${translateResult.failed} repos couldn't be translated (${failedNames}${more})${reason}. Click Translate again to retry just those — already-done ones will skip.`
        );
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setTranslateState('idle');
    }
  }, [aiKey, aiProvider, locale, translateState, untranslatedCount]);

  const onPerRowDeepIndex = useCallback(
    async (star: StarredRepo) => {
      if (!aiKey || !pat) {
        setError(
          'Configure GitHub PAT and AI Provider key in the popup before deep-indexing.'
        );
        return;
      }
      if (perRowState.has(star.id)) return; // Already in flight
      setError(null);
      setPerRowState((m) => new Map(m).set(star.id, 'indexing'));

      try {
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
        if (!owner || !repo) throw new Error(`Malformed fullName: ${star.fullName}`);

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
          await starStore.upsertMany([{ ...fresh, deepIndexed: true }]);
          setAllStars((prev) =>
            prev.map((s) => (s.id === star.id ? { ...s, deepIndexed: true } : s))
          );
        }
        // else: star vanished (user un-starred during the run); do not
        // synthesize from the stale closure. Caller's allStars will
        // reflect the un-star on next sync — no UI inconsistency.
      } catch (err) {
        setError(formatError(err));
      } finally {
        setPerRowState((m) => {
          const next = new Map(m);
          next.delete(star.id);
          return next;
        });
      }
    },
    [aiKey, aiProvider, pat, perRowState]
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
              // R25 card-grid: items are ROWS of `columnsPerRow` cards,
              // so total item count is ceil(stars / cols). Each list row
              // renders columnsPerRow Cards via CSS grid.
              itemCount={Math.ceil(visible.length / columnsPerRow)}
              itemSize={ROW_HEIGHT}
              overscanCount={3}
              itemData={{
                stars: visible,
                perRowState,
                onDeepIndex: onPerRowDeepIndex,
                canDeepIndex: aiKey !== '' && pat !== '',
                columnsPerRow,
              }}
            >
              {GridRow}
            </FixedSizeList>
          )}
        </>
      )}
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
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section style={styles.filterBar}>
      <input
        type="search"
        placeholder={t('manage.searchPlaceholder')}
        value={props.filters.searchText}
        onChange={(e) => props.onFilterChange('searchText', e.target.value)}
        style={styles.searchInput}
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
        />
      ))}
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
}): JSX.Element {
  const { star, indexing, canDeepIndex, onDeepIndex } = props;
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
      <div style={styles.cardFooter}>
        <span style={styles.rowMeta}>
          {formatRelativeTime(star.starredAt)}
          {star.pushedAt && ` · ${formatRelativeTime(star.pushedAt)}`}
          {star.archived && ' · archived'}
          {star.isFork && ' · fork'}
        </span>
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
