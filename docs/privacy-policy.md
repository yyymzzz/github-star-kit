# Privacy Policy — GitHub Star Kit

**Last updated:** 2026-05-26
**Extension version covered:** v0.1.0 and later
**Source code:** https://github.com/yyymzzz/github-star-kit (MIT license)

---

## TL;DR

GitHub Star Kit is a **fully local-first** browser extension. We don't
run any server. Your data never reaches our hands because we have no
hands — there's no "us." The only places your data goes are:

1. **api.github.com** — to sync your starred repos and pull source
   code from repos you opted into Deep-index.
2. **The AI provider YOU chose** — when you click an AI feature
   (search / auto-tag / digest / translate), the extension sends
   the relevant payload (a search query, or the repo's description,
   or a code chunk) to that provider's API using YOUR key.

That's it. No telemetry. No analytics. No error reporting. No
account. No third-party tracking. No content scripts injected into
GitHub or any other site.

If you don't trust this claim, the entire codebase is open source —
audit it yourself at the GitHub link above.

---

## 1. What data the extension handles

### 1.1 Authentication credentials

| Item | Where stored | Where transmitted |
|---|---|---|
| GitHub Personal Access Token (PAT) | IndexedDB in the extension's origin (isolated from any website) | Only to `api.github.com` as a `Authorization: Bearer …` header |
| AI provider API key | Same IndexedDB origin | Only to the configured provider endpoint (e.g. `api.openai.com`, `api.siliconflow.cn`) |

Both keys are stored as plaintext **inside the extension's IndexedDB
origin** — Chrome guarantees this origin is isolated from every other
website and from other extensions. No website running in your browser
can read these keys via the DOM, cookies, localStorage, or any other
cross-context channel.

### 1.2 Starred repo metadata

When you click "Sync," the extension fetches your starred repo list
from GitHub and caches the following per-repo fields in IndexedDB:

- repo id, full name, html_url, owner login + avatar URL
- description, topics, primary language
- starred_at, pushed_at, stargazers_count, default_branch
- archived/fork booleans

This is **exactly the same data anyone can read via `curl
https://api.github.com/users/{your-username}/starred`** if they know
your username — it's not private. The extension just keeps a local
copy so re-opens are fast and the AI features can index it.

### 1.3 AI-generated derived data

When you click an AI feature, the extension sends a payload to YOUR
provider and stores the response in IndexedDB:

- **Search index**: vector embeddings of `name + description +
  language + topics` per starred repo.
- **Auto-tags**: 3-5 short tags per repo.
- **Weekly digest**: relevance scores + 1-sentence "why this matters"
  hooks for the top-ranked entries.
- **Translations**: locale-keyed cached versions of description /
  tag-list.
- **Deep-index** (opt-in per repo): vector embeddings of code chunks
  from the repo's source files at its default branch.

All of these are **outputs of YOUR chosen provider's models**, paid
for by YOUR key, cached locally so re-opens are free.

### 1.4 Your private notes

The note editor on the manage page stores a free-form text field per
starred repo in IndexedDB. **This data never leaves your device** —
GitHub doesn't have a "private notes for stars" API, so there's no
upstream to send it to. The data exists only in your local IndexedDB.

If you reinstall the extension or switch computers, your notes are
lost. (Export/import is on the v0.2 roadmap.)

### 1.5 Your active search queries

When you type a query in the popup search bar and click Go, the
extension:

1. Sends the query string to the AI provider's embedding endpoint
   (so it can be turned into a vector for similarity search).
2. Does NOT store the query text anywhere persistent. The query
   lives in React component state only until you submit a new
   query or close the popup.

---

## 2. What data the extension does NOT collect

- ❌ No telemetry, analytics, performance metrics, or crash reports.
- ❌ No usage statistics, feature-flag pings, or experiment cohorts.
- ❌ No identifiers tied to you across sessions (no UUIDs, no
   fingerprints, no device-graph data).
- ❌ No location or geolocation data.
- ❌ No browsing history beyond what you explicitly add (a starred
  repo's metadata is GitHub's public knowledge, not a "site you
  visited" signal).
- ❌ No advertising data, no audience cohort participation.

---

## 3. What websites the extension talks to

The extension's `manifest.json` declares the following hosts:

### 3.1 Required (host_permissions)

- **`https://api.github.com/*`** — Used for: list your stars, fetch
  repo metadata, fetch source files (only for repos you opted into
  Deep-index). Authenticated with your PAT.

### 3.2 Optional (optional_host_permissions, granted on-demand)

- **`https://api.openai.com/*`** — Granted only if you choose OpenAI
  as your AI provider.
- **`https://api.anthropic.com/*`** — Granted only if you choose
  Anthropic.
- **`https://api.voyageai.com/*`** — Granted only if you choose
  Voyage AI.
- **`http://localhost/*`** — Granted only if you self-host an
  Ollama-compatible proxy locally.

When you change provider, the previous provider's host permission
remains granted (Chrome's API doesn't expose a per-host revoke). To
fully revoke, uninstall the extension and reinstall, OR open
`chrome://extensions` → Star Kit → "Site access" → adjust per host.

### 3.3 Hosts the extension DOES NOT talk to

- ❌ Any of our servers (we have none).
- ❌ google-analytics.com, segment.io, sentry.io, mixpanel.com,
  hotjar.com, or any other analytics provider.
- ❌ Any CDN at runtime — all JS is bundled at build time inside
  the .zip you installed.
- ❌ github.com itself (the HTML site). Only the API host. There is
  no content script that runs on github.com or any other site.

---

## 4. Children and minors

The extension has no age-gate. It does not collect any data that
could identify a minor (or anyone else). Parents/guardians concerned
about the AI provider APIs the user might point this at should
consult that provider's own policy.

---

## 5. Data retention and deletion

- **All data is stored on YOUR device's IndexedDB.** When you
  uninstall the extension via `chrome://extensions`, Chrome's
  uninstall flow removes the extension's storage automatically.
- The popup includes a "Reset keys & clear cache" button that
  wipes IndexedDB without uninstalling. Use this if you want to
  start fresh or hand off the laptop without uninstalling.
- We retain **nothing** because there's no "we" — there's no
  server to retain anything on.

---

## 6. Third-party providers (your AI key choice)

When you configure an AI provider, you are subject to that provider's
privacy policy and terms of service for the data the extension sends
on your behalf:

- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/legal/privacy
- Voyage AI: https://www.voyageai.com/privacy
- SiliconFlow: https://docs.siliconflow.cn/legal/privacy
- DashScope (Alibaba): https://www.alibabacloud.com/help/legal
- Ollama (self-hosted): N/A — runs on your own infrastructure.

GitHub Star Kit does not negotiate, modify, or relay these terms.

---

## 7. Changes to this policy

If a future version of the extension changes what data is sent or
where, this document will be updated in the same git commit, and
the extension's version will increment so anyone tracking the
listing can see a new release notice. The git history at
https://github.com/yyymzzz/github-star-kit/commits/main/docs/privacy-policy.md
is the canonical changelog for this policy.

---

## 8. Contact

This is a personal open-source project. The maintainer is reachable
via GitHub issues:
https://github.com/yyymzzz/github-star-kit/issues

For sensitive matters (e.g. you found a security issue), prefer
email: see the `author` field in the repository's `package.json`.

---

## 9. Legal jurisdiction

This policy is offered as a personal, best-effort statement. The
maintainer is not a lawyer; if you need a formal legal review for
enterprise/compliance reasons, please review the source code yourself
and consult your own counsel. The policy does not waive any of your
rights under GDPR, CCPA, or any other applicable data-protection
law — in fact those rights are easy to exercise here because we
hold zero data on you.
