import type { AttrContext, TemplateRegion } from './context'
import type { ColorDef } from './types'
import type { QuasarIndex } from './quasarIndex'

export interface HoverData {
  css?: string
  color?: ColorDef
}

export function getHoverData(ctx: AttrContext, index: QuasarIndex): HoverData | null {
  const name = ctx.token.text
  if (!name) return null

  if (ctx.kind === 'colorProp') {
    const color = index.resolveColor(name)
    return color ? { color } : null
  }

  const entry = index.classByName.get(name)
  if (!entry) return null
  return { css: entry.css, color: entry.color }
}

/** text-X / bg-X class name -> the color name X */
export const COLOR_CLASS_RE = /^(?:text|bg)-(.+)$/

interface ColorUse {
  start: number
  end: number
  /** the token as written: 'text-button-color' or a prop value like 'primary' */
  token: string
  /** the color name referenced: X from text-X/bg-X, or the prop value itself */
  colorName: string
  where: 'class' | 'prop'
  attrName: string
}

export interface IconUse {
  start: number
  end: number
  /** template icon name as written, e.g. 'close', 'mdi-account', 'fas fa-user' */
  name: string
  attrName: string
}

/** a class="..." attribute occurrence, for the conflicting-class check */
interface ClassAttrUse {
  valueStart: number
  value: string
}

export interface TemplateUses {
  colors: ColorUse[]
  icons: IconUse[]
  classAttrs: ClassAttrUse[]
}

/**
 * THE one tag-aware pass over the template: color uses, icon uses, and
 * class-attribute spans. Every downstream feature (decorations, diagnostics,
 * conflicts) consumes this result — never add a second full scan.
 */
export function scanTemplate(text: string, index: QuasarIndex, region: TemplateRegion | null): TemplateUses {
  const uses: TemplateUses = { colors: [], icons: [], classAttrs: [] }
  if (!region) return uses

  const slice = text.slice(region.start, region.end)
  // alternates tag openings with attributes so each attr knows its tag
  const walkRe = /<([a-zA-Z][\w-]*)|([a-zA-Z][\w-]*)\s*=\s*(["'])([^"']*)\3/g
  let tag: string | undefined
  let m: RegExpExecArray | null
  while ((m = walkRe.exec(slice)) !== null) {
    if (m[1]) {
      tag = m[1]
      continue
    }
    const attrName = m[2]!
    const value = m[4]!
    const valueStart = region.start + m.index + m[0].length - value.length - 1

    if (attrName === 'class') {
      uses.classAttrs.push({ valueStart, value })
      const wordRe = /\S+/g
      let w: RegExpExecArray | null
      while ((w = wordRe.exec(value)) !== null) {
        const token = w[0]
        const colorName = token.startsWith('text-') ? token.slice(5)
          : token.startsWith('bg-') ? token.slice(3)
          : undefined
        if (!colorName) continue
        uses.colors.push({
          start: valueStart + w.index,
          end: valueStart + w.index + token.length,
          token,
          colorName,
          where: 'class',
          attrName,
        })
      }
      continue
    }

    const trimmed = value.trim()
    if (!trimmed) continue
    const lead = value.length - value.trimStart().length

    if (index.isColorProp(attrName)) {
      if (/\s/.test(trimmed)) continue
      uses.colors.push({
        start: valueStart + lead,
        end: valueStart + lead + trimmed.length,
        token: trimmed,
        colorName: trimmed,
        where: 'prop',
        attrName,
      })
    } else if (index.isIconProp(attrName, tag)) {
      uses.icons.push({
        start: valueStart + lead,
        end: valueStart + lead + trimmed.length,
        name: trimmed,
        attrName,
      })
    }
  }
  return uses
}

export interface ColorToken {
  start: number
  end: number
  swatch: string
}

/** resolved color tokens, for inline decorations */
export function findColorTokens(uses: TemplateUses, index: QuasarIndex): ColorToken[] {
  const tokens: ColorToken[] = []
  for (const use of uses.colors) {
    const swatch = index.resolveColor(use.colorName)?.swatch
    if (swatch) tokens.push({ start: use.start, end: use.end, swatch })
  }
  return tokens
}

export interface DiagnosticItem {
  start: number
  end: number
  message: string
  code: 'unknown-color' | 'dead-var' | 'class-conflict' | 'unknown-icon'
}

/** adapter-supplied icon validation: returns a warning message or null */
export type IconChecker = (name: string, attrName: string) => string | null

/**
 * Problems worth a squiggle:
 *  - a color class/prop whose value chain ends in an undefined css variable
 *    (renders nothing in the app, e.g. bg-X { background: var(--q-X) } with
 *    --q-X never defined)
 *  - an unknown color name in one of quasar's own color props (typo)
 * Deliberately NOT flagged: unknown text-X/bg-X classes (may be user utilities
 * outside our scan) and unknown values on non-quasar component props (may
 * legitimately take raw css colors).
 */
export function findColorDiagnostics(
  uses: TemplateUses,
  index: QuasarIndex,
  checkIcon?: IconChecker,
): DiagnosticItem[] {
  const items: DiagnosticItem[] = []

  if (checkIcon) {
    for (const use of uses.icons) {
      const message = checkIcon(use.name, use.attrName)
      if (message) items.push({ start: use.start, end: use.end, message, code: 'unknown-icon' })
    }
  }

  for (const use of uses.colors) {
    const def = index.resolveColor(use.colorName)
    if (def) {
      // resolvable colors (the common case) skip the dead-var regex entirely
      const varRef = def.swatch ? null : /^var\((--[\w-]+)/.exec(def.value)
      if (varRef) {
        items.push({
          start: use.start,
          end: use.end,
          message: `'${use.token}' references ${varRef[1]}, which is not defined anywhere in the workspace: it will render without a color`,
          code: 'dead-var',
        })
      }
    } else if (use.where === 'prop' && index.colorPropNames.has(use.attrName)) {
      items.push({
        start: use.start,
        end: use.end,
        message: `'${use.colorName}' is not a known Quasar color`,
        code: 'unknown-color',
      })
    }
  }
  findClassConflicts(uses, index, items)
  return items
}

const preferProp = (p: string) => !/^(min-|max-)/.test(p)

/**
 * Two classes in one class attribute setting the same css property in the
 * same media/parent scope: one silently wins (stylesheet order, not attribute
 * order). Scope-aware, so xs-hide + lg-hide (different media) is fine while
 * q-pa-md + q-pa-sm is flagged.
 */
function findClassConflicts(uses: TemplateUses, index: QuasarIndex, items: DiagnosticItem[]): void {
  for (const { value, valueStart } of uses.classAttrs) {
    const seen = new Map<string, string>() // conflict key -> earlier class name
    const tokensSeen = new Set<string>()
    const wordRe = /\S+/g
    let w: RegExpExecArray | null
    while ((w = wordRe.exec(value)) !== null) {
      const token = w[0]
      const entry = index.classByName.get(token)
      if (!entry) continue

      let conflict: { prop: string; other: string } | undefined
      if (entry.conflictProps) {
        for (const [key, prop] of entry.conflictProps) {
          const other = seen.get(key)
          if (other && other !== token && (!conflict || (preferProp(prop) && !preferProp(conflict.prop)))) {
            conflict = { prop, other }
          }
          if (!other) seen.set(key, token)
        }
      }
      if (conflict) {
        items.push({
          start: valueStart + w.index,
          end: valueStart + w.index + token.length,
          message: `'${token}' and '${conflict.other}' both set '${conflict.prop}': one of them has no effect`,
          code: 'class-conflict',
        })
      } else if (tokensSeen.has(token)) {
        items.push({
          start: valueStart + w.index,
          end: valueStart + w.index + token.length,
          message: `'${token}' appears more than once`,
          code: 'class-conflict',
        })
      }
      tokensSeen.add(token)
    }
  }
}

/** closest known color names for did-you-mean quick fixes */
export function suggestColorNames(input: string, index: QuasarIndex, max = 3): string[] {
  return suggestNames(input, index.colors.keys(), max)
}

/** closest names from any candidate pool (colors, icon names, ...) */
export function suggestNames(input: string, candidatePool: Iterable<string>, max = 3): string[] {
  const candidates: Array<{ name: string; dist: number }> = []
  for (const name of candidatePool) {
    const dist = levenshtein(input, name, 3)
    if (dist <= 2 || name.startsWith(input)) candidates.push({ name, dist })
  }
  candidates.sort((a, b) => a.dist - b.dist || a.name.length - b.name.length)
  return candidates.slice(0, max).map((c) => c.name)
}

/** bounded levenshtein: returns limit+1 early when distance exceeds limit */
function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      rowMin = Math.min(rowMin, curr[j]!)
    }
    if (rowMin > limit) return limit + 1
    prev = curr
  }
  return prev[b.length]!
}
