/**
 * Pure icon-name logic: QIcon's prefix grammar, template-name -> svg-export
 * name mapping (lossless in this direction), and quasar's encoded-svg format.
 * No fs access here; loading lives in the vscode adapter.
 */

export type IconSetId =
  | 'material-icons' | 'material-icons-outlined' | 'material-icons-round' | 'material-icons-sharp'
  | 'material-symbols-outlined' | 'material-symbols-rounded' | 'material-symbols-sharp'
  | 'mdi-v7' | 'fontawesome-v7' | 'bootstrap-icons' | 'line-awesome'
  | 'eva-icons' | 'themify' | 'ionicons-v4'

export const ICON_SET_IDS: IconSetId[] = [
  'material-icons', 'material-icons-outlined', 'material-icons-round', 'material-icons-sharp',
  'material-symbols-outlined', 'material-symbols-rounded', 'material-symbols-sharp',
  'mdi-v7', 'fontawesome-v7', 'bootstrap-icons', 'line-awesome',
  'eva-icons', 'themify', 'ionicons-v4',
]

/** values our features must leave alone: images, svg refs, raw path data */
export function isNonNameIconValue(value: string): boolean {
  return /^(img:|svguse:)/.test(value) || /^[Mm]\s?[-+]?\.?\d/.test(value)
}

/** check_circle -> CheckCircle, crop_16_9 -> Crop169, calendar-check -> CalendarCheck */
export function pascal(s: string): string {
  return s.split(/[_\-\s]+/).filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1)).join('')
}

type MaterialVariant = 'o' | 'r' | 's'

const SYMBOL_SETS: Record<MaterialVariant, { set: IconSetId; prefix: string }> = {
  o: { set: 'material-symbols-outlined', prefix: 'symOutlined' },
  r: { set: 'material-symbols-rounded', prefix: 'symRounded' },
  s: { set: 'material-symbols-sharp', prefix: 'symSharp' },
}

const MATERIAL_VARIANT_SETS: Record<MaterialVariant, { set: IconSetId; prefix: string }> = {
  o: { set: 'material-icons-outlined', prefix: 'outlined' },
  r: { set: 'material-icons-round', prefix: 'round' },
  s: { set: 'material-icons-sharp', prefix: 'sharp' },
}

const FA_STYLE_ALIASES: Record<string, string> = {
  'fa-solid': 'fas', 'fa-regular': 'far', 'fa-brands': 'fab', fa: 'fas',
}

export interface IconRef {
  set: IconSetId
  /** the svg export identifier in @quasar/extras, e.g. matClose, fasUser */
  exportName: string
}

/**
 * Template icon name -> which set it belongs to + its svg export name.
 * Mirrors QIcon.js resolution order. Returns null for unknown grammar.
 */
export function resolveIconName(name: string): IconRef | null {
  if (!name || isNonNameIconValue(name)) return null

  let m = /^sym_([ors])_(.+)$/.exec(name)
  if (m) {
    const { set, prefix } = SYMBOL_SETS[m[1] as MaterialVariant]
    return { set, exportName: prefix + pascal(m[2]!) }
  }
  m = /^([ors])_(.+)$/.exec(name)
  if (m) {
    const { set, prefix } = MATERIAL_VARIANT_SETS[m[1] as MaterialVariant]
    return { set, exportName: prefix + pascal(m[2]!) }
  }
  if (name.startsWith('mdi-')) return { set: 'mdi-v7', exportName: 'mdi' + pascal(name.slice(4)) }
  m = /^(fa[srlbdk]?|fa-(?:solid|regular|brands|light|thin|duotone|sharp|classic))\s+fa-(.+)$/.exec(name)
  if (m) {
    const style = FA_STYLE_ALIASES[m[1]!] ?? m[1]!
    return { set: 'fontawesome-v7', exportName: style + pascal(m[2]!) }
  }
  m = /^(las|lar|lab|la)\s+la-(.+)$/.exec(name)
  if (m) {
    return { set: 'line-awesome', exportName: 'la' + pascal(m[2]!) + (m[1] === 'las' ? 'Solid' : '') }
  }
  if (name.startsWith('bi-')) return { set: 'bootstrap-icons', exportName: 'bi' + pascal(name.slice(3)) }
  if (name.startsWith('eva-')) return { set: 'eva-icons', exportName: 'eva' + pascal(name.slice(4)) }
  if (name.startsWith('ti-')) return { set: 'themify', exportName: 'ti' + pascal(name.slice(3)) }
  if (name.startsWith('ion-')) return { set: 'ionicons-v4', exportName: 'ion' + pascal(name.slice(4)) }
  // bare name = material icons ligature
  if (/^[a-z0-9_]+$/.test(name)) return { set: 'material-icons', exportName: 'mat' + pascal(name) }
  return null
}

/** export-name prefix -> set, for recognizing svg identifiers in <script> */
export const EXPORT_PREFIX_RE =
  /\b(symOutlined|symRounded|symSharp|outlined|round|sharp|mat|mdi|fas|far|fab|la|bi|eva|ti|ion)[A-Z0-9][A-Za-z0-9]*\b/g

export const EXPORT_PREFIX_TO_SET: Record<string, IconSetId> = {
  mat: 'material-icons', outlined: 'material-icons-outlined',
  round: 'material-icons-round', sharp: 'material-icons-sharp',
  symOutlined: 'material-symbols-outlined', symRounded: 'material-symbols-rounded',
  symSharp: 'material-symbols-sharp',
  mdi: 'mdi-v7', fas: 'fontawesome-v7', far: 'fontawesome-v7', fab: 'fontawesome-v7',
  la: 'line-awesome', bi: 'bootstrap-icons', eva: 'eva-icons', ti: 'themify', ion: 'ionicons-v4',
}

// ------------------------------------------------ quasar svg encoding -------

/**
 * @quasar/extras encodes svgs as `d[@@style[@@transform]](&&d2...)[|viewBox]`,
 * default viewBox 0 0 24 24 (QIcon.js).
 */
export function quasarSvgToSvg(encoded: string, sizePx: number, color: string): string {
  const [def, viewBox = '0 0 24 24'] = splitLast(encoded, '|')
  const paths = def.split('&&').map((part) => {
    const [d, style, transform] = part.split('@@')
    let fill: string | undefined
    let styleAttr = style
    if (style?.includes('fill')) {
      styleAttr = style.replace(/currentColor/g, color)
    } else {
      fill = color
    }
    return `<path d="${d}"${fill ? ` fill="${fill}"` : ''}` +
      `${styleAttr ? ` style="${styleAttr}"` : ''}` +
      `${transform ? ` transform="${transform}"` : ''}/>`
  }).join('')

  const vb = viewBox.trim().split(/\s+/).map(Number)
  const ratio = vb.length === 4 && vb[3]! !== 0 ? vb[2]! / vb[3]! : 1
  const width = Math.round(sizePx * ratio * 10) / 10
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${sizePx}" ` +
    `viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${paths}</svg>`
}

function splitLast(s: string, sep: string): [string, string?] {
  const i = s.lastIndexOf(sep)
  // a '|' can only be the viewBox separator; path data never contains it
  return i === -1 ? [s] : [s.slice(0, i), s.slice(i + 1)]
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
