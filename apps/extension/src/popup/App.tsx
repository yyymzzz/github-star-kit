import { useEffect, useState } from 'react';

/**
 * Day 1 popup placeholder.
 *
 * Day 5 contract: render top-10 most recently starred repos fetched from GitHub API
 * using a user-provided PAT stored in chrome.storage.local.
 */
export function App(): JSX.Element {
  const [now, setNow] = useState<string>(() => new Date().toISOString());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <main
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        minHeight: '480px',
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          GitHub Star Kit
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '12px', opacity: 0.65 }}>
          v0.0.1 · W1 Day 1 scaffold
        </p>
      </header>

      <section
        style={{
          padding: '12px',
          background: 'rgba(127, 127, 127, 0.08)',
          borderRadius: '8px',
          fontSize: '13px',
        }}
      >
        <strong>Coming W1 Day 5:</strong>
        <ul style={{ margin: '8px 0 0', paddingLeft: '18px', lineHeight: 1.6 }}>
          <li>Paste your GitHub PAT in settings</li>
          <li>See your 10 most recent starred repos</li>
          <li>Verify sync engine + storage round-trip</li>
        </ul>
      </section>

      <footer style={{ marginTop: 'auto', fontSize: '11px', opacity: 0.5 }}>
        Build alive · {now}
      </footer>
    </main>
  );
}
