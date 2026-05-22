/**
 * W1 Day 5 — popup MVP (W1 demo gate).
 *
 * Flow:
 *   1. On mount, read PAT from IndexedDBKVStore + cached stars + cursor.
 *   2. No PAT yet → render an input + Save.
 *   3. Has PAT, no cached stars → "Sync" button + empty state.
 *   4. Has PAT + cached stars → top-10 by starredAt DESC + "Sync" in header.
 *
 * Error UX: GithubError.kind → friendly text inline. No toast. No spinner
 * library — a single boolean state suffices for "syncing".
 *
 * Style: inline objects (Day 1 contract). Tailwind / shadcn enters in W3
 * when the surface area justifies it (Musk Algorithm — don't optimize what
 * isn't there).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createGithubClient,
  formatError,
  formatRelativeTime,
  formatSyncSummary,
  syncStarsWithStore,
  type StarredRepo,
  type SyncCursor,
} from '@starkit/core';
import { releaseSyncLock, tryAcquireSyncLock } from '../shared/lock.js';
import { KV_KEY_PAT, getStores } from './db.js';

/** Identifier the popup uses when grabbing the cross-context sync lock. */
const POPUP_OWNER_ID = 'popup-manual';

type SyncState = 'idle' | 'syncing';

export function App(): JSX.Element {
  // null = still loading from IDB; string = persisted value; '' = user clearing
  const [pat, setPat] = useState<string | null>(null);
  const [patDraft, setPatDraft] = useState<string>('');
  const [stars, setStars] = useState<ReadonlyArray<StarredRepo>>([]);
  const [knownCount, setKnownCount] = useState<number>(0);
  const [cursor, setCursor] = useState<SyncCursor | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  // Initial load from IDB
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { starStore, cursorStore, kvStore } = await getStores();
        const [storedPat, top, cnt, cur] = await Promise.all([
          kvStore.get<string>(KV_KEY_PAT),
          starStore.list({ limit: 10 }),
          starStore.count(),
          cursorStore.get(),
        ]);
        if (cancelled) return;
        setPat(storedPat ?? '');
        setStars(top);
        setKnownCount(cnt);
        setCursor(cur);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const onClearPat = useCallback(async () => {
    try {
      const { kvStore, starStore, cursorStore } = await getStores();
      await Promise.all([
        kvStore.delete(KV_KEY_PAT),
        starStore.clear(),
        cursorStore.clear(),
      ]);
      setPat('');
      setStars([]);
      setKnownCount(0);
      setCursor(null);
      setLastSyncSummary(null);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  const onSync = useCallback(async () => {
    if (!pat) return;
    setSyncState('syncing');
    setError(null);

    // Cross-context mutex — if the service-worker cron is mid-sync we'd
    // otherwise burn double GitHub quota. Lock auto-expires after 2 min
    // on stale to recover from evicted-worker scenarios.
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
    } catch (err) {
      setError(formatError(err));
    } finally {
      await releaseSyncLock(POPUP_OWNER_ID);
      setSyncState('idle');
    }
  }, [pat]);

  // ─── Render ────────────────────────────────────────────────────────

  if (pat === null) {
    // Initial IDB load still pending
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
        <section style={styles.card}>
          <label style={styles.label} htmlFor="pat-input">
            GitHub Personal Access Token
          </label>
          <input
            id="pat-input"
            type="password"
            placeholder="ghp_…"
            autoComplete="off"
            value={patDraft}
            onChange={(e) => setPatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSavePat();
            }}
            style={styles.input}
          />
          <p style={styles.helpText}>
            Needs <code>public_repo</code> scope (or <code>repo</code> for private
            stars). We store it in chrome IndexedDB and never transmit it
            anywhere except api.github.com.
          </p>
          <button
            type="button"
            onClick={() => void onSavePat()}
            disabled={patDraft.trim().length === 0}
            style={styles.primaryButton}
          >
            Save token
          </button>
        </section>
        {error && <ErrorBanner message={error} />}
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <Header
        subtitle={
          cursor
            ? `${knownCount} stars · last synced ${formatRelativeTime(cursor.updatedAt)}`
            : `${knownCount} stars · never synced`
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

      {stars.length === 0 ? (
        <section style={styles.card}>
          <strong>No stars cached yet.</strong>
          <p style={styles.helpText}>Click <b>Sync</b> to pull your stars from GitHub.</p>
        </section>
      ) : (
        <ol style={styles.list}>
          {stars.map((s) => (
            <li key={s.id} style={styles.listItem}>
              <a
                href={s.htmlUrl}
                target="_blank"
                rel="noreferrer"
                style={styles.repoLink}
                title={s.description ?? undefined}
              >
                <span style={styles.repoName}>{s.fullName}</span>
                {s.language && <span style={styles.repoLang}>{s.language}</span>}
              </a>
              {s.description && (
                <div style={styles.repoDesc}>{truncate(s.description, 120)}</div>
              )}
              <div style={styles.repoMeta}>
                ★ {s.stargazersCount.toLocaleString()} · starred{' '}
                {formatRelativeTime(s.starredAt)}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer style={styles.footer}>
        <button type="button" onClick={() => void onClearPat()} style={styles.linkButton}>
          Reset PAT &amp; clear cache
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

// ─── Formatters ───────────────────────────────────────────────────────
// githubErrorMessage / formatError / formatSyncSummary / formatRelativeTime
// live in @starkit/core (shared with the Obsidian plugin). `truncate` is
// popup-presentation-specific and stays local.

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

// ─── Styles (Day 1 inline contract) ───────────────────────────────────

const styles = {
  shell: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    minHeight: '480px',
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
  repoLang: {
    fontSize: '10px',
    opacity: 0.6,
    flexShrink: 0,
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
