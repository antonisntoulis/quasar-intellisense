export type ColorSource =
  | 'palette'          // quasar's static palette (red-5, ...)
  | 'brand-default'    // quasar's default brand values (primary #1976D2, ...)
  | 'brand-config'     // framework.config.brand in quasar.config
  | 'variables-file'   // $primary override in workspace sass
  | 'stylesheet'       // hand-written .text-X/.bg-X rule pair
  | 'theme-css'        // --q-X custom property in workspace css (e.g. .body--dark)

export interface ColorDef {
  name: string
  /** raw css value as authored, e.g. '#a2aa33', 'rgba(0,0,0,.12)' */
  value: string
  /** normalized 6-digit hex; undefined when unresolvable */
  hex?: string
  /** swatch display string: 6-digit hex, or legacy rgba() when alpha < 1 */
  swatch?: string
  /** true when the color has alpha < 1 */
  alpha?: boolean
  source: ColorSource
  file?: string
  line?: number
  /** per-theme values when defined via --q-X in .body--light/.body--dark rules */
  themeValues?: { light?: string; dark?: string }
  /** every place this color is defined (for go-to-definition); workspace-relative
   *  unless absolute (quasar's own variables.sass) */
  locations?: SourceLocation[]
}

export interface SourceLocation {
  file: string
  line: number
}

export interface UtilityClass {
  name: string
  css: string
  category: string
  docsUrl: string
  summary?: string
  addon?: boolean
  /** css properties this class sets, per scope key `${media}|${parentCtx}` —
   *  the basis for conflicting-class diagnostics */
  props?: Record<string, string[]>
}

export interface ClassEntry {
  name: string
  kind: 'color' | 'utility'
  /** swatch string: 6-digit hex or legacy rgba(); only for kind 'color' */
  swatch?: string
  color?: ColorDef
  css: string
  category: string
  docsUrl?: string
  /** human-friendly one-liner, e.g. "width: 50% (6 of 12 columns)" */
  summary?: string
  /** precomputed conflict pairs [`${scope}::${prop}`, prop] — the basis for
   *  conflicting-class diagnostics, built once per index rebuild */
  conflictProps?: ReadonlyArray<readonly [string, string]>
}

export interface ColorPropsData {
  components: Record<string, string[]>
  propNames: string[]
}

export interface CustomColorRule {
  /** color name, i.e. X in .text-X / .bg-X */
  name: string
  kind: 'text' | 'bg'
  value: string
  file: string
  line: number
}

/** custom property declaration found in a workspace stylesheet */
export interface ThemeVarDef {
  /** raw var name without the leading --, e.g. 'q-primary' or 'muted' */
  name: string
  value: string
  /** which theme the enclosing selector targets (.body--dark etc.) */
  theme: 'light' | 'dark' | 'both'
  file: string
  line: number
}

/** $var definition pooled from workspace sass files */
export interface SassVarDef {
  name: string
  value: string
  file: string
  line: number
}
