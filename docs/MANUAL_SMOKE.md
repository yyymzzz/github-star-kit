# Manual smoke test — pre-submission checklist

Run this end-to-end in a **fresh Chrome profile** before each store
submission. Each checkbox is a concrete user-visible behavior that
the automated test suite cannot verify (real provider calls, real
IDB persistence, real popup rendering).

Time budget: ~15 minutes if everything works, ~30 if you hit a
provider-side hiccup that needs retry.

---

## Setup (one-time per smoke run)

1. **Clean profile**: open Chrome → "New profile" → name it
   `starkit-smoke` (or use an incognito-equivalent if you prefer).
2. **Build + package**:
   ```bash
   pnpm extension:icons       # regenerate (no-op if unchanged)
   pnpm --filter @starkit/extension build
   pnpm extension:package     # produces dist-store/starkit-extension-v{X}.zip
   ```
3. **Load unpacked** in chrome://extensions:
   - Enable "Developer mode" (top right).
   - "Load unpacked" → select `apps/extension/dist/`.
   - Pin the extension to the toolbar so the popup is one click away.
4. **Provider keys ready**:
   - A GitHub PAT with `public_repo` (or `repo` for private stars).
   - At least one AI provider key (SiliconFlow free tier is fine).

---

## §1 Setup flow

- [ ] Popup opens to the PAT prompt on first click.
- [ ] Paste PAT → click Save → toast/notice changes to AI provider prompt.
- [ ] Pick provider (SiliconFlow / DashScope / OpenAI) → paste key → Save.
- [ ] Language picker shows 11 options.
- [ ] Switch language to 中文 → popup re-renders in zh-CN within ≤1s.

## §2 Sync

- [ ] Click Sync button → "Syncing…" status appears with spinner.
- [ ] Completion notice shows correct star count (`N stars · ...`).
- [ ] Top-10 most-recently-starred repos render in popup body.
- [ ] Each row shows repo name, language chip, star count.

## §3 Build search index

- [ ] "Build search index ({N} stars)" button visible.
- [ ] Click → progress notice `Embedding done/total` updates live.
- [ ] **Cancel button appears next to the progress** (R40).
- [ ] Wait for completion OR click Cancel → if cancelled, see green
      "Cancelled." notice and progress halts within ≤2s.
- [ ] On completion, index gauge ≥ 95% (some null-pushedAt rows skip).

## §4 Search

- [ ] Type a query → results appear within ≤2s.
- [ ] Each star hit has a score badge.
- [ ] If results include code (post deep-index, §7): R39 filter chips
      `All (N) · Stars (N) · Code (N)` visible; clicking each toggles
      the result list with no flicker.
- [ ] Cmd/Ctrl+K (or `/` when not focused) jumps to the search input.

## §5 Auto-tag

- [ ] Auto-tag button shows `N untagged` count.
- [ ] Click → progress + cancel button render.
- [ ] On completion, tags appear under each repo's row.
- [ ] If any failed: error banner shows `failed: M` + a `{provider
      error}` reason (not raw English).

## §6 Translate

- [ ] With locale ≠ en, "🌐 Translate {N}" button appears.
- [ ] Tooltip on hover shows the i18n translate.title string
      (zh-CN: "将 N 个仓库描述翻译…").
- [ ] Click → progress + cancel.
- [ ] On completion, descriptions render in the active locale.
- [ ] Aborted run: green "Cancelled." notice (not red error).
- [ ] Reload popup → translated descriptions persist (cached
      in IDB descriptionI18n).

## §7 Deep-index

- [ ] Click "🔧 Deep-index top 3" → loops through 3 repos.
- [ ] Progress notice updates with `{repo} (i/total)`.
- [ ] Cancel button works mid-loop (bails between repos within ≤30s).
- [ ] On completion: search "function" → CODE hits appear with file
      path + line range + "View on GitHub →" link.
- [ ] Permalinks land on the right `#L42-L58` range on github.com.

## §8 Weekly digest

- [ ] "📰 Weekly digest" button visible after embed completes.
- [ ] Click → ranking renders within ≤2s (relevance × recency).
- [ ] LLM summaries fade in 3-5s later (lower concurrency).
- [ ] "← Recent" button returns to recency view.

## §9 Manage page

- [ ] Click `📚 Manage all N stars` link in popup footer.
- [ ] New tab opens to manage page; subtitle shows `Showing N / N stars`.
- [ ] **ViewMode toggle** (R32): switch Cards/List/Compact, re-open
      manage tab — selection persists (KV storage).
- [ ] **No-keys CTA hint** (R30): if AI key missing, see blue banner
      "Configure GitHub PAT + AI Provider key to enable deep-index."
- [ ] **Note editor** (R38, R41 readability fix):
   - Click 📝 button on any card.
   - Dialog opens with **opaque background** (white in light, dark
     in dark mode); cards behind are **dimmed + blurred** — the
     R38 transparency bug is GONE.
   - Type → click Save → reopen card → note persists.
- [ ] **Tag filter chips** (R31/R39 visual parity): in the manage page
      header, top-N aiTags are clickable chips; selecting one filters
      the grid by that tag. Counts in chip labels.
- [ ] **Sort by relevance** (R15): pick "⭐ Most relevant" in sort
      dropdown → grid re-sorts by interest-profile cosine.

## §10 Sync conflict (R34)

- [ ] Open manage page, click Translate.
- [ ] Quickly click the popup's Sync button.
- [ ] Sync click should produce `sync.conflict` notice (zh-CN: "另一个
      同步正在后台运行,请稍后再试。") — confirms the R34 lock works.

## §11 Un-star cleanup (R33)

- [ ] In real GitHub, un-star 1-2 repos.
- [ ] In popup, click Sync.
- [ ] Console (DevTools on the extension popup): no orphan-vector
      warnings.
- [ ] Search the un-starred repo by name → should NOT appear.
- [ ] Open the extension's IndexedDB (DevTools > Application > IDB >
      starkit > vectors) and confirm the `star:{N}` row for the
      un-starred repo is gone.

## §12 Deep-index staleness (R36)

- [ ] Pick a repo you just deep-indexed.
- [ ] On real GitHub, push a tiny commit to that repo (or wait until
      it has a newer pushedAt than your `lastDeepIndexedAt`).
- [ ] In popup, click Sync.
- [ ] In manage page card / row: the "🔧 已深度索引" badge auto-flips
      back to a clickable "🔧 Deep-index" button — the row is now a
      re-deep-index candidate.

## §13 Reset

- [ ] Click "Reset keys & clear cache" in popup footer.
- [ ] Confirm prompt → IDB wiped → popup returns to PAT prompt.

---

## Sign-off

If all §1-§13 pass, the extension is ready for `dist-store/*.zip` to
be uploaded to the Chrome Web Store. Record the date, version, and
provider used:

| Field | Value |
|---|---|
| Smoke run date | YYYY-MM-DD |
| Extension version | v0.1.0 |
| Chrome version | (about://version) |
| AI provider tested | (siliconflow / dashscope / openai) |
| All checkboxes green? | ☐ Yes / ☐ No (list failures) |
| Signed off by | (name) |

If any checkbox fails: **do NOT submit**. File an R-commit fix, re-run
the smoke from §1.
