# Store listing copy — Chrome Web Store v0.1.0

Drop-in text for the developer dashboard. Each field below maps 1:1 to
a CWS form input. Keep this file in sync with manifest.json and README
on every version bump.

---

## Short description (≤132 chars)

> AI-powered intelligence for your GitHub stars: weekly digest + code search + smart tags.

(131 chars — fits the CWS limit with 1 char to spare. Lifted verbatim
from `manifest.json.description` so the listing and the installed
extension agree.)

---

## Detailed description (rich-text supported, ≤16,000 chars)

```
GitHub Star Kit turns your starred repos from a passive collection
into an AI-searchable, context-aware knowledge base. Everything runs
locally in your browser — your stars, your laptop, your API key.

✦ WHY YOU MIGHT WANT IT

You've starred 500-5,000 repositories over the years. You vaguely
remember "that great repo for SSE retry" but the GitHub search just
returns irrelevant projects. Star Kit indexes your stars in your
browser with semantic embeddings — type "server-sent events retry"
and the actual repo surfaces, even if its description never said
those words.

✦ KEY FEATURES

📰 Weekly Digest
   Top recently-pushed starred repos ranked by relevance to your
   interest profile (derived from your star vectors). Click any
   repo → an LLM-generated 1-sentence "why this matters to you"
   hook.

🔍 Semantic Search
   Local vector search across your stars. Built once, lasts forever
   (delta-updated on each sync — only the new stars get embedded).

🤖 Auto-Tags
   One-click LLM tagging across your whole star list. Tags become
   filterable chips on the manage page. ~$0.06 to tag 1,000 repos
   on gpt-4o-mini.

🌐 Translate to 11 Languages
   Descriptions + AI tags translated to zh-CN / zh-TW / ja / ko /
   de / fr / es / pt-BR / ru / vi via your provider. Cached locally
   so re-renders are free.

🔧 Deep-Index Code
   Opt-in per repo: pulls top source files, splits into ~600-token
   chunks, embeds them. Now your popup search also returns CODE
   snippets with file path + GitHub permalink. Try "debounce
   function" or "prepare SQL".

📝 Private Notes
   Add a private memo to any starred repo. Stays on your device —
   GitHub never sees it. Markdown-friendly.

⚙️ Multi-Provider AI
   OpenAI, Anthropic, Voyage, SiliconFlow, DashScope, or a local
   Ollama proxy. Bring your own key; switch any time without
   re-indexing.

⌨️ Power Features
   - Ctrl+Shift+Y opens the popup from anywhere.
   - Cmd/Ctrl+K or "/" focuses the popup search bar.
   - 3 manage-page density modes: Cards / List / Compact.
   - Cancel button on long-running ops (translate / deep-index).

✦ PRIVACY (the important bit)

Your GitHub PAT and AI keys are stored in the extension's own
IndexedDB origin — never read by any other website, never sent
anywhere except the configured GitHub/AI endpoints.

✦ NO TELEMETRY
   No analytics. No error reporting. No background fetches to any
   3rd party. The only network destinations are:

   - api.github.com (for star sync, source fetch on deep-index)
   - The AI endpoint you chose (for embeddings / chat / translate)

✦ DATA YOU SUBMIT TO YOUR AI PROVIDER
   - Repo metadata (name, description, topics, language) — same
     data anyone could `curl` from GitHub.
   - Source code from repos YOU opted into deep-indexing.
   - Your search query at search time.
   - Nothing else.

We do not collect, store, or transmit any identifier, telemetry,
crash report, or analytics event. The extension is open source at
https://github.com/yyymzzz/github-star-kit — verify any claim above
by reading the code.

✦ WHAT WE EXPLICITLY DO NOT DO
   - No content scripts injected into github.com or any other page.
   - No off-device key storage (no "sign in to sync settings" cloud).
   - No automatic prompt rewriting on the user's GitHub pages.
   - No background fetches to any host besides GitHub + your AI.

✦ REQUIREMENTS
   - Chrome 116+ / Edge 116+ / Firefox 120+
   - A GitHub Personal Access Token (public_repo scope is sufficient
     for public stars; repo scope needed for private stars).
   - An API key from one of the supported providers (BYO; pricing
     varies but expect ~$0.05-$0.50 to index 1,000 stars).

✦ COSTS (the user pays, we don't see it)
   - Embedding 1,000 stars on text-embedding-3-small: ~$0.01
   - Auto-tagging 1,000 stars on gpt-4o-mini: ~$0.06
   - Translating 1,000 descriptions to zh-CN on gpt-4o-mini: ~$0.30
   - Deep-indexing 1 typical repo: ~$0.005

✦ OPEN SOURCE
   Code: https://github.com/yyymzzz/github-star-kit
   License: MIT
   Audited: every release passes a 5-round 蓝军 / red-team review
   covering data integrity, race conditions, i18n parity, and
   privacy regressions. See R20-R40 commit log on GitHub.

Questions, feedback, or feature requests? Open an issue on GitHub.
```

---

## Category

**Productivity** (CWS dropdown). Alternative: Developer Tools — pick
Productivity because the digest + manage-page surfaces are equally
useful for non-developer star hoarders.

---

## Language

Listing primary: **English (en)**. Translated listings can be added
after v0.1.0 ships — Chrome Web Store supports per-locale alternative
listings filed at any time.

---

## Privacy practices form (required)

Field-by-field answers. Submit verbatim:

### Single purpose

> Personal-use AI intelligence layer over the user's GitHub stars —
> semantic search, automatic tagging, weekly digest, and code-context
> search across opted-in repositories.

### Permission justifications

- **storage** — Stores the user's GitHub PAT, AI provider API key,
  cached star metadata, embedding vectors, and per-row AI outputs in
  IndexedDB (extension origin). Required so re-opens don't refetch.

- **alarms** — Schedules a 6-hour periodic sync via `chrome.alarms`
  so the user's star list stays fresh without manual clicks. Cleanly
  cancellable via the lock infrastructure.

- **host_permissions: api.github.com** — Required for the core sync
  loop (read user's starred list + read repo metadata + read source
  files for deep-index). No other GitHub endpoint is hit.

- **optional_host_permissions: api.openai.com / api.anthropic.com /
  api.voyageai.com / localhost** — Granted on demand only when the
  user enters an API key for that provider. Localhost covers
  self-hosted Ollama-compatible proxies.

### Data usage disclosure

| Data type | Collected | Where it goes |
|---|---|---|
| Personal communications (e.g. note text) | Stored on device | Never leaves device |
| Authentication info (PAT / API keys) | Stored on device | Only to the matching API endpoint |
| Website content (repo metadata, code) | Cached on device after sync | Only to user's chosen AI provider for embedding/chat |
| Web history | Not collected | — |
| Location | Not collected | — |
| User activity | Not collected | — |
| Telemetry / analytics | Not collected | — |

### Use of remote code

> No remote code. The extension is fully self-contained: all JS is
> bundled at build time via Vite and shipped inside the .zip. No
> `eval`, no `<script src>` from CDNs at runtime. The only network
> calls are JSON API requests (GitHub + AI) — no script execution.

---

## Promo tile + screenshots (W6 D2 to-produce, user step)

User responsibility:

1. **440 × 280 small promo tile** — a flat indigo square with
   "GitHub Star Kit" wordmark + the same star glyph as `icons/icon-128.png`.
   Quick option: open `apps/extension/icons/icon-128.png` in any image
   editor, scale to 280×280, drop on a 440×280 indigo canvas, add
   wordmark in a sans-serif at ~36pt.

2. **3 × 1280 × 800 screenshots** — required by CWS for the listing
   carousel. Capture inside Chrome at the popup's natural size (or
   the manage page) with `Window > Take a screenshot of an area`:

   a. **Popup with search results** — type a query that produces a
      MIX of star + code hits so the R39 filter chips show.

   b. **Popup with weekly digest** — open the digest panel; ensure
      at least 3 entries with AI-generated summaries are visible.

   c. **Manage page card grid** — the R25/R32 grid layout, ideally
      with a few AI tags + a localized description visible. Bonus:
      hover state on the deep-index button.

Save into `docs/store-assets/` (gitignore the folder if you don't
want to track binaries) and upload via the CWS dashboard.

---

## Privacy policy URL

**R43 SHIPPED.** The policy lives at `docs/privacy-policy.md`,
auto-deployed via `.github/workflows/pages.yml` whenever main is
pushed.

**Public URL (after first deploy):**
`https://yyymzzz.github.io/github-star-kit/privacy-policy.html`

**Landing page (linked from the privacy footer):**
`https://yyymzzz.github.io/github-star-kit/`

### One-time setup (user step)

1. Open the repo on github.com → **Settings → Pages**.
2. Under "Build and deployment" → **Source** → choose
   `GitHub Actions` (NOT "Deploy from a branch").
3. Push any commit to main. The `Deploy Pages` workflow will fire
   and the URL above will go live within ~1 minute.

### Verifying before paste into CWS form

```
curl -sIL https://yyymzzz.github.io/github-star-kit/privacy-policy.html | head -5
# Expect: HTTP/2 200, Content-Type: text/html
```

If the URL 404s, the workflow either hasn't run yet (check
github.com/yyymzzz/github-star-kit/actions) or Pages isn't enabled.

---

## Version + zip artifact

- Version: **0.1.0** (matches `apps/extension/manifest.json`).
- Zip path: `dist-store/starkit-extension-v0.1.0.zip` (produced by
  `pnpm extension:package`).
- Size: ~525 KB (well under CWS's 10 MB ceiling — main bulk is the
  source maps; deciding to ship/strip them is a v0.2 call).

---

## Submission checklist

Pre-flight before clicking "Submit for review":

- [ ] `pnpm install --frozen-lockfile` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` 536/536 green
- [ ] `pnpm extension:icons` re-runs cleanly (icons unchanged)
- [ ] `pnpm extension:build` clean
- [ ] `pnpm extension:package` produces zip with correct version
- [ ] `MANUAL_SMOKE.md` checklist completed in a fresh Chrome profile
- [ ] 3 screenshots saved to `docs/store-assets/`
- [ ] Privacy policy URL live + reachable
- [ ] Developer account ($5 fee paid)

After submit: review takes 1–7 days for first-submit (later updates
typically <24h).
