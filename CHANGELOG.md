# Changelog

## 0.4.0 (2026-08-01)

First Marketplace release.

- Status bar badge with the Quasar logo and the installed Quasar version, shown only when
  a quasar project is detected. The tooltip summarizes detected versions, class and color
  counts, icon sets, and css addon state; clicking opens the extension log.
- Stricter dormancy: in workspaces without quasar the extension does nothing beyond a
  single package.json read (no watchers, scans, providers, or UI).
- Install-flavor support, verified against scaffolded projects of each flavor: the quasar
  app may live in a monorepo sub-package with hoisted `node_modules` (both discovered
  automatically), and the css addon is detected from `quasar.addon.css` / `flex-addon`
  imports in sources and styles as well as from `cssAddon: true` in quasar.config.
- Performance: all template-derived features (color decorations, icon decorations,
  diagnostics, class-conflict checks) now share a single tag-aware document scan, cached
  per document version. A full decorations plus diagnostics refresh is about 3x faster
  (0.14 ms to 0.05 ms on a real 53 KB component, 5.5 ms to 1.9 ms on a synthetic 200 KB
  document), and index rebuilds on theme or style changes are about 2x faster.
- Marketplace metadata: publisher, icon, keywords, gallery banner, changelog, and a
  rewritten README covering the full feature set.
- Internal cleanup: removed dead code paths and deduplicated helpers. No behavior changes
  (verified output-identical on a 411-file real-world project).

## 0.1.0 to 0.3.2 (pre-release, 2026)

Internal development releases, tested against real Quasar projects.

- Completions with color swatches for Quasar CSS utility classes and `text-*` / `bg-*`
  color classes, and for component color props derived from Quasar's API metadata.
- Custom color support: `.text-X` / `.bg-X` rules, pooled `$var` sass definitions,
  `--q-X` theme custom properties with light/dark awareness, and `framework.config.brand`,
  all live-updated by file watchers with incremental per-file rescans.
- Minimal hovers (color chip, hex, CSS rule), inline color square decorations, and
  go to definition for color names.
- Icon support: set detection from source imports and quasar.config, icon name completions
  validated against the installed `@quasar/extras`, rendered previews in the suggest docs
  panel and on hover, and inline glyph decorations in templates and script imports.
- Diagnostics with quick fixes: unknown colors and icons (with did-you-mean suggestions),
  dead CSS variable chains, conflicting and duplicated classes.
- `cssAddon` gating for responsive class variants.
