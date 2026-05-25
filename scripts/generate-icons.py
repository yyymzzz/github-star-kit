#!/usr/bin/env python
"""Generate Chrome Web Store icon set (16/32/48/128 PNGs).

R42: produces apps/extension/icons/icon-{N}.png. Pure-Python (Pillow only)
so no Node-native binaries required. Re-run after any design change to
keep the 4 sizes in sync. Output is deterministic — tracking the PNGs
in git is fine.

Design rationale:
- Indigo (#6366f1) = the UI accent we use for tag chips / active filter
  buttons across popup + manage. Visual continuity from store listing
  → installed extension.
- White 5-point star = universally legible at 16px (CWS minimum) and
  reads as "GitHub star" without needing the wordmark.
- Rounded-square frame = matches modern browser extension icon idiom
  (Chrome itself, 1Password, etc.) better than a transparent star
  which gets lost in dark themes.

Usage:
    python scripts/generate-icons.py

Requires: Pillow (`pip install pillow`).
"""
import math
import os

from PIL import Image, ImageDraw


INDIGO = (99, 102, 241, 255)
WHITE = (255, 255, 255, 255)


def make_star_polygon(cx, cy, r_outer, r_inner, points=5):
    """5-point star polygon centered at (cx, cy)."""
    coords = []
    for i in range(points * 2):
        angle = -math.pi / 2 + i * math.pi / points
        r = r_outer if i % 2 == 0 else r_inner
        coords.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return coords


def make_icon(size, out_path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded square background. Radius scales with size so the corner
    # curvature reads the same at 16px and 128px.
    radius = max(2, size // 6)
    d.rounded_rectangle([(0, 0), (size, size)], radius=radius, fill=INDIGO)
    # White star, 72% of icon side (r_outer 0.36 = half of 0.72).
    cx, cy = size / 2, size / 2
    r_outer = size * 0.36
    r_inner = r_outer * 0.45
    d.polygon(make_star_polygon(cx, cy, r_outer, r_inner), fill=WHITE)
    img.save(out_path, "PNG", optimize=True)
    return os.path.getsize(out_path)


def main():
    out_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "apps", "extension", "icons",
    )
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon-{size}.png")
        bytes_written = make_icon(size, path)
        print(f"icon-{size}.png  {bytes_written}B")


if __name__ == "__main__":
    main()
