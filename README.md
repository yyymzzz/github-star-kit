# github-star-kit

> AI-powered GitHub Star intelligence: never forget what you starred and why.

**Status**: ✅ **W3 + W4 + W5 complete · W6 polish in progress** — full v1 AI surface ships: semantic search ("rust async runtime" → top-5 in <500ms), personalized weekly digest with LLM "why this matters" hooks (the blue-ocean P0 angle), auto-tag (gpt-4o-mini, 3-5 tags/repo), and **deep-indexed code search** ("debounce hook" → 5 code snippets with file paths, line ranges, and GitHub permalinks). **412 contract tests green** + 2 end-to-end demo-gate smokes. CI gates typecheck + test + build on every push/PR. Store submission checklist at [`docs/STORE_SUBMISSION.md`](./docs/STORE_SUBMISSION.md).

## What it does

A dual-form productivity tool for developers drowning in their own GitHub stars:

- 🟢 **Semantic search** over your starred repos — type "rust async runtime" instead of remembering the repo name
- 🟢 **Auto-tag** every starred repo with 3-5 LLM-generated tags so the chips you see actually describe what the repo does
- 🟢 **Personalized AI weekly digest** — ranked feed of what's actually new in repos you starred, filtered by relevance to your interest profile, each entry with a 1-2 sentence "why this matters" hook
- 🟢 **Code Context Search** — opt-in deep-index of starred repos' source files, then natural-language search across the code with file:line permalinks

Two surfaces, one shared core:

- **Browser extension** (Manifest V3, Chrome — Firefox/Edge support land in W6+)
- **Obsidian plugin** (community plugin, BRAT-installable today)

## How to use (extension)

1. Install from the Chrome Web Store *(coming in W6)* — or load `apps/extension/dist/` unpacked.
2. Click the toolbar icon → paste your **GitHub Personal Access Token** (only `public_repo` scope needed for public stars; `repo` for private). Stored locally; only ever sent to `api.github.com`.
3. Click **Sync** — pulls your starred repos via GitHub's `/user/starred` API with ETag caching. Subsequent syncs are incremental.
4. Paste an **OpenAI API key** (the only AI feature that requires one — Claude / Voyage / Ollama support is provider-pluggable; UI for that lands in v0.2). Stored locally; only ever sent to `api.openai.com`.
5. Click **Build search index** → embeds every star's metadata (~$0.02 for 1000 stars on `text-embedding-3-small`). Progress bar shows live.
6. **Search** anything: `rust async runtime`, `react state management`, `kubernetes operator`. The top-5 hits render with cosine score badges.
7. Click **Auto-tag N repos** → batch LLM call generates 3-5 tags per repo (~$0.06 for 1000 stars on `gpt-4o-mini`). Tag chips render under each repo.
8. Click **📰 Weekly digest** → top-10 recently-pushed-in-the-last-7-days repos ranked by relevance to your interest profile, each with a 1-2 sentence "why this matters" hook (~$0.001 per digest run).
9. Click **🔧 Deep-index top 3** → fetches source from the 3 most-starred unindexed repos and embeds their code so semantic search returns chunks with file:line permalinks to GitHub.
10. **Reset keys & clear cache** wipes everything if you ever want to start over.

## Architecture

Local-first. BYOK (Bring Your Own Key). No backend in v1.

```
packages/
  core/      GitHub sync, schemas, embedding / tagging / digest / code orchestrators
  ai/        Provider adapters (OpenAI / Anthropic / Voyage / Ollama / openai-compatible)
  vector/    VectorStore interface + MemoryVectorStore + IndexedDBVectorStore
  ui/        Shared React + Tailwind components
apps/
  extension/ MV3 WebExtension (popup + service worker + chrome.alarms cron)
  obsidian/  Obsidian community plugin
```

Every AI pipeline (`embedStars`, `tagStars`, `generateDigest`, `summarizeDigestEntries`, `indexRepoCode`) is **callback-decoupled** so `@starkit/core` stays free of `@starkit/ai` / `@starkit/vector` workspace deps — the popup / Obsidian plugin wires `AIProvider.embed` + `VectorStore.upsertMany` + `Octokit` at the boundary. Same pattern across all five orchestrators; learn one, you've learned them all.

IDB schema currently at **v2** (`stars` + `kv` + `cursor` + `vectors`). Additive-only upgrade handler with explicit regression test for the v1→v2 data-preservation path.

## Privacy & data handling

- Every secret (PAT, OpenAI key) lives in the extension's own IndexedDB origin. Never logged. Never sent to anything but `api.github.com` / `api.openai.com`.
- **Zero telemetry.** No analytics SDKs, no error reporting beacons, no usage pings.
- No content scripts on github.com — the extension never sees pages you visit; it only calls the GitHub REST API with your token.
- Full data-handling matrix in [`docs/STORE_SUBMISSION.md`](./docs/STORE_SUBMISSION.md).

## Strategy

Not a fork. **Reference-and-rewrite** from upstream [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager) — borrow the AI provider abstraction and GitHub sync ideas, rewrite clean without the server coupling. See [`docs/STRATEGY.md`](./docs/STRATEGY.md) for the falsification audit + competitive scan that defined the blue-ocean P0 angles (weekly digest + code-context search).

## Roadmap

- **W1** ✅ — Foundation: monorepo + extension popup MVP
- **W2** ✅ — Sync engine + local storage (1000+ stars)
- **W3** ✅ — README semantic search + auto-tag
- **W4** ✅ — 🟢 **P0**: Personalized AI weekly digest
- **W5** ✅ — 🟢 **P0**: Code context search (deep-index)
- **W6** 🚧 — Polish + Chrome Web Store / Obsidian community plugin submission

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for week-by-week deliverables and the post-shipping backlog.

## Develop

```bash
pnpm install
pnpm test          # 412 tests
pnpm typecheck     # 6 workspaces
pnpm build         # extension dist + obsidian main.js + core/ai/vector/ui d.ts
pnpm --filter @starkit/extension dev   # vite dev server for popup
```

CI (`.github/workflows/ci.yml`) runs all three on every push / PR to `main`.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

Conceptual debt to [Astral](https://astralapp.com/), [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager), and [Stardex](https://github.com/BjornMelin/stardex) — none of whose code is included, but whose product thinking informed this design.
