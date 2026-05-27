# GitHub Star Kit

> AI-powered intelligence for your GitHub stars: never forget what you starred and why.

**Status**: ✅ **v0.1.0 release-ready** — full v1 AI surface ships across two apps with **572 contract tests green**, 6-package typecheck + extension build clean, end-to-end demo-gate smokes passing. Chrome Web Store package built (`dist-store/starkit-extension-v0.1.0.zip`, 536 KB). Privacy policy auto-deployed via GitHub Pages. Submission checklist at [`docs/NEXT_SESSION.md`](./docs/NEXT_SESSION.md).

## What it does

A dual-form productivity tool for developers drowning in their own GitHub stars:

- 🔍 **Semantic search** — type "rust async runtime" instead of remembering the repo name; top-5 hits in <500ms via local IndexedDB-backed vector store
- 🤖 **Auto-tag** every starred repo with 3–5 LLM-generated tags so the chips you see actually describe what the repo does (~$0.06 to tag 1000 stars on `gpt-4o-mini`)
- 📰 **Personalized AI weekly digest** — ranked feed of what's actually new in repos you starred, filtered by relevance to your interest profile, each entry with a 1-sentence "why this matters" hook
- 🔧 **Deep-Index Code** — opt-in per repo: pulls top source files, splits into ~600-token chunks, embeds them. Now your popup search also returns CODE snippets with file path + GitHub permalink. Try "debounce function" or "prepare SQL".
- 🌐 **Translate to 11 Languages** — descriptions + AI tags translated to zh-CN / zh-TW / ja / ko / de / fr / es / pt-BR / ru / vi via your provider. R50 single-source-of-truth `needsTranslation` helper detects content already in the target locale and skips redundant LLM calls (zero-cost cache backfill).
- 📝 **Private Notes** — add a private memo to any starred repo. Stays on your device — GitHub never sees it.
- ⚙️ **Multi-Provider AI** — OpenAI · Anthropic · Voyage · SiliconFlow · DashScope · Ollama (self-hosted). Bring your own key; switch any time. R48 provider-switch guard auto-resets the vector store on embed-model change so dim mismatches never crash search.
- ⌨️ **Power features** — `Ctrl+Shift+Y` opens the popup from anywhere; `Cmd/Ctrl+K` or `/` focuses the search bar; 3 manage-page density modes (Cards / List / Compact); Cancel button on every long-running op.

Two surfaces, one shared core:

- **Browser extension** (Manifest V3, Chrome / Edge 116+, Firefox 120+)
- **Obsidian plugin** (community plugin, BRAT-installable today)

## How to use (extension)

1. **Install** — load `apps/extension/dist/` unpacked in `chrome://extensions` (developer mode) OR install the published zip from the Chrome Web Store *(submission in progress)*.
2. Click the toolbar icon → paste your **GitHub Personal Access Token** (`public_repo` scope for public stars, `repo` for private). Stored locally in the extension's own IndexedDB origin; only ever sent to `api.github.com`.
3. Click **Sync** — pulls your starred repos via GitHub's `/user/starred` API with ETag caching. Subsequent syncs are incremental + delta-only.
4. Pick a provider and paste your **AI API key**. Defaults to SiliconFlow (China-region). Keys are stored locally; only ever sent to the chosen provider's host.
5. Click **🔍 Build search index** → embeds every star's metadata (~$0.01 for 1000 stars on `text-embedding-3-small`). Progress bar shows live; Cancel button stops mid-batch.
6. **Search** anything: `rust async runtime`, `react state management`, `kubernetes operator`. The top-5 hits render with cosine score badges.
7. Click **🤖 Auto-tag N repos** → batch LLM call generates 3–5 tags per repo. Tag chips render under each card.
8. Click **📰 Weekly digest** → top-10 recently-pushed-in-the-last-7-days repos ranked by relevance to your interest profile, each with a 1-sentence "why this matters" hook (~$0.001 per digest run).
9. Click **🔧 Deep-index top N** (popup) or per-row 🔧 button (manage) → fetches source from selected repos and embeds chunks. Search then returns code snippets with file:line GitHub permalinks. R48 result-guard surfaces zero-chunk runs (whitelist mismatch / quota errors) instead of silently marking the repo "done".
10. Click **🌐 翻译 N 个** (or your locale's equivalent) → translates description + AI tags to your UI language. R50 single-truth helper means same-language content (e.g. Chinese tags + zh-CN locale) costs zero LLM calls.
11. **Manage page** (toolbar icon → opens full tab): card / list / compact density modes, AI tag chip filters, relevance sort, per-row delete / translate / deep-index / note actions, full keyboard shortcuts.
12. **Reset keys & clear cache** wipes everything if you ever want to start over (preserves stars + notes; clears tokens + vectors + i18n cache).

## Screenshots

*(To be captured before CWS submission — see [`docs/NEXT_SESSION.md`](./docs/NEXT_SESSION.md) for the exact 3 shots needed.)*

- Popup with mixed star + code search results
- Popup with weekly digest panel + AI summaries
- Manage page card grid with AI tags + localized descriptions

## Architecture

Local-first. BYOK (Bring Your Own Key). No backend in v1.

```
packages/
  core/      GitHub sync, schemas, embed / tag / digest / code / translate orchestrators
             + R50 translate/needs.ts (single source of truth for "needs translation")
  ai/        Provider adapters (OpenAI / Anthropic / Voyage / SiliconFlow / DashScope / Ollama)
  vector/    VectorStore interface + MemoryVectorStore + IndexedDBVectorStore
             + R51 deleteByPrefix (O(matched) un-star cleanup)
  ui/        Shared React + Tailwind components
apps/
  extension/ MV3 WebExtension (popup + manage tab + service worker + chrome.alarms cron)
  obsidian/  Obsidian community plugin
```

Every AI pipeline (`embedStars`, `tagStars`, `generateDigest`, `summarizeDigestEntries`, `indexRepoCode`, `translateStars`) is **callback-decoupled** so `@starkit/core` stays free of `@starkit/ai` / `@starkit/vector` workspace deps — the popup / Obsidian plugin wires `AIProvider.embed` + `VectorStore.upsertMany` + `Octokit` at the boundary. Same pattern across all six orchestrators; learn one, you've learned them all.

IDB schema currently at **v2** (`stars` + `kv` + `cursor` + `vectors`). Additive-only upgrade handler with explicit regression test for the v1→v2 data-preservation path.

Cross-tab safety: every write path (sync, embed, tag, translate, per-row deep-index, note edit) is wrapped in `withSyncLock(OWNER_ID, ...)` with 2-minute TTL stale-take recovery. Cron + popup + manage tabs cannot last-write-wins clobber each other.

## Privacy & data handling

- Every secret (PAT, AI keys) lives in the extension's own IndexedDB origin. Never logged. Never sent to anything but `api.github.com` and the AI host you configured.
- **Zero telemetry.** No analytics SDKs, no error reporting beacons, no usage pings.
- No content scripts on github.com — the extension never sees pages you visit; it only calls the GitHub REST API with your token.
- Full privacy policy at [`docs/privacy-policy.md`](./docs/privacy-policy.md) (also published at the Pages URL listed in `docs/STORE_LISTING.md`). Data-handling matrix in [`docs/STORE_LISTING.md`](./docs/STORE_LISTING.md).

## Strategy

Not a fork. **Reference-and-rewrite** from upstream [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager) — borrow the AI provider abstraction and GitHub sync ideas, rewrite clean without the server coupling. See [`docs/STRATEGY.md`](./docs/STRATEGY.md) for the falsification audit + competitive scan that defined the blue-ocean P0 angles (weekly digest + code-context search).

## Roadmap

- **W1** ✅ — Foundation: monorepo + extension popup MVP
- **W2** ✅ — Sync engine + local storage (1000+ stars)
- **W3** ✅ — README semantic search + auto-tag
- **W4** ✅ — 🟢 **P0**: Personalized AI weekly digest
- **W5** ✅ — 🟢 **P0**: Code context search (deep-index)
- **W6** ✅ — Manage page + i18n (11 locales) + translate pipeline + R20–R36 hardening rounds
- **v0.1.0** ✅ — Release prep: privacy policy + Pages deploy + manifest icons + CWS package (5 audit rounds R42–R51 closed all P0/P1 bugs)
- **v0.1.1** (next) — Submit to Chrome Web Store · Obsidian community plugin submission · Firefox/Edge port

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for week-by-week deliverables and the post-shipping backlog.

## Develop

```bash
pnpm install
pnpm test          # 572 tests across 6 workspaces
pnpm -r typecheck  # 6 workspace projects
pnpm -r build      # extension dist + obsidian main.js + core/ai/vector/ui d.ts
pnpm --filter @starkit/extension dev   # vite dev server for popup
pnpm extension:package                 # build + zip for Chrome Web Store
```

CI (`.github/workflows/ci.yml`) runs typecheck + test + build on every push / PR to `main`. Pages (`pages.yml`) auto-deploys `docs/site/` on changes.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

Conceptual debt to [Astral](https://astralapp.com/), [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager), and [Stardex](https://github.com/BjornMelin/stardex) — none of whose code is included, but whose product thinking informed this design.
