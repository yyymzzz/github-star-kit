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
 *   - MVP filters (subagent-approved scope): language dropdown +
 *     archived/fork toggles + text search. Tag + topic + pushedAt window
 *     + relevance sort deferred to v0.2.
 *   - MVP sorts: starredAt / pushedAt / stargazersCount × asc / desc.
 *     All three orderBy values already exist in StarStoreListOptions; this
 *     page is pure UI plumbing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { formatError, formatRelativeTime, type StarredRepo } from '@starkit/core';
import { getStores } from '../popup/db.js';

type SortBy = 'starredAt' | 'pushedAt' | 'stargazersCount';
type SortOrder = 'asc' | 'desc';

interface Filters {
  readonly language: string; // '' = all
  readonly hideArchived: boolean;
  readonly hideForks: boolean;
  readonly searchText: string;
}

const DEFAULT_FILTERS: Filters = {
  language: '',
  hideArchived: true,
  hideForks: true,
  searchText: '',
};

/** Row height — tall enough for repo name + 2-line description + meta + tag chips. */
const ROW_HEIGHT = 124;

export function Manage(): JSX.Element {
  const [allStars, setAllStars] = useState<ReadonlyArray<StarredRepo>>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sortBy, setSortBy] = useState<SortBy>('starredAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const [listHeight, setListHeight] = useState<number>(
    typeof window !== 'undefined' ? window.innerHeight - 220 : 600
  );

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { starStore } = await getStores();
        const stars = await starStore.list();
        if (cancelled) return;
        setAllStars(stars);
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

  // ─── List-height recompute on window resize ───────────────────────────
  useEffect(() => {
    const onResize = () => setListHeight(window.innerHeight - 220);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ─── Language facets — computed ONCE per data load, not per filter ────
  const languageFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allStars) {
      const lang = s.language ?? '(none)';
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    // Sort by count desc so the dropdown shows most-common first.
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
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
      return true;
    });

    // Sort. starredAt / pushedAt are ISO-8601 strings — lex sort is the
    // same as chronological sort because both end with Z. stargazersCount
    // is numeric. pushedAt can be null; sort nulls to the end regardless
    // of order direction so they don't pollute the top.
    const factor = sortOrder === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      if (sortBy === 'stargazersCount') {
        return factor * (a.stargazersCount - b.stargazersCount);
      }
      const av = a[sortBy];
      const bv = b[sortBy];
      // Null handling — push nulls to bottom in either order direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return 0;
      return factor * (av < bv ? -1 : 1);
    });
    return filtered;
  }, [allStars, filters, sortBy, sortOrder]);

  // ─── Handlers ─────────────────────────────────────────────────────────
  const onFilterChange = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <main style={styles.shell}>
        <Header subtitle="Loading your starred repos…" />
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <Header
        subtitle={
          allStars.length === 0
            ? 'No stars cached yet — open the popup and click Sync first.'
            : `Showing ${visible.length.toLocaleString()} of ${allStars.length.toLocaleString()} stars`
        }
      />

      {error && (
        <div role="alert" style={styles.errorBanner}>
          ⚠ {error}
        </div>
      )}

      {allStars.length > 0 && (
        <>
          <FilterBar
            filters={filters}
            languageFacets={languageFacets}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onFilterChange={onFilterChange}
            onSortByChange={setSortBy}
            onSortOrderChange={setSortOrder}
          />

          {visible.length === 0 ? (
            <section style={styles.emptyCard}>
              <strong>No stars match these filters.</strong>
              <p style={styles.helpText}>
                Try clearing the search box, switching language to "All", or
                toggling "Hide archived" / "Hide forks" off.
              </p>
            </section>
          ) : (
            <FixedSizeList
              height={listHeight}
              width="100%"
              itemCount={visible.length}
              itemSize={ROW_HEIGHT}
              overscanCount={6}
              itemData={visible}
            >
              {Row}
            </FixedSizeList>
          )}
        </>
      )}
    </main>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function Header(props: { readonly subtitle: string }): JSX.Element {
  return (
    <header style={styles.header}>
      <h1 style={styles.title}>🌟 GitHub Star Kit · Manage</h1>
      <p style={styles.subtitle}>{props.subtitle}</p>
    </header>
  );
}

function FilterBar(props: {
  readonly filters: Filters;
  readonly languageFacets: ReadonlyArray<readonly [string, number]>;
  readonly sortBy: SortBy;
  readonly sortOrder: SortOrder;
  readonly onFilterChange: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  readonly onSortByChange: (v: SortBy) => void;
  readonly onSortOrderChange: (v: SortOrder) => void;
}): JSX.Element {
  return (
    <section style={styles.filterBar}>
      <input
        type="search"
        placeholder="Filter by name or description…"
        value={props.filters.searchText}
        onChange={(e) => props.onFilterChange('searchText', e.target.value)}
        style={styles.searchInput}
      />
      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>
          Language:
          <select
            value={props.filters.language}
            onChange={(e) => props.onFilterChange('language', e.target.value)}
            style={styles.filterControl}
          >
            <option value="">All ({props.languageFacets.reduce((a, [, c]) => a + c, 0)})</option>
            {props.languageFacets.map(([lang, count]) => (
              <option key={lang} value={lang}>
                {lang} ({count})
              </option>
            ))}
          </select>
        </label>

        <label style={styles.filterLabel}>
          Sort by:
          <select
            value={props.sortBy}
            onChange={(e) => props.onSortByChange(e.target.value as SortBy)}
            style={styles.filterControl}
          >
            <option value="starredAt">Recently starred</option>
            <option value="pushedAt">Recently pushed</option>
            <option value="stargazersCount">Most stars</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() =>
            props.onSortOrderChange(props.sortOrder === 'desc' ? 'asc' : 'desc')
          }
          style={styles.sortDirButton}
          title={`Currently ${props.sortOrder.toUpperCase()} — click to flip`}
        >
          {props.sortOrder === 'desc' ? '↓' : '↑'}
        </button>

        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={props.filters.hideArchived}
            onChange={(e) => props.onFilterChange('hideArchived', e.target.checked)}
          />
          Hide archived
        </label>

        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={props.filters.hideForks}
            onChange={(e) => props.onFilterChange('hideForks', e.target.checked)}
          />
          Hide forks
        </label>
      </div>
    </section>
  );
}

/** Single row inside react-window's FixedSizeList. Receives star data via
 *  itemData prop on the parent List — index is the position into that array. */
function Row(props: {
  readonly index: number;
  readonly style: React.CSSProperties;
  readonly data: ReadonlyArray<StarredRepo>;
}): JSX.Element {
  const star = props.data[props.index]!;
  return (
    <div style={{ ...props.style, padding: '0 4px' }}>
      <div style={styles.rowCard}>
        <div style={styles.rowHeader}>
          <a
            href={star.htmlUrl}
            target="_blank"
            rel="noreferrer"
            style={styles.repoName}
            title={star.description ?? undefined}
          >
            {star.fullName}
          </a>
          <div style={styles.rowHeaderRight}>
            {star.language && <span style={styles.lang}>{star.language}</span>}
            <span style={styles.stars}>★ {star.stargazersCount.toLocaleString()}</span>
          </div>
        </div>
        {star.description && <p style={styles.rowDesc}>{star.description}</p>}
        <div style={styles.rowFooter}>
          {star.aiTags.length > 0 && (
            <div style={styles.tagRow}>
              {star.aiTags.slice(0, 5).map((t) => (
                <span key={t} style={styles.tagChip}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <span style={styles.rowMeta}>
            starred {formatRelativeTime(star.starredAt)}
            {star.pushedAt && ` · pushed ${formatRelativeTime(star.pushedAt)}`}
            {star.archived && ' · archived'}
            {star.isFork && ' · fork'}
            {star.deepIndexed && ' · 🔧 deep-indexed'}
          </span>
        </div>
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
    minWidth: '160px',
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
  rowCard: {
    height: `${ROW_HEIGHT - 8}px`,
    padding: '10px 14px',
    border: '1px solid rgba(127, 127, 127, 0.15)',
    borderRadius: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    overflow: 'hidden' as const,
  },
  rowHeader: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'baseline' as const,
    gap: '8px',
  },
  rowHeaderRight: {
    display: 'flex',
    gap: '10px',
    fontSize: '11px',
    opacity: 0.7,
    flexShrink: 0,
  },
  repoName: {
    fontWeight: 600,
    fontSize: '14px',
    color: 'inherit',
    textDecoration: 'none',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  lang: { fontSize: '11px' },
  stars: { fontSize: '11px', fontFamily: 'ui-monospace, monospace' },
  rowDesc: {
    margin: 0,
    fontSize: '12px',
    opacity: 0.8,
    lineHeight: 1.4,
    overflow: 'hidden' as const,
    display: '-webkit-box' as const,
    WebkitBoxOrient: 'vertical' as const,
    WebkitLineClamp: 2,
  },
  rowFooter: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '8px',
    marginTop: 'auto',
  },
  tagRow: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap' as const,
    overflow: 'hidden' as const,
  },
  tagChip: {
    fontSize: '10px',
    padding: '1px 6px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'rgb(67, 56, 202)',
    borderRadius: '10px',
    fontWeight: 500,
  },
  rowMeta: {
    fontSize: '10px',
    opacity: 0.55,
    flexShrink: 0,
  },
} as const;
