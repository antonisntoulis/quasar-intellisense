/**
 * Line-based parser for sass variable declarations ($name: value).
 * Used for quasar's variables.sass and the user's variables file.
 * Tolerates !default, comments, and skips map values.
 */
export function parseSassVariables(text: string): Map<string, { value: string; line: number }> {
  const vars = new Map<string, { value: string; line: number }>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\$([a-zA-Z0-9_-]+)\s*:\s*(.+?)\s*(!default)?\s*;?\s*(\/\/.*)?$/.exec(lines[i]!)
    if (!m) continue
    const value = m[2]!.trim()
    if (value.startsWith('(') || value === '') continue // sass maps / empty
    vars.set(m[1]!, { value, line: i + 1 })
  }
  return vars
}

/**
 * Resolve a sass value one hop: `$other` looked up in the given maps
 * (first map wins). Returns the raw css value or undefined.
 */
export function resolveSassValue(
  value: string,
  ...maps: Array<Map<string, { value: string }> | Map<string, string>>
): string | undefined {
  let v = value.trim()
  if (v.startsWith('$')) {
    const name = v.slice(1)
    for (const map of maps) {
      const hit = map.get(name)
      if (hit !== undefined) {
        v = typeof hit === 'string' ? hit : hit.value
        break
      }
    }
    if (v.startsWith('$')) return undefined
  }
  // computed values (darken(...), maps, interpolation) -> unresolvable
  if (/[(){}]/.test(v) && !/^(#|rgb|hsl)/i.test(v)) return undefined
  return v
}
