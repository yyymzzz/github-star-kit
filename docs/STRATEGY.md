# Strategy

> Why this project exists, what it is, what it is NOT.

## Why

Developers star repos as a "save for later" gesture, then forget what they saved and why. Existing tools (Astral, Octobox, gh-stars CLIs, OhMyStar, Star Order) all solve the **organization** problem — tag, search, filter. None of them solve the **intelligence** problem:

- _What's actually new this week in repos I starred, ranked by relevance to my stack?_
- _Can I search across the source code of repos I starred, with natural language?_

These two angles are blue-ocean in 2026 (verified by 16 raw user quotes across Reddit / HN / V2EX / 知乎 / 少数派 / DEV.to and a 13-product competitive scan). See `plans/github-star-app-reddit-spicy-tide.md` for the falsification audit.

## What this is

A dual-form **AI-powered intelligence layer** on top of your GitHub stars:

1. 🟢 **P0 — Personalized AI Weekly Digest**: ranked feed of recent updates in repos you starred, filtered by relevance to your interest profile (vacuum market — 0 competitors in 2026).
2. 🟢 **P0 — Code Context Search**: opt-in deep-index of N repos you starred, then natural-language search over source code with tree-sitter chunks + embeddings.
3. 🟡 P1 — README semantic search.
4. 🟡 P1 — LLM auto-categorization.
5. 🔵 P2 — Auto-tag + summary on star.

Two surfaces, one shared core:
- **Browser extension** (Manifest V3, Chrome/Edge/Firefox).
- **Obsidian community plugin**.

## What this is NOT (anti-scope-creep)

- ❌ **Not a fork** of upstream `AmintaCCCP/GithubStarsManager`. We "reference and rewrite": local clone at `../_reference/` is _read-only inspiration_, never the codebase we modify. Borrow ideas, rewrite clean.
- ❌ **No backend in v1.** No D1, no Workers, no auth server. All AI calls direct from extension/plugin to provider (BYOK).
- ❌ **No mobile.**
- ❌ **No social/sharing layer** in v1.
- ❌ **No telemetry** beyond opt-in crash reports.

If a feature does not directly serve the W4 (digest) or W5 (code-context-search) deliverable, **it does not ship in v1**.

## Architecture principles

1. **Local-first** — IndexedDB (extension) and sqlite-vec (Obsidian) are the source of truth. GitHub is upstream; provider keys are user-supplied.
2. **BYOK (Bring Your Own Key)** — never see, store, or proxy user API keys server-side.
3. **Provider-agnostic AI** — OpenAI / Anthropic / Voyage / Ollama / any OpenAI-compatible. User picks at runtime.
4. **Cost-transparent** — settings page shows estimated $/month at current usage.
5. **Defensive types** — zod schemas at every external boundary (GitHub API, AI providers, storage).

## Strategy validity check

- Pain validation: ≥3 raw user quotes per market domain (English + Chinese). Done.
- Real-need vs fake-need: pain is real, paying intent is weak → no-pay v1, optional Pro in v2.
- Blue-ocean window: 24–36 months before AI features get commoditized → ship W4/W5 fast.
- Founder-market-fit: builder is a daily heavy starrer (1000+ stars) — uses own product daily.

If any of these stop being true (e.g., GitHub ships native AI digest), revisit the v1 thesis.
