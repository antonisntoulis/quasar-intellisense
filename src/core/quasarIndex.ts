import { parse as parseColor, formatHex, formatRgb } from 'culori'
import { parseSassVariables, resolveSassValue } from './sassVars'
import { parseQuasarConfig } from './customColors'
import type {
  ClassEntry, ColorDef, ColorPropsData, CustomColorRule, SassVarDef, SourceLocation,
  ThemeVarDef, UtilityClass,
} from './types'

import bundledClasses from '../../data/classes'
import bundledColorProps from '../../data/color-props'
import bundledPalette from '../../data/palette-snapshot'
import bundledColorNames from '../../data/color-names'
import bundledIconProps from '../../data/icon-props'
import type { AttrKind } from './context'

export const BRAND_NAMES = [
  'primary', 'secondary', 'accent', 'dark',
  'positive', 'negative', 'info', 'warning',
] as const

/**
 * Color names with an actual .text-X/.bg-X class in quasar.css. Palette sass
 * variables outside this set ($elevation-umbra, $menu-background, ...) hold
 * color values but render nothing as a class or color prop: never offer them.
 */
const VALID_COLOR_NAMES = new Set(bundledColorNames as string[])

/** quasar props named *-color that are booleans, not palette colors */
const NON_COLOR_PROPS = new Set(['keep-color'])

const COLOR_DOCS_URL = 'https://quasar.dev/style/color-palette'

/** conflict pairs for color classes (shared: every text-X sets `color`, ...) */
const TEXT_COLOR_CONFLICTS = [['|::color', 'color']] as const
const BG_COLOR_CONFLICTS = [['|::background', 'background']] as const

function toUtilityEntry(u: UtilityClass): ClassEntry {
  const entry: ClassEntry = {
    name: u.name, kind: 'utility', css: u.css, category: u.category,
    docsUrl: u.docsUrl, summary: u.summary,
  }
  if (u.props) {
    entry.conflictProps = Object.entries(u.props)
      .flatMap(([scope, props]) => props.map((p) => [`${scope}::${p}`, p] as const))
  }
  return entry
}

/** bundled utilities never change: their entries are built exactly once */
const ALL_UTILITIES = bundledClasses as unknown as UtilityClass[]
const BASE_UTILITY_ENTRIES = ALL_UTILITIES.filter((u) => !u.addon).map(toUtilityEntry)
const ADDON_UTILITY_ENTRIES = ALL_UTILITIES.filter((u) => u.addon).map(toUtilityEntry)

export interface StaticInputs {
  /** contents of node_modules/quasar/src/css/variables.sass, if installed */
  variablesSassText?: string
  /** absolute path of that file, for go-to-definition on palette colors */
  variablesSassPath?: string
  /** color-prop table from the workspace's quasar dist/api, if installed */
  colorProps?: ColorPropsData
}

export interface CustomInputs {
  /** $var definitions pooled from every scanned workspace sass file */
  sassVarPool?: SassVarDef[]
  /** --q-X declarations found in workspace stylesheets */
  themeVars?: ThemeVarDef[]
  quasarConfigText?: string
  quasarConfigFile?: string
  stylesheetRules?: CustomColorRule[]
  /** a quasar.addon.css / flex-addon import exists in a scanned stylesheet */
  addonCssImported?: boolean
}

interface Swatch {
  swatch?: string
  hex?: string
  alpha?: boolean
}

interface ThemeGroup {
  light?: string
  dark?: string
  file: string
  line: number
  locations: SourceLocation[]
}

/** rebuild re-derives the same ~300 palette swatches every time: cache parses */
const swatchCache = new Map<string, Swatch>()

function toSwatch(value: string): Swatch {
  const cached = swatchCache.get(value)
  if (cached) return cached
  if (swatchCache.size > 2000) swatchCache.clear() // user-authored values are unbounded

  const c = parseColor(value)
  let result: Swatch
  if (!c) result = {}
  else if (c.alpha === 0) result = { alpha: true } // fully transparent: no misleading swatch
  else {
    const alpha = c.alpha !== undefined && c.alpha < 1
    result = { swatch: alpha ? formatRgb(c) : formatHex(c), hex: formatHex(c), alpha }
  }
  swatchCache.set(value, result)
  return result
}

export class QuasarIndex {
  /** bumped on every rebuild; adapter uses it to invalidate prebuilt items */
  version = 0

  colors = new Map<string, ColorDef>()
  classEntries: ClassEntry[] = []
  classByName = new Map<string, ClassEntry>()
  colorPropNames = new Set<string>()
  iconPropNames = new Set<string>(
    ((bundledIconProps as { propNames: string[] }).propNames).filter((n) => n !== 'name'),
  )
  cssAddon = false
  activeTheme: 'light' | 'dark' = 'dark'

  private palette = new Map<string, string>()
  private paletteLines = new Map<string, number>()
  private variablesSassPath: string | undefined
  private custom: CustomInputs = {}
  /** addon css imported in a source file (detected by the icon-set scan) */
  private addonFromSource = false

  constructor(staticInputs: StaticInputs = {}) {
    this.variablesSassPath = staticInputs.variablesSassPath
    this.palette = staticInputs.variablesSassText
      ? this.paletteFromSass(staticInputs.variablesSassText)
      : new Map(Object.entries(bundledPalette as Record<string, string>))

    const props = staticInputs.colorProps ?? (bundledColorProps as ColorPropsData)
    this.colorPropNames = new Set(props.propNames)

    this.rebuild()
  }

  setCustomInputs(custom: CustomInputs): void {
    this.custom = custom
    this.rebuild()
  }

  setActiveTheme(theme: 'light' | 'dark'): void {
    if (theme === this.activeTheme) return
    this.activeTheme = theme
    this.rebuild()
  }

  /** swap in the runtime-walked color-prop table (arrives async after activation) */
  setColorProps(props: ColorPropsData): void {
    this.colorPropNames = new Set(props.propNames)
    this.version++ // prop names shape template scans: invalidate per-version caches
  }

  /** non-CLI flavors enable the css addon by importing quasar.addon.css / flex-addon */
  setAddonCssImported(imported: boolean): void {
    if (imported === this.addonFromSource) return
    this.addonFromSource = imported
    this.rebuild()
  }

  isColorProp(attrName: string): boolean {
    if (this.colorPropNames.has(attrName)) return true
    // users' own components take color props too (subtitle-color, chip-text-color, ...)
    return (attrName === 'color' || attrName.endsWith('-color')) && !NON_COLOR_PROPS.has(attrName)
  }

  isIconProp(attrName: string, tagName?: string): boolean {
    // 'name' is only an icon prop on <q-icon> — far too generic otherwise
    if (attrName === 'name') return tagName === 'q-icon'
    if (this.iconPropNames.has(attrName)) return true
    // users' own components: any *-icon prop, excluding known non-icon names
    return attrName === 'icon' || attrName.endsWith('-icon')
  }

  /** single classifier for context detection: color props win ties (icon-color) */
  classifyAttr = (attrName: string, tagName: string | undefined): AttrKind | null => {
    if (this.isColorProp(attrName)) return 'colorProp'
    if (this.isIconProp(attrName, tagName)) return 'iconProp'
    return null
  }

  resolveColor(name: string): ColorDef | undefined {
    return this.colors.get(name)
  }

  // ------------------------------------------------------------- internal --

  private paletteFromSass(text: string): Map<string, string> {
    const vars = parseSassVariables(text)
    const map = new Map<string, string>()
    for (const [name, { value, line }] of vars) {
      const resolved = resolveSassValue(value, vars)
      if (resolved && parseColor(resolved)) {
        map.set(name, resolved)
        this.paletteLines.set(name, line)
      }
    }
    map.set('white', '#ffffff')
    map.set('black', '#000000')
    map.set('transparent', 'transparent')
    const sep = map.get('separator-color')
    const darkSep = map.get('separator-dark-color')
    if (sep) map.set('separator', sep)
    if (darkSep) map.set('dark-separator', darkSep)
    return map
  }

  /** $var pool as a lookup map; files named like "variables" win conflicts */
  private buildVarPool(): Map<string, SassVarDef> {
    const defs = [...(this.custom.sassVarPool ?? [])]
    defs.sort((a, b) => Number(/variables/i.test(a.file)) - Number(/variables/i.test(b.file)))
    const map = new Map<string, SassVarDef>()
    for (const def of defs) map.set(def.name, def) // later (variables files) win
    return map
  }

  /** --q-X declarations grouped per color name with per-theme values */
  private buildThemeGroups(): Map<string, ThemeGroup> {
    const groups = new Map<string, ThemeGroup>()
    for (const tv of this.custom.themeVars ?? []) {
      const g = groups.get(tv.name) ?? { file: tv.file, line: tv.line, locations: [] }
      if (tv.theme === 'light' || tv.theme === 'both') g.light = g.light ?? tv.value
      if (tv.theme === 'dark' || tv.theme === 'both') g.dark = g.dark ?? tv.value
      g.locations.push({ file: tv.file, line: tv.line })
      groups.set(tv.name, g)
    }
    return groups
  }

  private themeValue(g: ThemeGroup): string | undefined {
    return this.activeTheme === 'dark' ? g.dark ?? g.light : g.light ?? g.dark
  }

  private rebuild(): void {
    const colors = new Map<string, ColorDef>()
    const pool = this.buildVarPool()
    const poolValues = new Map([...pool].map(([k, v]) => [k, v.value]))
    const themeGroups = this.buildThemeGroups()

    // 1. static palette (red, red-1..14, white, black, ...) restricted to
    //    names whose classes actually exist in quasar.css
    const paletteLoc = (name: string): SourceLocation[] | undefined => {
      const line = this.paletteLines.get(name)
      return this.variablesSassPath && line ? [{ file: this.variablesSassPath, line }] : undefined
    }
    for (const [name, value] of this.palette) {
      if (!VALID_COLOR_NAMES.has(name)) continue
      colors.set(name, { name, value, source: 'palette', locations: paletteLoc(name), ...toSwatch(value) })
    }
    // brand defaults get their own source label
    for (const name of BRAND_NAMES) {
      const value = this.palette.get(name)
      if (value) {
        colors.set(name, {
          name, value, source: 'brand-default', locations: paletteLoc(name), ...toSwatch(value),
        })
      }
    }

    // 2. pooled $vars override brand values ($primary: ... anywhere in workspace sass)
    for (const name of BRAND_NAMES) {
      const def = pool.get(name)
      if (!def) continue
      const resolved = this.resolveValue(def.value, poolValues, themeGroups)
      if (resolved) {
        colors.set(name, {
          name, value: resolved, source: 'variables-file',
          file: def.file, line: def.line,
          locations: [{ file: def.file, line: def.line }],
          ...toSwatch(resolved),
        })
      }
    }

    // 3. hand-written .text-X/.bg-X stylesheet rules (text- wins over bg- for value)
    const byName = new Map<string, CustomColorRule>()
    const ruleLocations = new Map<string, SourceLocation[]>()
    for (const rule of this.custom.stylesheetRules ?? []) {
      const existing = byName.get(rule.name)
      if (!existing || (existing.kind === 'bg' && rule.kind === 'text')) byName.set(rule.name, rule)
      const locs = ruleLocations.get(rule.name) ?? []
      locs.push({ file: rule.file, line: rule.line })
      ruleLocations.set(rule.name, locs)
    }
    for (const [name, rule] of byName) {
      const resolved = this.resolveValue(rule.value, poolValues, themeGroups)
      colors.set(name, {
        name, value: resolved ?? rule.value, source: 'stylesheet',
        file: rule.file, line: rule.line,
        locations: ruleLocations.get(name),
        ...(resolved ? toSwatch(resolved) : {}),
      })
    }

    // 4. custom-property theme css overrides the *value* of known colors
    //    (--q-primary targets 'primary'; plain --muted targets 'muted');
    //    swatch follows the editor theme, hover shows both values
    for (const [varName, group] of themeGroups) {
      const colorName = varName.startsWith('q-') ? varName.slice(2) : varName
      const existing = colors.get(colorName)
      if (!existing) continue // a custom property alone creates no .text-X/.bg-X class
      const value = this.themeValue(group)
      if (!value) continue
      const resolved = this.resolveValue(value, poolValues, themeGroups) ?? value
      colors.set(colorName, {
        ...existing,
        value: resolved,
        source: existing.source === 'stylesheet' ? 'stylesheet' : 'theme-css',
        file: existing.file ?? group.file,
        line: existing.line ?? group.line,
        themeValues: { light: group.light, dark: group.dark },
        locations: [...(existing.locations ?? []), ...group.locations],
        ...toSwatch(resolved),
      })
    }

    // 5. quasar.config brand: highest precedence (applied as inline style at
    //    runtime). Only overrides *values* of existing colors: a custom brand
    //    key alone creates the --q-X variable but no .text-X/.bg-X class, so
    //    it would not render as a class or color prop.
    let configAddon = false
    if (this.custom.quasarConfigText) {
      const config = parseQuasarConfig(this.custom.quasarConfigText)
      configAddon = config.cssAddon
      for (const [name, { value, line }] of Object.entries(config.brand)) {
        const existing = colors.get(name)
        if (!existing) continue
        const locations = this.custom.quasarConfigFile
          ? [{ file: this.custom.quasarConfigFile, line }, ...(existing.locations ?? [])]
          : existing.locations
        colors.set(name, { name, value, source: 'brand-config', locations, ...toSwatch(value) })
      }
    }
    this.cssAddon = configAddon || this.addonFromSource || Boolean(this.custom.addonCssImported)

    this.colors = colors
    this.classEntries = this.buildClassEntries()
    this.classByName = new Map(this.classEntries.map((e) => [e.name, e]))
    this.version++
  }

  /** resolve $var (via pool, then quasar palette) or var(--x[, fallback]) references, one hop */
  private resolveValue(
    value: string,
    poolValues: Map<string, string>,
    themeGroups: Map<string, ThemeGroup>,
  ): string | undefined {
    const varRef = /^var\(--([\w-]+)(?:\s*,\s*([^)]+))?\)$/.exec(value.trim())
    if (varRef) {
      const raw = varRef[1]!
      const stripped = raw.startsWith('q-') ? raw.slice(2) : raw
      const group = themeGroups.get(raw)
      const themed = group && this.themeValue(group)
      return themed ?? this.colors.get(stripped)?.value ?? this.palette.get(stripped) ?? varRef[2]?.trim()
    }
    return resolveSassValue(value, poolValues, this.palette)
  }

  private buildClassEntries(): ClassEntry[] {
    const entries: ClassEntry[] = []

    for (const color of this.colors.values()) {
      const brandLike = color.source !== 'palette'
      const cssValue = brandLike && BRAND_NAMES.includes(color.name as never)
        ? `var(--q-${color.name})`
        : color.value
      entries.push({
        name: `text-${color.name}`,
        kind: 'color',
        swatch: color.swatch,
        color,
        css: `.text-${color.name} {\n  color: ${cssValue} !important;\n}`,
        category: 'color',
        docsUrl: COLOR_DOCS_URL,
        conflictProps: TEXT_COLOR_CONFLICTS,
      })
      entries.push({
        name: `bg-${color.name}`,
        kind: 'color',
        swatch: color.swatch,
        color,
        css: `.bg-${color.name} {\n  background: ${cssValue} !important;\n}`,
        category: 'color',
        docsUrl: COLOR_DOCS_URL,
        conflictProps: BG_COLOR_CONFLICTS,
      })
    }

    return this.cssAddon
      ? entries.concat(BASE_UTILITY_ENTRIES, ADDON_UTILITY_ENTRIES)
      : entries.concat(BASE_UTILITY_ENTRIES)
  }
}
