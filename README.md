# github-star-kit

> AI-powered GitHub Star intelligence: never forget what you starred and why.

**Status**: 🚧 W1 Day 1 — early scaffolding. Not yet usable.

## What this is

A dual-form productivity tool for developers drowning in their own GitHub stars:

- 🟢 **Personalized AI Weekly Digest** — what's actually new in repos you starred, ranked by relevance to your stack
- 🟢 **Code Context Search** — natural-language search across the source of repos you starred (opt-in deep-index)
- 🟡 README semantic search
- 🟡 LLM auto-categorization
- 🔵 Auto-tag + summary on star

Two surfaces, one shared core:

- **Browser extension** (Manifest V3, Chrome/Edge/Firefox)
- **Obsidian plugin** (community plugin)

## Architecture

Local-first. BYOK (Bring Your Own Key). No backend in v1.

```
packages/
  core/      GitHub sync, schemas (octokit + zod)
  ai/        Provider adapters (OpenAI / Anthropic / Voyage / Ollama)
  vector/    sqlite-vec wrapper + hybrid BM25 ranking
  ui/        Shared React + Tailwind components
apps/
  extension/ MV3 WebExtension
  obsidian/  Obsidian community plugin
```

## Strategy

Not a fork. **Reference-and-rewrite** from upstream [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager) — borrow the AI provider abstraction and GitHub sync ideas, rewrite clean without the server coupling. See `docs/STRATEGY.md`.

## Roadmap

- **W1** (current) — Foundation: monorepo + extension popup MVP
- **W2** — Sync engine + local storage (1000+ stars)
- **W3** — README semantic search + auto-categorization
- **W4** — 🟢 **P0**: Personalized AI weekly digest
- **W5** — 🟢 **P0**: Code context search (deep-index)
- **W6** — Auto-tag + polish + Chrome Web Store / Obsidian community plugin submission

See `docs/ROADMAP.md` for week-by-week deliverables.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

Conceptual debt to [Astral](https://astralapp.com/), [AmintaCCCP/GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager), and [Stardex](https://github.com/BjornMelin/stardex) — none of whose code is included, but whose product thinking informed this design.
