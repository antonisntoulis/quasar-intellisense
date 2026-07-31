import * as vscode from 'vscode'
import { findColorDiagnostics, type IconChecker } from '../core/features'
import { resolveIconName, isNonNameIconValue } from '../core/icons'
import { dropDocState, getTemplateUses } from './docState'
import type { IndexHost } from './providers'

// the lint itself costs ~1ms even on huge documents; the debounce exists only
// to coalesce keystroke bursts and avoid mid-word squiggle flicker
const DEBOUNCE_MS = 180

/** Squiggles for dead color-variable chains and color-prop typos. */
export class ColorDiagnostics {
  private collection = vscode.languages.createDiagnosticCollection('quasar-intellisense')
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private host: IndexHost) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((doc) => this.update(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleUpdate(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.collection.delete(doc.uri)
        dropDocState(doc.uri)
      }),
    )
    this.refreshAll()
  }

  /** re-lint everything we know about (after index rebuilds) */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.update(doc)
  }

  private scheduleUpdate(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'vue') return
    const key = doc.uri.toString()
    clearTimeout(this.timers.get(key))
    this.timers.set(key, setTimeout(() => this.update(doc), DEBOUNCE_MS))
  }

  /**
   * Warn only where we're certain: quasar's own icon props (custom-component
   * *-icon props may take anything), no iconMapFn in the project, static
   * string names only (img:/svguse:/raw svg paths are exempt).
   */
  private checkIcon: IconChecker = (name, attrName) => {
    const icons = this.host.icons
    if (!icons || !icons.available || icons.hasIconMapFn) return null
    if (!this.host.index.iconPropNames.has(attrName) && attrName !== 'name') return null
    if (isNonNameIconValue(name)) return null

    const ref = resolveIconName(name)
    if (!ref) return null
    if (icons.knownNames.has(name)) return null
    if (!icons.detectedSets.includes(ref.set)) {
      return `'${name}' needs the '${ref.set}' icon set, which this project does not load`
    }
    return `'${name}' is not a known ${ref.set} icon`
  }

  private update(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'vue') return
    const uses = getTemplateUses(doc, this.host.index)
    const items = findColorDiagnostics(uses, this.host.index, this.checkIcon)
    this.collection.set(
      doc.uri,
      items.map((item) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(doc.positionAt(item.start), doc.positionAt(item.end)),
          item.message,
          vscode.DiagnosticSeverity.Warning,
        )
        d.source = 'quasar'
        d.code = item.code
        return d
      }),
    )
  }
}
