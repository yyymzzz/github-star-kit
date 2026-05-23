# Roadmap

> 6-week MVP. Each week has a verifiable Friday demo gate.

## Status: ✅ **W3 + W4 V1 complete** — semantic search + auto-tag + AI weekly digest with LLM "why this matters" narration all wired through popup. W1 + W2 + W3 D1-D5 + W4 V0/V1 done, 347 tests green, end-to-end demo-gate smoke passing, CI gated. **Next: W5 code-context deep-index, W6 polish + store submission.**

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
- **W3 ✅** — D1 VectorStore baseline (interface + MemoryVectorStore with cached-norm cosine), D2 embedding pipeline (`@starkit/core/embedding`: `buildStarEmbeddingInput` + djb2 `contentHash` + `embedStars` orchestrator with batching, AbortSignal, per-batch failure isolation, contentHash skip-cache short-circuit), D3 popup semantic search wiring (`IndexedDBVectorStore` adapter on schema v2, pre-fill MemoryVectorStore at popup mount, dual-upsert on embed, search rehydrate from starStore), D4 auto-tag (`@starkit/core/tagging`: TAG_SYSTEM_PROMPT + `tagStars` orchestrator with bounded concurrency, `parseTagResponse` defensive parser, tag chips render under each repo in popup), D5 demo-gate smoke (end-to-end pipeline test on fake-indexeddb, 20ms for 50 stars vs <500ms budget). R5 蓝军 surfaced + fixed a VectorLookupFn type-narrowness bug that would have blocked D3 popup wiring.
- **W4 ✅** — V0 (`@starkit/core/digest`: `computeInterestProfile` centroid, `generateDigest` orchestrator with `cosine × 0.8 + recency × 0.2` composite scoring, candidate filter for archived/forks/null pushedAt/window cutoff) + V1 (`summarizeDigestEntries`: LLM "why this matters" 1-2 sentence hook per entry, bounded concurrency, per-entry failure isolation). Popup "📰 Weekly digest" button computes locally (zero new GitHub calls), surfaces ranked + summarized list under same RepoLink card style, falls back to ranking-only on summary failure. R9 蓝军 surfaced + fixed: digest staleness on sync/re-embed (auto-clear), window-boundary inconsistency (`<=` cutoff), unembedded-count exposure to UI, deterministic pushedAt tiebreak.
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
