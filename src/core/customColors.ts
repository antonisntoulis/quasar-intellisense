import postcssScss from 'postcss-scss'
import type { CustomColorRule, ThemeVarDef } from './types'

export interface StylesheetScan {
  rules: CustomColorRule[]
  themeVars: ThemeVarDef[]
}

/**
 * Scan a stylesheet (css/scss/sass-content of a <style> block) for:
 *  - hand-written `.text-X { color: ... }` / `.bg-X { background: ... }` rules
 *    (the documented Quasar custom-color pattern)
 *  - `--q-X: <value>` custom-property declarations, tagged with the theme
 *    their selector targets (.body--light / .body--dark / anything else)
 *
 * Returns empty results on parse errors (silent degrade).
 */
export function scanStylesheet(text: string, file: string): StylesheetScan {
  const rules: CustomColorRule[] = []
  const themeVars: ThemeVarDef[] = []
  try {
    const root = postcssScss.parse(text)
    root.walkRules((rule) => {
      for (const sel of rule.selectors) {
        const m = /^\.(text|bg)-([a-zA-Z][\w-]*)$/.exec(sel.trim())
        if (!m) continue
        const kind = m[1] as 'text' | 'bg'
        const wanted = kind === 'text' ? ['color'] : ['background', 'background-color']
        rule.walkDecls((decl) => {
          if (!wanted.includes(decl.prop)) return
          rules.push({
            name: m[2]!,
            kind,
            value: decl.value.replace(/\s*!important\s*$/, '').trim(),
            file,
            line: decl.source?.start?.line ?? rule.source?.start?.line ?? 1,
          })
        })
      }
    })
    root.walkDecls((decl) => {
      // every custom property (--q-primary AND plain --muted): user classes
      // reference both, e.g. .text-muted { color: var(--muted) }
      const m = /^--([\w-]+)$/.exec(decl.prop)
      if (!m) return
      const selector = decl.parent?.type === 'rule' ? (decl.parent as { selector?: string }).selector ?? '' : ''
      const theme = selector.includes('body--dark') ? 'dark'
        : selector.includes('body--light') ? 'light'
        : 'both'
      themeVars.push({
        name: m[1]!,
        value: decl.value.trim(),
        theme,
        file,
        line: decl.source?.start?.line ?? 1,
      })
    })
  } catch {
    // malformed stylesheet: skip file, keep scanning others
  }
  return { rules, themeVars }
}

/** Extract the <style> block contents of a .vue single-file component. */
export function extractVueStyleBlocks(text: string): string[] {
  const blocks: string[] = []
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  for (const m of text.matchAll(re)) blocks.push(m[1]!)
  return blocks
}

export interface QuasarConfigData {
  brand: Record<string, { value: string; line: number }>
  cssAddon: boolean
}

/**
 * Light textual parse of quasar.config.(js|ts) — never executed.
 * Extracts framework.config.brand entries (with line numbers) and cssAddon.
 */
export function parseQuasarConfig(text: string): QuasarConfigData {
  const result: QuasarConfigData = { brand: {}, cssAddon: /cssAddon\s*:\s*true/.test(text) }

  const brandStart = text.search(/\bbrand\s*:\s*\{/)
  if (brandStart === -1) return result

  const braceStart = text.indexOf('{', brandStart)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  if (end === -1) return result

  const bodyStart = braceStart + 1
  const body = text.slice(bodyStart, end)
  const entryRe = /['"]?([a-zA-Z][\w-]*)['"]?\s*:\s*['"]([^'"]+)['"]/g
  for (const m of body.matchAll(entryRe)) {
    const line = text.slice(0, bodyStart + m.index).split('\n').length
    result.brand[m[1]!] = { value: m[2]!, line }
  }
  return result
}
