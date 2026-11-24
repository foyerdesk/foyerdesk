# Brand

Assets are in `assets/brand/`: `logo.svg` (light backgrounds), `logo-dark.svg` (dark backgrounds), `icon.svg`, `favicon.svg`, `social-preview.png` (1280 × 640).

## Colours
| Role | Value |
|---|---|
| Brand gradient (icon back bubble) | `#38BDF8` to `#2563EB` |
| Brand blue (logo "Desk", dots) | `#2563EB` |
| Brand navy (logo "Foyer" on light) | `#0B1742` |
| Icon outline on white | `#7DB3F5` |
| Screens: accent / hover | `#1F93FF` / `#1678D4` (dark: `#3AA0FF` / `#2F86E0`) |
| Screens: text / muted / border / background | `#1E293B` / `#64748B` / `#E2E8F0` / `#F8FAFC` |
| Status badges | Open `#DBEAFE` on `#1D4ED8`, Resolved `#DCFCE7` on `#15803D`, Pending `#FEF9C3` on `#A16207` |

The screens' colours are CSS variables on `.fd`, so a site can adopt its own accent without touching the code.

## Typography
Logo wordmark: Inter, weight 750, tight letter spacing, falling back to Arial and Helvetica. Screens: the system font stack (`-apple-system, Segoe UI, Roboto`), 15 px body, headings 1.1 to 1.4 rem, small labels 13 px. Where exact lettering matters (print, app stores) export the wordmark to paths first.

## Use
Keep clear space of at least the height of the icon's dots on all sides. Do not recolour the icon, stretch it, or put the light logo on a dark background (use `logo-dark.svg`). On white, the white bubble keeps its thin blue outline.
