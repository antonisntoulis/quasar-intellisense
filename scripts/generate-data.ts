/**
 * Build-time data generation. Parses the quasar devDependency into data/*.json
 * so the extension does zero CSS parsing at runtime for the static class list.
 *
 *   npm run generate-data
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import postcss, { type Rule, type AtRule } from 'postcss'

const QUASAR = path.join(__dirname, '..', 'node_modules', 'quasar')
const OUT = path.join(__dirname, '..', 'data')

// ---------------------------------------------------------------- palette ---

const BRAND_NAMES = [
  'primary', 'secondary', 'accent', 'dark', 'dark-page',
  'positive', 'negative', 'info', 'warning',
]

function generatePalette(): Record<string, string> {
  const sass = fs.readFileSync(path.join(QUASAR, 'src/css/variables.sass'), 'utf8')
  const colors: Record<string, string> = {}
  const varRe = /^\$([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))\s*(?:!default)?\s*$/gm
  for (const m of sass.matchAll(varRe)) {
    colors[m[1]!] = m[2]!
  }
  // Names with classes but no sass color var
  colors['white'] = '#ffffff'
  colors['black'] = '#000000'
  colors['transparent'] = 'transparent'
  if (colors['separator-color']) colors['separator'] = colors['separator-color']
  if (colors['separator-dark-color']) colors['dark-separator'] = colors['separator-dark-color']
  return colors
}

// ---------------------------------------------------------------- classes ---

// q-* selectors are component internals except these utility families
const Q_UTILITY_RE = /^q-(p[atrblxy]-|m[atrblxy]-|gutter-|col-gutter-)/
const Q_UTILITY_EXACT = new Set(['q-link', 'q-focusable', 'q-hoverable', 'q-placeholder', 'q-electron-drag'])

const CATEGORY_RULES: Array<[RegExp, string, string]> = [
  [/^q-[pm][atrblxy]-/, 'spacing', 'https://quasar.dev/style/spacing'],
  [/^q-(col-)?gutter-/, 'gutter', 'https://quasar.dev/layout/grid/gutter'],
  [/^(col($|-)|offset-)/, 'grid', 'https://quasar.dev/layout/grid/row'],
  [/^(row|column|flex|inline$|reverse|wrap|no-wrap|reverse-wrap|order-|justify-|items-|content-|self-)/, 'flex', 'https://quasar.dev/layout/grid/row'],
  [/^text-(h[1-6]|subtitle[12]|body[12]|overline|caption|weight-|uppercase|lowercase|capitalize|center|left|right|justify|italic|bold|no-wrap|strike)/, 'typography', 'https://quasar.dev/style/typography'],
  [/^(shadow|inset-shadow|no-shadow)/, 'shadow', 'https://quasar.dev/style/shadows'],
  [/^z-/, 'z-index', 'https://quasar.dev/style/other-helper-classes'],
  [/^(absolute|fixed($|-)|relative-position|float-|vertical-|on-left|on-right|fullscreen)/, 'position', 'https://quasar.dev/style/positioning'],
  [/^(xs|sm|md|lg|xl|lt-(sm|md|lg|xl)|gt-(xs|sm|md|lg))($|-hide|-only)/, 'visibility', 'https://quasar.dev/style/visibility'],
  [/^(hidden|invisible|transparent|dimmed|light-dimmed|disabled|readonly|ellipsis|hide-scrollbar|print-|orientation-|desktop|mobile|native-mobile|cordova|capacitor|electron|touch|platform-|within-iframe)/, 'visibility', 'https://quasar.dev/style/visibility'],
  [/^(cursor-|non-selectable|no-pointer-events|all-pointer-events)/, 'mouse', 'https://quasar.dev/style/other-helper-classes'],
  [/^(scroll|no-scroll|overflow-)/, 'scroll', 'https://quasar.dev/style/other-helper-classes'],
  [/^(rotate-|flip-)/, 'transform', 'https://quasar.dev/style/other-helper-classes'],
  [/^(fit|full-height|full-width|window-|block|inline-block)/, 'size', 'https://quasar.dev/style/other-helper-classes'],
]

function categorize(name: string): { category: string; docsUrl: string } {
  for (const [re, category, docsUrl] of CATEGORY_RULES) {
    if (re.test(name)) return { category, docsUrl }
  }
  return { category: 'helper', docsUrl: 'https://quasar.dev/style/other-helper-classes' }
}

interface ClassEntry {
  name: string
  css: string
  category: string
  docsUrl: string
  summary?: string
  addon?: boolean
  /** css properties set, per scope key `${media}|${parentCtx}` */
  props?: Record<string, string[]>
}

interface ExtractedClass {
  blocks: string[]
  props: Record<string, string[]>
}

// ---- human-friendly summaries -----------------------------------------------

const SPACE_PX: Record<string, string> = { none: '0', xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '48px' }
const SIDES: Record<string, string> = {
  a: '', t: '-top', r: '-right', b: '-bottom', l: '-left', x: '-left & -right', y: '-top & -bottom',
}
const BP_MIN: Record<string, string> = { xs: '0', sm: '600px', md: '1024px', lg: '1440px', xl: '1920px' }

function summarize(name: string): string | undefined {
  let m = /^q-([pm])([atrblxy])-(?:(xs|sm|md|lg|xl)-)?(none|xs|sm|md|lg|xl|auto)$/.exec(name)
  if (m) {
    const prop = m[1] === 'p' ? 'padding' : 'margin'
    const value = m[4] === 'auto' ? 'auto' : SPACE_PX[m[4]!]
    const side = SIDES[m[2]!]!
    const bp = m[3] ? ` (at ≥${BP_MIN[m[3]!]})` : ''
    return side.includes('&')
      ? `${prop}${side.split(' & ').join(`: ${value}, ${prop}`)}: ${value}${bp}`
      : `${prop}${side}: ${value}${bp}`
  }
  m = /^(col|offset)-(?:(xs|sm|md|lg|xl)-)?(\d{1,2})$/.exec(name)
  if (m) {
    const n = Number(m[3])
    const pct = `${+((n / 12) * 100).toFixed(4)}%`
    const bp = m[2] ? ` at ≥${BP_MIN[m[2]!]}` : ''
    return m[1] === 'col'
      ? `width: ${pct} (${n} of 12 columns)${bp}`
      : `margin-left: ${pct} (offset ${n} of 12)${bp}`
  }
  if (/^col(-(xs|sm|md|lg|xl))?$/.test(name)) return 'grows to fill available space (flex: 10000 1 0%)'
  if (/^col(-(xs|sm|md|lg|xl))?-auto$/.test(name)) return 'sized to its content (flex: 0 0 auto)'
  m = /^q-(col-)?gutter(-x|-y)?-(?:(xs|sm|md|lg|xl)-)?(none|xs|sm|md|lg|xl)$/.exec(name)
  if (m) {
    const axis = m[2] === '-x' ? 'horizontal ' : m[2] === '-y' ? 'vertical ' : ''
    return `${SPACE_PX[m[4]!]} ${axis}gap between children${m[1] ? ' (grid columns)' : ''}`
  }
  return undefined
}

interface MergedRule {
  parentCtx?: string
  media?: string
  decls: Map<string, string>
}

/**
 * Extract utility classes: selectors that are exactly one class name,
 * or a simple `parent > .class` (quasar defines col-* widths that way).
 * Declarations are cascade-merged per (parent context, media query): rules
 * with the same context and equal specificity collapse into one block with
 * later declarations winning, exactly as the browser resolves them. This is
 * what keeps col-* hovers short.
 */
function extractClasses(cssText: string, colorNames: Set<string>): Map<string, ExtractedClass> {
  const root = postcss.parse(cssText)
  const merged = new Map<string, Map<string, MergedRule>>()

  root.walkRules((rule: Rule) => {
    // keyframes contain % selectors etc.
    const parent = rule.parent
    if (parent?.type === 'atrule' && /keyframes/.test((parent as AtRule).name)) return

    let media: string | undefined
    if (parent?.type === 'atrule') {
      const at = parent as AtRule
      // (min-width: 0) is sass-generation noise, not information
      if (!(at.name === 'media' && /min-width:\s*0\b/.test(at.params))) {
        media = `@${at.name} ${at.params}`
      }
    }

    for (const sel of rule.selectors) {
      const trimmed = sel.trim()
      let name: string
      let parentCtx: string | undefined
      const simple = /^\.([A-Za-z][\w-]*)$/.exec(trimmed)
      const child = /^([.\w-]+)\s*>\s*\.([A-Za-z][\w-]*)$/.exec(trimmed)
      if (simple) name = simple[1]!
      else if (child) {
        name = child[2]!
        parentCtx = child[1]!
      } else continue

      // color classes are derived from the palette at runtime, not stored
      const colorMatch = /^(?:text|bg)-(.+)$/.exec(name)
      if (colorMatch && colorNames.has(colorMatch[1]!)) continue

      // component internals
      if (name.startsWith('q-') && !Q_UTILITY_RE.test(name) && !Q_UTILITY_EXACT.has(name)) continue
      // stray icon-font classes
      if (/^(material-|mdi|ion-|fa[srlb]?$|ti-|bt-|eva-)/.test(name)) continue

      const contexts = merged.get(name) ?? new Map<string, MergedRule>()
      const key = `${parentCtx ?? ''}|${media ?? ''}`
      const target = contexts.get(key) ?? { parentCtx, media, decls: new Map<string, string>() }
      for (const n of rule.nodes) {
        if (n.type !== 'decl') continue
        target.decls.delete(n.prop) // later declaration wins AND moves to cascade position
        target.decls.set(n.prop, n.value + (n.important ? ' !important' : ''))
      }
      if (target.decls.size > 0) {
        contexts.set(key, target)
        merged.set(name, contexts)
      }
    }
  })

  const result = new Map<string, ExtractedClass>()
  for (const [name, contexts] of merged) {
    const rendered: string[] = []
    const props: Record<string, string[]> = {}
    for (const [key, { parentCtx, media, decls }] of contexts) {
      props[key] = [...decls.keys()]
      // for grid classes the .flex context is "row or column" boilerplate,
      // fully covered by the .row/.column blocks
      if (parentCtx === '.flex' && /^(col|offset)/.test(name) && contexts.size > 2) continue
      const body = [...decls].map(([prop, value]) => `  ${prop}: ${value};`).join('\n')
      let block = `${parentCtx ? `/* inside ${parentCtx} */\n` : ''}.${name} {\n${body}\n}`
      if (media) block = `${media} {\n${block.replace(/^/gm, '  ')}\n}`
      rendered.push(block)
    }
    result.set(name, { blocks: rendered, props })
  }
  return result
}

function generateClasses(colorNames: Set<string>): ClassEntry[] {
  const baseCss = fs.readFileSync(path.join(QUASAR, 'dist/quasar.css'), 'utf8')
  const addonCss = fs.readFileSync(path.join(QUASAR, 'dist/quasar.addon.css'), 'utf8')

  const base = extractClasses(baseCss, colorNames)
  const addon = extractClasses(addonCss, colorNames)

  const entries: ClassEntry[] = []
  for (const [name, { blocks, props }] of base) {
    const summary = summarize(name)
    entries.push({ name, css: blocks.join('\n'), ...categorize(name), ...(summary && { summary }), props })
  }
  for (const [name, { blocks, props }] of addon) {
    if (base.has(name)) continue
    const summary = summarize(name)
    entries.push({
      name, css: blocks.join('\n'), ...categorize(name), ...(summary && { summary }), props, addon: true,
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

// ------------------------------------------------------------ color props ---

const kebab = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()

/**
 * A prop takes a palette color when quasar tags it NamedColor, or (quasar's own
 * metadata is inconsistent: QDate.event-color, QEditor.toolbar-toggle-color)
 * when a String prop's description references the Quasar palette.
 */
function isColorProp(def: { tsType?: string; type?: unknown; desc?: string }): boolean {
  if (def?.tsType === 'NamedColor') return true
  const type = Array.isArray(def?.type) ? def.type : [def?.type]
  return type.includes('String') && /quasar (color )?palette/i.test(def?.desc ?? '')
}

function generateColorProps(): { components: Record<string, string[]>; propNames: string[] } {
  const apiDir = path.join(QUASAR, 'dist/api')
  const components: Record<string, string[]> = {}
  const propNames = new Set<string>()

  for (const file of fs.readdirSync(apiDir)) {
    if (!file.endsWith('.json')) continue
    const api = JSON.parse(fs.readFileSync(path.join(apiDir, file), 'utf8'))
    const props = api.props as Record<string, { tsType?: string; type?: unknown; desc?: string }> | undefined
    if (!props) continue
    const colorProps = Object.entries(props)
      .filter(([, def]) => isColorProp(def))
      .map(([key]) => kebab(key))
    if (colorProps.length > 0) {
      components[kebab(path.basename(file, '.json'))] = colorProps
      colorProps.forEach((p) => propNames.add(p))
    }
  }
  return { components, propNames: [...propNames].sort() }
}

/** ground truth: color names are exactly the X with a .bg-X class in quasar.css */
function generateColorNames(): string[] {
  const css = fs.readFileSync(path.join(QUASAR, 'dist/quasar.css'), 'utf8')
  const names = new Set<string>()
  for (const m of css.matchAll(/\.bg-([a-zA-Z][\w-]*)/g)) names.add(m[1]!)
  return [...names].sort()
}

// ------------------------------------------------------------- icon props ---

/** icon-valued props quasar's api metadata doesn't mark with the CONV phrase */
const EXTRA_ICON_PROPS: Record<string, string[]> = {
  'q-checkbox': ['checked-icon', 'unchecked-icon', 'indeterminate-icon'],
  'q-radio': ['checked-icon', 'unchecked-icon'],
  'q-toggle': ['checked-icon', 'unchecked-icon', 'indeterminate-icon'],
  'q-expansion-item': ['expanded-icon'],
  'q-field': ['clear-icon'],
  'q-file': ['clear-icon'],
  'q-input': ['clear-icon'],
  'q-select': ['clear-icon'],
  'q-pull-to-refresh': ['icon'],
  'q-route-tab': ['alert-icon'],
  'q-tab': ['alert-icon'],
  'q-tabs': ['left-icon', 'right-icon'],
}

function generateIconProps(): { components: Record<string, string[]>; propNames: string[] } {
  const apiDir = path.join(QUASAR, 'dist/api')
  const components: Record<string, Set<string>> = {}
  for (const file of fs.readdirSync(apiDir)) {
    if (!file.endsWith('.json')) continue
    const api = JSON.parse(fs.readFileSync(path.join(apiDir, file), 'utf8'))
    const props = api.props as Record<string, { type?: unknown; desc?: string }> | undefined
    if (!props) continue
    const comp = kebab(path.basename(file, '.json'))
    for (const [key, def] of Object.entries(props)) {
      if (/Icon name following Quasar convention/i.test(def?.desc ?? '')) {
        ;(components[comp] ??= new Set()).add(kebab(key))
      }
    }
  }
  for (const [comp, props] of Object.entries(EXTRA_ICON_PROPS)) {
    for (const p of props) (components[comp] ??= new Set()).add(p)
  }
  const propNames = new Set<string>()
  const out: Record<string, string[]> = {}
  for (const [comp, props] of Object.entries(components)) {
    out[comp] = [...props].sort()
    props.forEach((p) => propNames.add(p))
  }
  return { components: out, propNames: [...propNames].sort() }
}

// ---------------------------------------------- material ligature names -----

const CODEPOINTS = {
  icons:
    'https://raw.githubusercontent.com/google/material-design-icons/master/font/MaterialIcons-Regular.codepoints',
  symbols:
    'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints',
}

/**
 * Authoritative webfont ligature names for material icons/symbols — the one
 * dataset @quasar/extras doesn't ship. Downloaded once from Google's repo;
 * falls back to the committed data file when offline.
 */
async function generateMaterialLigatures(): Promise<{ icons: string[]; symbols: string[] }> {
  const existing = path.join(OUT, 'material-ligatures.json')
  try {
    const [icons, symbols] = await Promise.all(
      Object.values(CODEPOINTS).map(async (url) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status} ${url}`)
        const text = await res.text()
        return [...new Set(text.split('\n').map((l) => l.split(' ')[0]!).filter(Boolean))].sort()
      }),
    )
    return { icons: icons!, symbols: symbols! }
  } catch (err) {
    if (fs.existsSync(existing)) {
      console.warn(`codepoints download failed (${String(err)}), keeping committed data`)
      return JSON.parse(fs.readFileSync(existing, 'utf8'))
    }
    throw err
  }
}

// -------------------------------------------------------------------- run ---

async function main(): Promise<void> {
const palette = generatePalette()
const paletteNames = new Set(Object.keys(palette).filter((n) => !n.endsWith('-color')))
BRAND_NAMES.forEach((n) => paletteNames.add(n))

const classes = generateClasses(paletteNames)
const colorProps = generateColorProps()
const colorNames = generateColorNames()
const iconProps = generateIconProps()
const ligatures = await generateMaterialLigatures()

fs.mkdirSync(OUT, { recursive: true })
// .json for inspection/tooling; .ts modules embed the same data as a JSON string
// because V8 executes JSON.parse('...') ~10x faster than a JS object literal
// (measured: 8.2ms literal eval vs 0.7ms JSON.parse at activation)
function writeData(name: string, data: unknown): void {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 1))
  fs.writeFileSync(
    path.join(OUT, `${name}.ts`),
    `// generated by scripts/generate-data.ts — do not edit\n` +
    `export default JSON.parse(${JSON.stringify(JSON.stringify(data))})\n`,
  )
}
writeData('palette-snapshot', palette)
writeData('classes', classes)
writeData('color-props', colorProps)
writeData('color-names', colorNames)
writeData('icon-props', iconProps)
writeData('material-ligatures', ligatures)

const quasarVersion = JSON.parse(fs.readFileSync(path.join(QUASAR, 'package.json'), 'utf8')).version
const addonCount = classes.filter((c) => c.addon).length
console.log(`quasar ${quasarVersion}`)
console.log(`color-class names: ${colorNames.length}`)
console.log(`palette entries:   ${Object.keys(palette).length}`)
console.log(`utility classes:   ${classes.length - addonCount} (+${addonCount} cssAddon)`)
console.log(`color-prop comps:  ${Object.keys(colorProps.components).length}`)
console.log(`color-prop names:  ${colorProps.propNames.length} -> ${colorProps.propNames.join(', ')}`)
console.log(`icon-prop comps:   ${Object.keys(iconProps.components).length}`)
console.log(`icon-prop names:   ${iconProps.propNames.length} -> ${iconProps.propNames.join(', ')}`)
console.log(`material ligatures: ${ligatures.icons.length} icons, ${ligatures.symbols.length} symbols`)

// sanity checks against known-good counts (research 2026-07)
const names = new Set(classes.map((c) => c.name))
const mustHave = ['col-6', 'q-gutter-md', 'q-pa-md', 'row', 'flex-center', 'text-h4', 'shadow-2', 'absolute-center', 'ellipsis']
const missing = mustHave.filter((n) => !names.has(n))
if (missing.length > 0) {
  console.error(`MISSING expected classes: ${missing.join(', ')}`)
  process.exit(1)
}
const paletteFamilies = ['red-5', 'blue-grey-14', 'deep-orange-1']
const missingColors = paletteFamilies.filter((n) => !palette[n])
if (missingColors.length > 0) {
  console.error(`MISSING palette colors: ${missingColors.join(', ')}`)
  process.exit(1)
}
console.log('sanity checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
