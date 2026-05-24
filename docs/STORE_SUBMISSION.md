# Store submission — v1 release checklist

Reference for the Chrome Web Store / Firefox AMO / Obsidian community-plugin
submissions. Each gate represents a concrete artifact the store reviewer (or
the Obsidian plugin-review bot) expects.

This file is a living checklist, not a how-to: every line either points at
the source of truth in the repo or names an artifact we'll produce when
v1 is ready to ship.

---

## Chrome Web Store

**Target listing URL:** https://chrome.google.com/webstore/detail/{id} (allocated on first submission)

### Manifest & permissions (already audited)

- [x] `manifest_version: 3` — required since Jun 2024.
- [x] `minimum_chrome_version: "116"` — covers all Chrome ≥ Aug 2023.
- [x] **Only requested permissions in use** (R10 蓝军 audit):
  - `storage` — IndexedDB / chrome.storage.local for PAT, OpenAI key, sync lock.
  - `alarms` — 6h periodic sync (`src/background/service-worker.ts`).
- [x] **host_permissions narrowed** to `https://api.github.com/*` only.
  GitHub's HTML site is NOT accessed from the extension; the previous
  scaffolding content script was removed in commit `3b27d31`.
- [x] **optional_host_permissions** for `api.openai.com` / `api.anthropic.com` /
  `api.voyageai.com` / `localhost` — the user grants these only when they
  configure a provider key.

### Privacy disclosures (review-time required)

Single answer to every question: **the extension talks to GitHub + the
user's chosen AI provider; everything else stays on the device.**

| Data type | Collected? | Sent where? |
|---|---|---|
| GitHub PAT | Stored in IndexedDB (extension origin only) | Only to `api.github.com`. Never logged. |
| OpenAI API key | Stored in IndexedDB (extension origin only) | Only to `api.openai.com`. Never logged. |
| Starred repo metadata (descriptions, topics, languages, pushed_at) | Cached locally in IndexedDB after sync | Submitted to the configured embedding / chat provider as part of `embed()` / `chat()` calls — same content the user could `curl` from GitHub. |
| Source code from deep-indexed repos | Cached locally after `Deep-index` opt-in | Submitted as embed inputs to the configured provider. |
| Telemetry / analytics | **None** | — |
| Account / sign-in | **None** | — |

The privacy form's "Single purpose" answer: **personal-use AI intelligence
layer on top of the user's GitHub stars** — semantic search, automatic
tagging, personalized weekly digest, and code-context search across
opted-in repositories.

### Listing assets (W6 D2 to-produce)

- [ ] Icon set (16 / 32 / 48 / 128 px) — `apps/extension/icons/`.
      v0 manifest doesn't include icons; ship them before submission.
- [ ] 1280×800 promotional screenshot — popup with sample search results.
- [ ] 1280×800 — popup showing weekly digest with summaries.
- [ ] 1280×800 — popup showing code-search hit with permalink.
- [ ] 440×280 small promo tile.
- [ ] ≤ 132-char short description (already in `manifest.json`'s
      `description`; lift verbatim).
- [ ] Long description (markdown OK in listing UI). Source:
      `README.md` → "What this is" + "How to use" sections.

### Build artifact

```bash
pnpm --filter @starkit/extension build
cd apps/extension && zip -r ../starkit-extension-v0.0.1.zip dist/
```

Upload `starkit-extension-v0.0.1.zip` to the store dashboard. Manifest
`version` (currently `0.0.1`) must increment on every re-submission.

---

## Firefox Add-ons (AMO)

The Vite + crxjs build produces a manifest v3 dist that Firefox 120+ accepts.

- [ ] Run the same `pnpm extension:build`.
- [ ] AMO requires the manifest's `browser_specific_settings.gecko.id` field
      for re-uploads. Add when first submitting; not yet present.
- [ ] Submit unlisted at first (self-distributed signed XPI) → flip to
      listed once Chrome listing is up and we have screenshots.

---

## Obsidian Community Plugins

**Target listing:** https://github.com/obsidianmd/obsidian-releases

### Submission process

1. Fork `obsidianmd/obsidian-releases`.
2. Add an entry to `community-plugins.json`:
   ```json
   {
     "id": "starkit",
     "name": "GitHub Star Kit",
     "author": "yyymzzz",
     "description": "AI-powered intelligence for your GitHub stars: sync to vault, semantic search, weekly digest as daily notes.",
     "repo": "yyymzzz/github-star-kit"
   }
   ```
3. Open a PR against `obsidianmd/obsidian-releases`. The Obsidian review bot
   runs automated checks (manifest validation, allowed-API audit). Plan for
   1–4 weeks of human review on top.

### Pre-submission gates

- [x] `apps/obsidian/manifest.json` has `id`, `name`, `version`,
      `minAppVersion: 1.5.0`, `description`, `author`, `main: main.js`.
- [ ] Add `apps/obsidian/versions.json` (already exists, verify content).
- [ ] Ship a github tag matching `manifest.json.version` (`v0.0.1`).
      Obsidian's bot downloads the release artifact.
- [ ] BRAT install path documented in README so beta users can install
      before AMO/CWS review completes.

### Build artifact

```bash
pnpm --filter @starkit/obsidian build
# Produces apps/obsidian/main.js, optionally styles.css.
# Attach main.js + manifest.json + (versions.json) to a GitHub release.
```

---

## Cross-cutting

### Versioning

`v0.0.1` is the working pre-release version. Bump to `v0.1.0` for first
public store submission once all the listing assets are in. Use the same
version string across:

- `package.json` (root)
- `apps/extension/manifest.json`
- `apps/obsidian/manifest.json`
- `apps/obsidian/versions.json`
- GitHub release tag

A future `scripts/bump-version.mjs` can keep them in lockstep — defer
until v0.2 cycle.

### Required pre-submit verification

1. `pnpm install --frozen-lockfile` — clean install passes.
2. `pnpm typecheck` — all workspaces green.
3. `pnpm test` — 412+ tests green (latest count in README badge).
4. `pnpm build` — extension + obsidian artifacts produced without warnings.
5. Manual smoke (per `verify` skill / `scripts/manual-smoke.md` if added):
   - Install unpacked in Chrome.
   - Paste a PAT → "Sync" → see top-10 stars.
   - Paste an OpenAI key → "Build search index" → wait for completion.
   - Type a query → see results, click → land on the right GitHub page.
   - "Auto-tag N repos" → wait → tags render under each repo.
   - "Weekly digest" → entries appear with score badges.
   - "Deep-index top 3" → wait → search "debounce" → code hits appear with
     permalinks → click → land on the right `#L` range on GitHub.
   - "Reset keys & clear cache" → confirm everything wipes cleanly.

### What we explicitly do NOT do (anti-claim list for reviewers)

- No telemetry, no analytics, no error reporting to any 3rd party.
- No background fetches to any host besides `api.github.com` + the user's
  configured provider host.
- No content scripts injected into web pages.
- No off-device key storage (all keys live in the extension's IndexedDB
  origin and chrome.storage.local).
- No automatic prompt rewriting or content modification on the user's
  GitHub pages.

This file is part of the v1 release submission package. If you're a store
reviewer following this from the listing, the codebase lives at
https://github.com/yyymzzz/github-star-kit.
