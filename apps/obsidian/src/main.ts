/**
 * GitHub Star Kit — Obsidian community plugin (W2 Day 2).
 *
 * Mirror of the extension popup with Obsidian-idiomatic UI:
 *   - Settings tab carries the PAT input (persisted via this.saveData()).
 *   - Command palette gets "Sync GitHub stars" (Ctrl+P → search "starkit").
 *   - Same syncStarsWithStore() orchestrator the extension uses — IndexedDB
 *     in the Electron renderer is the shared storage backend.
 *
 * Out of scope (W3+): rendering stars as vault notes, daily-note digest
 * integration, vector-index based code search. v1 stops at "stars are
 * persisted locally and a Sync command exists".
 */
import {
  type App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import {
  IndexedDBCursorStore,
  IndexedDBStarStore,
  createGithubClient,
  formatError,
  formatRelativeTime,
  formatSyncSummary,
  openStarKitDb,
  syncStarsWithStore,
  type StarKitDB,
  type SyncWithStoreResult,
} from '@starkit/core';

interface StarKitPluginSettings {
  /** GitHub PAT. Empty string = not configured. */
  pat: string;
  /** ISO timestamp of last successful sync, for the settings tab display. */
  lastSyncedAt: string | null;
}

const DEFAULT_SETTINGS: StarKitPluginSettings = {
  pat: '',
  lastSyncedAt: null,
};

const OBSIDIAN_DB_NAME = 'starkit-obsidian';

export default class StarKitPlugin extends Plugin {
  settings!: StarKitPluginSettings;
  private dbPromise: Promise<StarKitDB> | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: 'starkit-sync-stars',
      name: 'Sync GitHub stars',
      callback: () => {
        void this.runSyncCommand();
      },
    });

    this.addSettingTab(new StarKitSettingTab(this.app, this));

    console.info('[starkit] obsidian plugin loaded');
  }

  override async onunload(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise.catch(() => null);
      db?.close();
      this.dbPromise = null;
    }
    console.info('[starkit] obsidian plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<StarKitPluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Lazy IDB open — only when sync is first invoked. */
  private async getDb(): Promise<StarKitDB> {
    if (!this.dbPromise) {
      this.dbPromise = openStarKitDb(OBSIDIAN_DB_NAME);
    }
    return this.dbPromise;
  }

  async runSyncCommand(): Promise<void> {
    if (!this.settings.pat) {
      new Notice('GitHub Star Kit: paste a PAT in Settings → GitHub Star Kit first.');
      return;
    }

    new Notice('GitHub Star Kit: syncing…');
    try {
      const result = await this.syncOnce();
      this.settings.lastSyncedAt = result.fetchedAt;
      await this.saveSettings();
      new Notice(formatSyncSummary(result), 5000);
    } catch (err) {
      new Notice(`GitHub Star Kit: ${formatError(err)}`, 8000);
      console.warn('[starkit] sync failed:', err);
    }
  }

  /** Exposed (non-private) so the settings tab can preview a sync result. */
  async syncOnce(): Promise<SyncWithStoreResult> {
    const db = await this.getDb();
    const starStore = new IndexedDBStarStore(db);
    const cursorStore = new IndexedDBCursorStore(db);
    const client = createGithubClient({
      token: this.settings.pat,
      userAgent: '@starkit/obsidian',
    });
    return syncStarsWithStore(client, { starStore, cursorStore });
  }
}

// ─── Settings tab ─────────────────────────────────────────────────────

class StarKitSettingTab extends PluginSettingTab {
  private readonly plugin: StarKitPlugin;

  constructor(app: App, plugin: StarKitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'GitHub Star Kit' });

    new Setting(containerEl)
      .setName('GitHub Personal Access Token')
      .setDesc(
        'Required: a PAT with `public_repo` scope (or `repo` for private stars). ' +
          'Stored locally in the plugin data file; never transmitted anywhere except api.github.com.'
      )
      .addText((text) => {
        // Mask the PAT — Obsidian's addText defaults to type=text, which
        // would leak the token to anyone glancing at the settings pane.
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text
          .setPlaceholder('ghp_…')
          .setValue(this.plugin.settings.pat)
          .onChange(async (value) => {
            this.plugin.settings.pat = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(
        this.plugin.settings.lastSyncedAt
          ? `Last sync: ${formatRelativeTime(this.plugin.settings.lastSyncedAt)}`
          : 'No sync yet.'
      )
      .addButton((btn) =>
        btn
          .setButtonText('Sync stars')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true).setButtonText('Syncing…');
            try {
              await this.plugin.runSyncCommand();
            } finally {
              this.display(); // re-render to refresh "Last sync" line
            }
          })
      );
  }
}

// Presentation helpers (githubErrorMessage / formatSyncSummary /
// formatRelativeTime / formatError) live in @starkit/core so the popup and
// this plugin can't drift apart.
