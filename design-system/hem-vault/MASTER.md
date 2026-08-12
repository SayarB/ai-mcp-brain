# Hem Vault Design System

> **Source of truth for the marketing site.** Overrides the auto-generated Modern Dark / Inter defaults to honor product plan + workspace frontend rules (no dark-mode bias, no Inter, no purple/glow).

## Brand

- **Name:** Hem Vault
- **Tagline:** Memory that outlasts the chat
- **Support:** Obsidian vault + MCP so coding agents keep decisions, process, and today’s work
- **Repo id:** ai-mcp-brain (technical; secondary on site)

## Design dials

- Variance: 4/10 (balanced)
- Motion: 5/10 (standard scroll reveal)
- Density: 3/10 (spacious marketing)

## Pattern

Hero → What it is → Features (link to docs) → How it fits → Docs CTA → Install CTA

Landing pattern: Product Demo + Features (vault SVG as the demo visual).

## Visual direction — Workshop archive

| Role | Token | Hex |
|------|-------|-----|
| Ink / text | `--color-ink` | `#1a1f1c` |
| Paper / bg | `--color-paper` | `#f3efe6` |
| Paper deep | `--color-paper-deep` | `#e8e2d4` |
| Accent (oxidized teal) | `--color-accent` | `#2f6f68` |
| Accent hover | `--color-accent-hover` | `#245851` |
| On accent | `--color-on-accent` | `#f7f4ec` |
| Muted text | `--color-muted` | `#5c635e` |
| Line / border | `--color-line` | `#c9c2b2` |
| Shelf shadow | `--color-shelf` | `#d4cdc0` |

Light mode primary. No purple gradients, no glow, no glassmorphism blobs.

## Typography

- **Display / brand:** Fraunces (Google Fonts)
- **Body / UI:** Figtree (Google Fonts)
- Do **not** use Inter, Roboto, Arial, or system-ui as the brand face

```css
@import url('https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,650;9..144,700&display=swap');
```

## Motion

- Hero: fade/rise 350–450ms, `cubic-bezier(0.16, 1, 0.3, 1)`
- Sections: scroll reveal opacity + y 12–16px, stagger ≤6 children
- Respect `prefers-reduced-motion: reduce`
- No GSAP required for v1 (CSS + IntersectionObserver)

## Effects

- Full-bleed SVG vault illustration as hero visual anchor
- Soft paper grain / warm wash — not flat single fill
- CTA: solid accent, 150–250ms hover darken; focus ring visible

## Anti-patterns (do not ship)

- Dark-first cinematic / indigo glow / frosted glass nav
- Inter-only typography
- Cards in the hero; floating badges/chips on hero media
- Purple-on-white or cream+terracotta+serif broadsheet clichés
- Emoji as icons

## Pre-delivery

- [ ] Contrast ≥ 4.5:1 on body text
- [ ] Focus states visible
- [ ] cursor-pointer on clickable elements
- [ ] Mobile 375 / tablet 768 / desktop 1024+
- [ ] prefers-reduced-motion
