import React from 'react';
import { createRoot } from 'react-dom/client';
import { Manage } from './Manage.js';
import { I18nProvider, type LocaleId } from '../shared/i18n.js';
import { KV_KEY_LOCALE, getStores } from '../popup/db.js';

/**
 * Same async-locale-load pattern as popup/main.tsx — read the persisted
 * locale before first paint so the manage page renders in the user's
 * picked language. The manage page itself doesn't expose a language
 * picker (that lives in the popup settings card); changes propagate the
 * next time the manage tab is reopened or refreshed.
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Manage root element #root not found in DOM');
  }
  const root = createRoot(container);

  let initial: LocaleId | undefined;
  try {
    const { kvStore } = await getStores();
    const stored = await kvStore.get<LocaleId>(KV_KEY_LOCALE);
    if (stored) initial = stored;
  } catch {
    // Auto-detect fallback.
  }

  root.render(
    <React.StrictMode>
      <I18nProvider {...(initial !== undefined ? { initial } : {})}>
        <Manage />
      </I18nProvider>
    </React.StrictMode>
  );
}

void bootstrap();
