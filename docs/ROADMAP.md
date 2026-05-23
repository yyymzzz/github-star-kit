# Roadmap

> 6-week MVP. Each week has a verifiable Friday demo gate.

## Status: W3 Day 2 ✅ (embedding pipeline) — W1 + W2 + W3 D1 complete, 245 tests green, CI gated

| Week | Theme | Demo gate (verifiable) |
|---|---|---|
| **W1** | Foundation & fork hygiene | Extension popup shows 10 starred repos via GitHub API |
| **W2** | Sync engine + local storage | 1000+ stars incremental sync; both apps survive restart; no data loss |
| **W3** | AI #1 + #2 baseline | "rust async runtime" → top-5 relevant repos <500ms; tags auto-generated |
| **W4** | 🟢 **AI #3 P0**: Weekly digest | Friday morning auto-generates a digest with 10 genuinely useful updates |
| **W5** | 🟢 **AI #4 P0**: Code context search | "show me a debounce hook" → 5 code snippets with line numbers + permalinks |
| **W6** | Auto-tag + polish + launch | Submitted to Chrome Web Store / Firefox AMO / Obsidian community plugins |

## W1 Day-by-Day

| Day | Deliverable | Status |
|---|---|---|
| **1** | Monorepo scaffold + type contracts + pnpm install + typecheck pass | ✅ done |
| **2** | `packages/ai/` rewrite: provider adapter (OpenAI/Anthropic/Voyage/Ollama) | ✅ done (Stage 1+2) — `openai-compatible` deferred to Stage 3 |
| **3** | `packages/core/` rewrite: GitHub sync engine, local-first, ETag-aware | ✅ done |
| **4** | Storage abstractions + IndexedDB adapter + sync orchestrator (D4a/D4b) | ✅ done |
| **5** | Popup → 10 starred repos via real GitHub API (demo gate) | ✅ done |

## W2–W6 detail

Lives in the parent plan: `C:\Users\admin\.claude\plans\github-star-app-reddit-spicy-tide.md`.

Progress:
- **W2 ✅** — `chrome.alarms` 6h cron, Obsidian plugin wire-up (Settings + Sync command), cross-context sync mutex (`chrome.storage.local`, nonce-confirmed), full-vs-incremental hybrid sync with `starred_at` cursor.
- **W3 🚧** — D1 done (VectorStore interface + in-memory cached-norm cosine baseline). D2 done (`@starkit/core/embedding`: `buildStarEmbeddingInput` + djb2 `contentHash` + `embedStars` orchestrator with batching, AbortSignal, per-batch failure isolation, and a contentHash skip-cache short-circuit). Next: D3 — wire `provider.embed` + `vectorStore.search` into popup for the "rust async runtime → top-5 in <500ms" demo gate; then D4 auto-tag.
- **Hardening (post-W3-D1)** — fixed P0 same-second incremental star-loss, P1 `pushed_at:null` sync abort, null `pushedAt` ordering; made un-star cleanup atomic (`deleteMany`, single IDB transaction).

## Risk tracker (linked to plan)

| # | Risk | Triggered? | Mitigation status |
|---|---|---|---|
| 1 | License conflict (GPL/AGPL transitive) | ✅ verified clean | done W1 D1 |
| 2 | GitHub API rate limits (5000 req/hr) | not yet relevant | scheduled W2 |
| 3 | LLM cost | mitigated by BYOK | done by design |
| 4 | Privacy | mitigated by no-server v1 | done by design |
| 5 | Cold start (5000 stars embed) | not yet relevant | scheduled W3 |
| 6 | Extension/Obsidian sync conflicts | mitigated by v1=no-cross-device | done by design |
| 7 | Upstream/competitor ships AI first | watching | weekly check via `gh api` |
| 8 | OAuth vs PAT friction | mitigated by PAT in v1 | done by design |
| 9 | China GFW (OpenAI/Claude unreachable) | Ollama first-class fallback | done by design |
| 10 | Solo-dev burnout | 1-year ceiling = 1000 WAU or sunset | tracked |
| 11 | Obsidian plugin review delay | submit early via BRAT | scheduled W6 |
| 12 | MV3 service worker eviction | state in IndexedDB only | done by design |

## Verification KPIs

See `plans/github-star-app-reddit-spicy-tide.md` § B.9.

Quick reference:
- Sync 1000 stars cold: ≤30s
- Embed 1000 stars: ≤90s, ≤$0.01
- Semantic search p50: ≤100ms
- Weekly digest gen: ≤30s, ≤$0.01 per run
- Per-user-per-month cost (1000 stars default): ~$0.02 (BYOK = user pays)

## Decision points (re-visit before W6)

1. Monetization: free forever vs Pro $3/mo (cross-device sync)
2. Browser scope: Chrome only at W6, Firefox/Edge at W7
3. Auth: PAT in v1, OAuth Device Flow in v2
4. Naming + branding: `github-star-kit` is working name; pick brand before W6 store submission
5. Upstream relationship: hard fork vs PR-upstream — decide W3
