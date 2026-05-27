# 下一次 session — v0.1.0 发布前你需要做的事

最后一次 AI 交接：**2026-05-27**（R51 P2 清理 + R50 真根因修复之后）。

v0.1.0 里 AI 能做的事**全部完成**。下面是只有**你本人**能做的活清单（Anthropic / IDE 私钥、付费服务、手动截图、GitHub 仓库设置、Chrome Web Store 账号）。

---

## TL;DR — 已经完成的部分

- ✅ 6 个 package 全部 typecheck 通过
- ✅ 572 个 vitest 通过（v0.0.1 时是 412 — 期间加了 i18n 契约测试、R49 tagsFailed、R50 needsTranslation、R51 deleteByPrefix）
- ✅ 扩展 build 干净（`dist/`）
- ✅ 已打包 `dist-store/starkit-extension-v0.1.0.zip`（536 KB）
- ✅ 11 个 i18n 语言全部齐全（cancel/cancelled key 已补全到所有 locale）
- ✅ 隐私政策 `docs/privacy-policy.md` + GitHub Pages 自动部署 workflow
- ✅ Manifest v0.1.0 含 icons（16/32/48/128） + 国区 host_permissions（SiliconFlow + DashScope）
- ✅ R50 翻译卡死 bug 已修（你前后报告了 5 次的那个）
- ✅ R51 P2：manage cancel 顺序 + onUnstar 用 O(matched) prefix delete

`main` 分支最近 6 个 commit：
```
f91715a docs: R46+R47 — README 刷新 + NEXT_SESSION 清单
688f6b9 fix(p2): R51 — manage cancel + O(matched) onUnstar prefix delete
9ee3c63 fix(p0): R50 — 翻译"翻译 N 个"卡死真根因（第 5 次迭代）
9d839a2 fix(p0): R49 — 翻译按钮"闪烁后毫无反应"silent tag-failures
7cbbbd1 fix(p0): R48-round3 — 翻译按钮在 empty-desc stars 上卡住
5c3fe22 fix(p0/p1): R48-round2 — 跨切面审计发现的 CWS blockers
```

---

## 1. 启用 GitHub Pages（一次性，3 分钟）

**为什么要做**：Chrome Web Store 表单要求填写隐私政策的公开 URL。生成 + 部署隐私政策的 workflow 已经写好了（`.github/workflows/pages.yml`），只差在 repo 设置里把 Pages 打开。

```
1. github.com/yyymzzz/github-star-kit → Settings → Pages
2. Build and deployment → Source → 选 "GitHub Actions"（不要选 "Deploy from a branch"）
3. 往 main 推任意一个 commit（或在 Actions 标签里手动重跑最新的 pages workflow）
4. 等约 1 分钟，然后验证：
   curl -sIL https://yyymzzz.github.io/github-star-kit/privacy-policy.html | head -5
   # 预期：HTTP/2 200, Content-Type: text/html
```

把这个 URL 存下来 —— 后面要粘贴到 CWS 表单。

---

## 2. 截 3 张截图（手动，15 分钟）

CWS 要求**严格 3 张 1280×800 的 PNG/JPEG** 给上架页 carousel。

一次性准备：
- 在 `chrome://extensions`（开发者模式）加载 `apps/extension/dist/`
- 配好你的 PAT + AI key
- 跑一次 Sync，确保有 50+ stars，里面至少 5 个已 deep-index 过

要截的 3 张：

| # | 截图 | 要展示的内容 |
|---|---|---|
| 1 | **Popup 搜索结果页** | 输入一个能同时命中 star + code 的查询（如 `async runtime` 或 `debounce`），让 R39 filter chips 显示出来 |
| 2 | **Popup 周报面板** | 点 📰 Weekly digest；确保至少 3 个条目带 AI 生成的"为什么这个对你有意义"小结 |
| 3 | **Manage 页 card grid** | 打开 manage 标签页（满屏），切到 Card 密度模式，能看到 AI tag chips + 本地化描述（如 zh-CN 中文 tags）。加分项：deep-index 按钮的 hover 状态。 |

保存到 `docs/store-assets/`（已 gitignore，不要 commit 二进制文件）。从 CWS dashboard 上传。

---

## 3. 做小尺寸宣传图（手动，5 分钟）

CWS 要一张 **440×280 的 small promo tile**，显示在上架页卡片上。

快速做法：
1. 用任意图片编辑器打开 `apps/extension/icons/icon-128.png`
2. 缩放到 280×280，放在 440×280 靛蓝色（`#6366f1`）画布中央
3. icon 右边加文字 "GitHub Star Kit"（无衬线字体，约 36pt，白色）
4. 导出为 PNG，存到 `docs/store-assets/promo-440x280.png`

---

## 4. 手动冒烟测试（20 分钟，最承重的一步）

按 [`docs/MANUAL_SMOKE.md`](MANUAL_SMOKE.md) 在**全新 Chrome profile** 跑一遍加载好的 dist。文档里有完整 checklist，必须过的几条：

- [ ] 安装 → 工具栏出现带星形图标的按钮
- [ ] 用一个 stars ≤ 50 的测试账号做首次 sync 成功
- [ ] 点 Build index → 进度条跑完 → 搜索返回结果
- [ ] 点 Auto-tag → tag chips 出现在卡片下
- [ ] 翻译到 zh-CN（如果你 UI locale 是中文）→ tags + desc 本地化
- [ ] 对 1 个含 TypeScript/Python/Rust 源码的 repo 做 deep-index → 搜索返回 code chunks 带 file:line GitHub 永久链接
- [ ] Provider 切换（在另一家 provider 下 Save key）→ vector store 自动重置（R48 round-2 修复）
- [ ] Reset keys & clear cache 干净地清掉一切

任何一条挂掉就**停下来汇报** —— 那是 CWS 提交前的 blocker。

---

## 5. 注册 Chrome 开发者账号（$5 一次性）

`https://chrome.google.com/webstore/devconsole` → 交一次 $5 注册费。

建议用一个**专门的开发者 Google 账号**（别用个人 / 工作账号，否则后面账号变动会带 risk）。

---

## 6. 提交到 Chrome Web Store

第 1-5 步都做完后：

1. CWS dashboard → New Item → 上传 `dist-store/starkit-extension-v0.1.0.zip`
2. 字段从 [`docs/STORE_LISTING.md`](STORE_LISTING.md) 逐字复制粘贴：
   - Short description（一行）
   - Detailed description（约 1600 字符）
   - Privacy policy URL（第 1 步拿到的）
   - Single purpose（一行）
   - Permission justifications（storage / alarms / host_permissions 表格）
   - Data usage disclosure 表格
3. 上传第 2 步的 3 张截图 + 第 3 步的 440×280 promo tile
4. 选 category：**Productivity**（备选：Developer Tools）
5. Language：**English**
6. Region：All（国区用户用 SiliconFlow/DashScope 默认 preset）
7. 提交审核

首次提交审核：1–7 天。后续更新：一般 <24 小时。

---

## 7. 提交后的事

等审核期间可以做：
- 启动 Obsidian community plugin 提交流程（并行赛道——不同的审核流程；见 `apps/obsidian/README.md`）
- 关注 GitHub Issues，看有没有用户反馈
- 如果发现 bug，加到 v0.1.1 milestone —— **不要修改正在审核的提交**，除非 CWS 退回

---

## 参考 — 这次 session 范围之外的事

- Firefox / Edge 移植（manifest 不同、审核队列不同 — v0.1.1+ 再说）
- 多账号支持（v1 只支持单 PAT）
- 设置云同步（明确说 No —— 隐私承诺红线）
- 给非扩展用户提供 web app fallback（超出范围；Obsidian plugin 已经覆盖了不想装 Chrome 的桌面用户）

后面想做这些，全部记在 [`docs/ROADMAP.md`](ROADMAP.md) 的 backlog 里。
