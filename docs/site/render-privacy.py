#!/usr/bin/env python
"""Render docs/privacy-policy.md into a self-contained HTML page.

R43: produces the page served at
https://{owner}.github.io/{repo}/privacy-policy.html — the URL the
Chrome Web Store developer dashboard requires.

Usage:
    python docs/site/render-privacy.py SOURCE.md OUTPUT.html

Dependencies: `markdown` (pip install markdown). The GitHub Actions
workflow installs it explicitly so this script doesn't need to bundle
its own copy or fall back to regex.

Design choices:
- Inline CSS, no external requests. The privacy policy itself promises
  "no third-party tracking" — pulling fonts from Google CDN would
  contradict that. So everything is system-fonts + tiny color palette.
- Light/dark via prefers-color-scheme. Matches the extension's UI
  theming so users who arrive from the CWS listing in dark mode see
  a coherent visual.
- No analytics, no service worker, no nothing. Pure HTML+CSS.
"""
import sys

import markdown


CSS = """
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
               'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  line-height: 1.65;
  background: #ffffff;
  color: #1f2328;
  padding: 32px 16px 64px;
}
main {
  max-width: 720px;
  margin: 0 auto;
}
h1 {
  font-size: 28px;
  margin: 8px 0 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
h2 {
  font-size: 20px;
  margin: 32px 0 12px;
}
h3 { font-size: 16px; margin: 24px 0 8px; }
p, li { color: inherit; }
a { color: #6366f1; text-decoration: underline; text-underline-offset: 2px; }
a:hover { text-decoration: none; }
code {
  background: rgba(99, 102, 241, 0.10);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 0.92em;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
  font-size: 14px;
}
th, td {
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
th { background: rgba(99, 102, 241, 0.06); font-weight: 600; }
hr {
  border: none;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  margin: 28px 0;
}
ul, ol { padding-left: 24px; }
.footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  font-size: 12px;
  opacity: 0.7;
  text-align: center;
}
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #c9d1d9; }
  h1 { border-bottom-color: rgba(255, 255, 255, 0.16); }
  hr { border-top-color: rgba(255, 255, 255, 0.16); }
  th, td { border-color: rgba(255, 255, 255, 0.16); }
  th { background: rgba(99, 102, 241, 0.14); }
  code { background: rgba(99, 102, 241, 0.18); }
  a { color: #8b8df1; }
  .footer { border-top-color: rgba(255, 255, 255, 0.16); }
}
"""


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy · GitHub Star Kit</title>
  <meta name="description" content="Privacy policy for the GitHub Star Kit browser extension. No telemetry, no servers, fully local-first." />
  <meta name="robots" content="index, follow" />
  <style>{css}</style>
</head>
<body>
  <main>
    {body}
    <div class="footer">
      <a href="./">← back to home</a> ·
      <a href="https://github.com/yyymzzz/github-star-kit">source on GitHub</a>
    </div>
  </main>
</body>
</html>
"""


def main():
    if len(sys.argv) != 3:
        print("usage: render-privacy.py SOURCE.md OUTPUT.html", file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    with open(src, encoding="utf-8") as f:
        md_source = f.read()

    body_html = markdown.markdown(
        md_source,
        extensions=["tables", "fenced_code", "toc"],
        output_format="html5",
    )
    out = HTML_TEMPLATE.format(css=CSS, body=body_html)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"rendered {len(md_source)} chars MD → {len(out)} chars HTML at {dst}")


if __name__ == "__main__":
    main()
