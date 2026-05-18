import { Plugin } from 'obsidian';

/**
 * GitHub Star Kit — Obsidian community plugin entry.
 *
 * Day 1 status: scaffolding. Real responsibilities land W2 (sync command),
 * W4 (weekly digest as daily notes), W5 (code search view).
 */
export default class StarKitPlugin extends Plugin {
  override async onload(): Promise<void> {
    console.info('[starkit] obsidian plugin loaded');

    this.addCommand({
      id: 'starkit-sync-stars',
      name: 'Sync GitHub stars (W2 placeholder)',
      callback: () => {
        console.info('[starkit] sync command invoked — W2 will implement');
      },
    });
  }

  override async onunload(): Promise<void> {
    console.info('[starkit] obsidian plugin unloaded');
  }
}
