# Quasar IntelliSense

Fast, color-aware IntelliSense for the [Quasar Framework](https://quasar.dev) in `.vue` files.
It knows what actually renders in your app: the installed Quasar version is the ground truth,
and your own brand colors, custom classes, and icon sets are first-class citizens.

## Features

### Completions

- **CSS classes with color swatches** in `class="..."`: the full Quasar utility set
  (spacing, flex, grid, typography, visibility, shadows...) plus every `text-*` / `bg-*`
  color class, each with a real swatch in the suggest list.
- **Color props**: `color=`, `text-color=`, `indicator-color=` and every other palette-valued
  prop of every Quasar component, derived from Quasar's own API metadata. Custom component
  props ending in `-color` complete too.
- **Icon names with previews**: `icon=`, `<q-icon name=`, and any `*-icon` prop complete with
  names from the icon sets your project actually loads (Material Icons and Symbols, MDI,
  Font Awesome, Bootstrap Icons, Line Awesome, Eva, Themify, Ionicons). The docs panel shows
  a rendered preview of the selected icon.
- **Your custom colors included**: hand-written `.text-X` / `.bg-X` rules, `$brand` sass
  variables wherever they live, `--q-primary` / `--anything` theme custom properties, and
  `framework.config.brand` in quasar.config. All watched live: save a file, completions update.

### In the editor

- **Inline color squares** next to color classes and prop values in templates.
- **Inline icon glyphs** next to icon names in templates and next to svg icon imports
  (`matClose`, `mdiAccount`...) in script. The glyph sits beside the name; your text is
  never replaced.
- **Minimal hovers**: color chip, hex value, and the real CSS rule. Nothing else.
- **Go to definition** on color names jumps to where the color is defined: your stylesheet
  rule, theme css, sass variable, quasar.config brand entry, or Quasar's own palette source.
- **Theme-aware**: colors defined per `.body--light` / `.body--dark` show the value matching
  your current editor theme; hovers show both values.

### Diagnostics and quick fixes

Warnings only where the extension can be certain, with one-click fixes:

- Unknown color names in Quasar color props (with "Change to ..." suggestions).
- Icon names that do not exist in the installed icon set, or that need a set your project
  does not load.
- Dead CSS variable chains: a color class whose value resolves to a `var(--q-x)` that is
  never defined anywhere in the workspace.
- Conflicting classes in one `class` attribute that set the same CSS property in the same
  media scope (`q-pa-md q-pa-sm`), and duplicated classes.

### Correctness rules

- Only names that actually render are offered: color names come from the real `.text-X` /
  `.bg-X` classes in the installed quasar.css, icon names are validated against the
  installed `@quasar/extras` exports.
- Responsive variants (`q-pa-md-lg`, `col-sm-6`...) are offered only when `cssAddon: true`
  is set in quasar.config.
- Projects using `iconMapFn` suppress all icon warnings automatically.

## Performance

Everything is precomputed and cached; nothing expensive runs while you type. The document is
scanned once per edit for all features combined, and completion lists are prebuilt and handed
to VS Code for client-side filtering. Typical numbers: index build under 1 ms, full
decorations plus diagnostics refresh under 0.1 ms on a 50 KB component.

## Requirements

- A workspace whose root `package.json` depends on `quasar` (v2). The extension stays fully
  dormant everywhere else.
- Vue language support (e.g. the official Vue extension) so `.vue` files have the `vue`
  language id.

## How it works

At startup the extension reads the Quasar version installed in your workspace
(`node_modules/quasar`) for the palette and component API, detects icon sets from your source
imports and quasar.config, and scans `src/**` styles for custom colors, with file watchers
for live updates. If Quasar's files are not readable, bundled snapshots are used.

## Settings

The extension contributes no settings of its own. It ships one configuration default so
completions pop while typing inside attribute values in `.vue` files:

```jsonc
"[vue]": { "editor.quickSuggestions": { "strings": "on" } }
```

## Known limitations

- Static template attributes only: `:class` object/array bindings and `<script>` contexts
  (e.g. `Notify.create`) are not completed. The policy is to stay silent rather than guess.
- Unknown `text-X` classes are never warned about, since they may be your own utilities
  outside the scan scope.

## Development

```bash
npm install
npm run generate-data   # regenerate data/* from the quasar devDependency
# F5 in VS Code to run the Extension Development Host (starts watch tasks)
npm run package         # build production + create .vsix
```

## Disclaimer

This is an unofficial community extension and is not affiliated with or endorsed by the
Quasar team. The Quasar name and logo are the property of their respective owners and are
used here to indicate compatibility with the Quasar Framework.

## License

[MIT](LICENSE)
