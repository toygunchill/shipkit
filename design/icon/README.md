# Icon

A branch leaving a trunk, a commit at its head, and a gate standing in front of
it. Every candidate was built on that idea — shipkit's job is to stand between
finished work and the branch — and this one was chosen because it is the only
one that says *version control* as well as *stopped*. The others said stop and
could have sat in any toolbar.

## Files

| File | What it is |
|---|---|
| `mark.svg` | The mark, 16×16, monochrome, `currentColor` |
| `mark-pending.svg` | The same with an approval waiting |
| `app-icon.svg` | The colour app icon, 1024×1024 |
| `candidates/` | The three that lost, kept as the record |

`scripts/icons.sh` renders `app-icon.svg` into an `.iconset` and an `.icns`.
Its output is git-ignored — it is derived, and one command rebuilds it.

The menu-bar mark is **not** rendered to an image. It is drawn in SwiftUI, in
`apps/menubar/Sources/ShipkitMenuBar/ShipkitMark.swift`, so it stays sharp at
whatever height the bar happens to be and takes the system tint the way a
template image would. `mark.svg` is the same drawing and remains the reference
for anything that needs a file — a README, a website, a slide.

## The pending state changes shape, not colour

A menu-bar icon is tinted by the system, so it cannot signal anything with
colour. It also cannot signal much with a small addition: at 16pt a speck is not
a state anyone notices. So when an approval is waiting the gate shortens and a
dot appears above it, and the silhouette itself is different.

## Two things are approximations, on purpose

**The app icon's corner** is a circular-radius rounded rectangle at Apple's
proportion (185 of 824, about 22.4%), not a true continuous squircle. Fitting
the superellipse to cubics overshot the flat sides by enough to look worse than
the approximation, and drawing Apple's exact construction is its own piece of
work. At icon sizes the difference is subtle. If it ever matters, one path
changes and nothing else does.

**The renders come from Quick Look**, because no SVG rasteriser is installed.
It is accurate at 1024 and everything else is resampled down from there — which
is also why `scripts/icons.sh` renders once and resamples rather than rendering
each size, since rendering small sizes directly produced a nearly empty canvas.

## Rejected, and why

- **A trunk with a bar across it** read as a letterform, somewhere between H
  and W. In a mark this small that is the first thing to throw away.
- **Two posts with a line between them** was also a letterform, and what
  survived of it looked like an alignment control.
- **A node stopped by a bar** was perfectly legible and said nothing about
  version control.

Two of the first four were letterforms — the exact failure the brief for this
work warned about. They only became obvious once rendered and looked at.
