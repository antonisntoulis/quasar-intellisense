import type * as vscode from 'vscode'
import { getTemplateRegion, type TemplateRegion } from '../core/context'
import { scanTemplate, type TemplateUses } from '../core/features'
import type { QuasarIndex } from '../core/quasarIndex'

interface DocState {
  version: number
  text: string
  region: TemplateRegion | null
  /** template scan result, valid for usesIndexVersion (lazy) */
  uses?: TemplateUses
  usesIndexVersion?: number
}

const cache = new Map<string, DocState>()
const MAX_ENTRIES = 50

/**
 * Per-document-version cache of the full text and its <template> region.
 * Completion, hover, decorations, and diagnostics all need both on the same
 * keystroke; this makes the document scan happen once per version instead of
 * once per feature.
 */
export function getDocState(doc: vscode.TextDocument): DocState {
  const key = doc.uri.toString()
  const hit = cache.get(key)
  if (hit && hit.version === doc.version) return hit

  const text = doc.getText()
  const state: DocState = { version: doc.version, text, region: getTemplateRegion(text) }
  cache.set(key, state)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return state
}

/**
 * The one tag-aware template scan, cached per (document version, index
 * version). Decorations and diagnostics fire on the same change: the second
 * caller gets the cached result instead of re-walking the template.
 */
export function getTemplateUses(doc: vscode.TextDocument, index: QuasarIndex): TemplateUses {
  const state = getDocState(doc)
  if (!state.uses || state.usesIndexVersion !== index.version) {
    state.uses = scanTemplate(state.text, index, state.region)
    state.usesIndexVersion = index.version
  }
  return state.uses
}

export function dropDocState(uri: vscode.Uri): void {
  cache.delete(uri.toString())
}
