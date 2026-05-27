# Next session — user-only checklist for shipping v0.1.0

Last AI handoff: **2026-05-27**, after R51 (P2 cleanup + R50 root-cause fix).
All AI-doable work for v0.1.0 is **complete**. Below is the punch list that
**only you** can execute (Anthropic / IDE keys, paid services, manual UI
captures, GitHub repo settings, Chrome Web Store account).

---

## TL;DR — what's already done

- ✅ 6 packages typecheck clean
- ✅ 572 vitest pass (was 412 at v0.0.1 — added i18n contract, R49 tagsFailed,
  R50 needsTranslation, R51 deleteByPrefix)
- ✅ extension build clean (`dist/`)
- ✅ `dist-store/starkit-extension-v0.1.0.zip` packaged (536 KB)
- ✅ 11 i18n locales complete (cancel/cancelled keys backfilled to all)
- ✅ Privacy policy at `docs/privacy-policy.md` + GitHub Pages workflow
- ✅ Manifest v0.1.0 with icons (16/32/48/128) + China-region host_permissions
- ✅ R50 translate-stuck bug fixed (the one user reported 5 times)
- ✅ R51 P2: manage cancel ordering + O(matched) onUnstar prefix delete

Last 6 commits on `main`:
```
688f6b9 fix(p2): R51 — manage cancel + O(matched) onUnstar prefix delete
9ee3c63 fix(p0): R50 — translate "翻译 N 个" stuck (5th iteration, real root cause)
9d839a2 fix(p0): R49 — translate button "闪烁后毫无反应" silent tag-failures
7cbbbd1 fix(p0): R48-round3 — translate button "翻译 N 个" stuck on empty-desc stars
5c3fe22 fix(p0/p1): R48-round2 — CWS blockers from cross-cutting audit agent
226fb21 fix(p0): R48 — deep-index per-row false-success + translate gaps
```

---

## 1. Enable GitHub Pages (3 min, one-time)

**Why**: Privacy policy URL is required by the Chrome Web Store form. The
workflow that builds & deploys the policy already exists
(`.github/workflows/pages.yml`); it just needs Pages turned on.

```
1. github.com/yyymzzz/github-star-kit → Settings → Pages
2. Build and deployment → Source → "GitHub Actions" (NOT "Deploy from a branch")
3. Push any commit to main (or re-run the latest pages workflow manually).
4. Wait ~1 min. Then verify:
   curl -sIL https://yyymzzz.github.io/github-star-kit/privacy-policy.html | head -5
   # Expect: HTTP/2 200, Content-Type: text/html
```

Save the live URL — you'll paste it into the CWS form.

---

## 2. Capture 3 screenshots (15 min, manual)

CWS requires exactly 3 × 1280×800 PNG/JPEG for the listing carousel.

Setup once:
- Load `apps/extension/dist/` in `chrome://extensions` (developer mode).
- Have your PAT + AI key configured.
- Sync once so you have 50+ stars with AI tags + at least 5 deep-indexed.

Shots needed:

| # | Shot | What to show |
|---|---|---|
| 1 | **Popup with search results** | Type a query producing a MIX of star + code hits so the R39 filter chips show (e.g. `"async runtime"` or `"debounce"`) |
| 2 | **Popup with weekly digest** | Click 📰 Weekly digest; ensure at least 3 entries with AI-generated "why this matters" summaries are visible |
| 3 | **Manage page card grid** | Open manage tab (full window), Card density mode, with AI tag chips + a localized description (zh-CN tags) visible. Bonus: hover state on the deep-index button. |

Save to `docs/store-assets/` (gitignored — don't commit binaries). Upload
via the CWS dashboard.

---

## 3. Create the small promo tile (5 min, manual)

CWS asks for one **440×280 small promo tile** for the listing card.

Quick recipe:
1. Open `apps/extension/icons/icon-128.png` in any image editor.
2. Scale to 280×280, drop centered on a 440×280 indigo (`#6366f1`) canvas.
3. Add "GitHub Star Kit" wordmark to the right of the icon (sans-serif, ~36pt, white).
4. Export as PNG. Save to `docs/store-assets/promo-440x280.png`.

---

## 4. Manual smoke test (20 min, the load-bearing one)

Walk through [`docs/MANUAL_SMOKE.md`](MANUAL_SMOKE.md) in a **fresh Chrome
profile** with the loaded dist. The doc has the full checklist; the
must-pass items are:

- [ ] Install → toolbar icon appears with star glyph
- [ ] First sync of a small starred list (test account ≤ 50 stars) succeeds
- [ ] Build index → progress bar advances → search returns hits
- [ ] Auto-tag → tag chips appear under cards
- [ ] Translate to zh-CN (if Chinese is your UI locale) → tags + desc localized
- [ ] Deep-index one repo with TypeScript/Python/Rust source → search returns code hits with file:line permalinks
- [ ] Provider switch (Save key in a different provider) → vector store auto-resets (R48 round-2 fix)
- [ ] Reset keys & clear cache wipes everything cleanly

If any item fails, **stop and report** — that's a blocker for CWS submission.

---

## 5. Register Chrome developer account ($5, one-time)

`https://chrome.google.com/webstore/devconsole` → pay the one-time $5 fee.
Use a Google account dedicated to your dev identity (don't use a personal /
work account that might churn).

---

## 6. Submit to Chrome Web Store

Once 1–5 are done:

1. CWS dashboard → New Item → upload `dist-store/starkit-extension-v0.1.0.zip`.
2. Paste fields verbatim from [`docs/STORE_LISTING.md`](STORE_LISTING.md):
   - Short description (one line)
   - Detailed description (~1600 chars)
   - Privacy policy URL (from step 1)
   - Single purpose (one line)
   - Permission justifications (storage / alarms / host_permissions table)
   - Data usage disclosure table
3. Upload the 3 screenshots from step 2 + the 440×280 promo tile from step 3.
4. Pick category: **Productivity** (alternative: Developer Tools).
5. Language: **English**.
6. Region: All (China users get the SiliconFlow/DashScope defaults).
7. Submit for review.

First-submit review: 1–7 days. Later updates: typically <24 h.

---

## 7. Post-submission

While waiting:
- Set up the Obsidian community-plugin submission (parallel track — different
  review process; see `apps/obsidian/README.md`).
- Watch the GitHub Issues for any user reports.
- If you find bugs, add to a v0.1.1 milestone — DON'T amend the in-review
  submission unless CWS rejects.

---

## Reference — what's NOT in this session's scope

- Firefox / Edge port (different manifest, different review queue — v0.1.1+).
- Multi-account support (one PAT at a time is fine for v1).
- Cloud sync of settings (explicit "no" — privacy promise).
- Web-app fallback for non-extension users (out of scope; the Obsidian plugin
  already covers desktop folks who don't want a Chrome dependency).

If you need to come back to any of these, they're in [`docs/ROADMAP.md`](ROADMAP.md).
