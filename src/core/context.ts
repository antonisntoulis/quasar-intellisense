/**
 * Where-are-we detection for .vue documents. Offset-based (multi-line safe),
 * bounded scans only — this runs on every keystroke.
 * Policy: prefer returning null over guessing.
 */

export interface TemplateRegion {
  start: number
  end: number
}

/**
 * Locate the top-level <template> block, aware of nested <template> tags.
 * Returns the offsets of the block's inner content.
 */
export function getTemplateRegion(text: string): TemplateRegion | null {
  const tagRe = /<\/?template\b[^>]*>/g
  let depth = 0
  let start = -1
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(text)) !== null) {
    const isClosing = m[0].startsWith('</')
    if (!isClosing) {
      if (m[0].endsWith('/>')) continue
      if (depth === 0) start = m.index + m[0].length
      depth++
    } else if (depth > 0) {
      depth--
      if (depth === 0) return { start, end: m.index }
    }
  }
  // unclosed template while typing: treat rest of file as template
  return start !== -1 && depth > 0 ? { start, end: text.length } : null
}

export type AttrKind = 'class' | 'colorProp' | 'iconProp'

/** decides whether an attribute is completable, given its enclosing tag */
export type AttrClassifier = (attrName: string, tagName: string | undefined) => AttrKind | null

export interface AttrContext {
  kind: AttrKind
  /** attribute name as written, e.g. 'class', 'color', 'icon-right' */
  propName: string
  /** enclosing component tag, e.g. 'q-btn' */
  tagName?: string
  /** offset just after the opening quote */
  valueStart: number
  /** current token at the cursor: space-separated for class, full value for props */
  token: { start: number; end: number; text: string }
  /** cursor is right after `attr=` with no quote yet: completions must add quotes */
  needsQuotes?: boolean
}

/** How far back we look for the opening `attr="` — generous for long class lists. */
const SCAN_WINDOW = 2000

/**
 * Detect whether `offset` sits inside a static class attribute or a
 * Quasar color-prop attribute value.
 */
/** enclosing tag name: last `<tag` opened in the window before the cursor */
function findTagName(slice: string): string | undefined {
  let tag: string | undefined
  const tagRe = /<([a-zA-Z][\w-]*)/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(slice)) !== null) tag = m[1]
  return tag
}

function classify(attrName: string, tag: string | undefined, classifier: AttrClassifier): AttrKind | null {
  if (attrName === 'class') return 'class'
  return classifier(attrName, tag)
}

export function getAttributeContext(
  text: string,
  offset: number,
  classifier: AttrClassifier,
): AttrContext | null {
  const windowStart = Math.max(0, offset - SCAN_WINDOW)
  const slice = text.slice(windowStart, offset)
  const tagName = findTagName(slice)

  // cursor right after `attr=`, quote not typed yet (the `=` trigger char)
  const eq = /(?:^|[\s"'])([a-zA-Z][\w-]*)=$/.exec(slice)
  if (eq) {
    const kind = classify(eq[1]!, tagName, classifier)
    if (!kind) return null
    return {
      kind,
      propName: eq[1]!,
      tagName,
      valueStart: offset,
      token: { start: offset, end: offset, text: '' },
      needsQuotes: true,
    }
  }

  // last attribute opening before the cursor
  const attrRe = /([a-zA-Z][\w-]*)\s*=\s*(["'])/g
  let open: { name: string; quote: string; valueStart: number } | null = null
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(slice)) !== null) {
    const valueStart = m.index + m[0].length
    // attribute is open at the cursor only if its quote isn't closed before it
    if (!slice.slice(valueStart).includes(m[2]!)) {
      open = { name: m[1]!, quote: m[2]!, valueStart: windowStart + valueStart }
    }
  }
  if (!open) return null

  const kind = classify(open.name, tagName, classifier)
  if (!kind) return null

  const hardEnd = Math.min(text.length, offset + 300)
  let tokenStart: number
  let tokenEnd: number
  if (kind === 'class') {
    // current whitespace-separated token
    tokenStart = offset
    while (tokenStart > open.valueStart && !/\s/.test(text[tokenStart - 1]!)) tokenStart--
    tokenEnd = offset
    while (tokenEnd < hardEnd && !/\s/.test(text[tokenEnd]!) && text[tokenEnd] !== open.quote) tokenEnd++
  } else {
    // props take a single value; icon names may contain spaces (fas fa-user)
    tokenStart = open.valueStart
    tokenEnd = offset
    while (tokenEnd < hardEnd && text[tokenEnd] !== open.quote && text[tokenEnd] !== '\n') tokenEnd++
  }

  return {
    kind,
    propName: open.name,
    tagName,
    valueStart: open.valueStart,
    token: { start: tokenStart, end: tokenEnd, text: text.slice(tokenStart, tokenEnd).trim() },
  }
}
