import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { I18nProvider, type LocaleId } from '../shared/i18n.js';
import { KV_KEY_LOCALE, getStores } from './db.js';

/**
 * Async mount: read the persisted locale from IDB before rendering so the
 * popup never flashes English-then-Chinese on a Chinese-locale install.
 * IDB reads are <5ms in practice; the bare loading splash users see is
 * imperceptible. Once loaded, the I18nProvider's onLocaleChange writes
 * locale picks back through kvStore so the choice survives popup reopens.
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Popup root element #root not found in DOM');
  }
  const root = createRoot(container);

  // Best-effort: if KV read fails (first run, IDB blocked), fall through
  // with `undefined` so the provider auto-detects from navigator.language.
  let initial: LocaleId | undefined;
  try {
    const { kvStore } = await getStores();
    const stored = await kvStore.get<LocaleId>(KV_KEY_LOCALE);
    if (stored) initial = stored;
  } catch {
    // Swallow — auto-detect fallback is good enough for the first paint.
  }

  const onLocaleChange = (id: LocaleId): void => {
    // Fire-and-forget persistence. The Provider already updated its own
    // state; a failed write just means next mount re-detects from
    // navigator.language, which is acceptable degradation.
    void (async () => {
      try {
        const { kvStore } = await getStores();
        await kvStore.set(KV_KEY_LOCALE, id);
      } catch {
        // Same swallow — language picker still works in-session.
      }
    })();
  };

  root.render(
    <React.StrictMode>
      <I18nProvider
        {...(initial !== undefined ? { initial } : {})}
        onLocaleChange={onLocaleChange}
      >
        <App />
      </I18nProvider>
    </React.StrictMode>
  );
}

void bootstrap();
