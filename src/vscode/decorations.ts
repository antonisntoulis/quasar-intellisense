import * as vscode from 'vscode'
import { findColorTokens, type IconUse } from '../core/features'
import { resolveIconName, EXPORT_PREFIX_RE, EXPORT_PREFIX_TO_SET } from '../core/icons'
import { getDocState, getTemplateUses } from './docState'
import { iconThemeColor, type IndexHost } from './providers'

const THROTTLE_MS = 180

/**
 * Inline previews, never replacing text:
 *  - color squares next to text-X/bg-X classes and color-prop values
 *  - icon glyphs next to icon-prop values (icon="close") and svg-export
 *    identifiers in script (:icon="matClose", import { matClose } ...)
 * Drawn as decorations — deliberately not a ColorProvider (no picker for
 * named tokens) and deliberately not in-place icon substitution.
 */
export class ColorDecorations {
  private colorType: vscode.TextEditorDecorationType
  private iconType: vscode.TextEditorDecorationType
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private host: IndexHost) {
    this.colorType = vscode.window.createTextEditorDecorationType({
      before: {
        width: '0.8em',
        height: '0.8em',
        contentText: ' ',
        border: '0.1em solid',
        margin: '0.1em 0.2em 0 0.2em',
      },
      dark: { before: { borderColor: '#eeeeee50' } },
      light: { before: { borderColor: '#00000050' } },
    })
    this.iconType = vscode.window.createTextEditorDecorationType({
      before: { margin: '0 0.25em 0 0.1em' },
    })
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.colorType,
      this.iconType,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.update(editor.document)
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleUpdate(e.document)),
    )
    this.updateAll()
  }

  updateAll(): void {
    const seen = new Set<vscode.TextDocument>()
    for (const editor of vscode.window.visibleTextEditors) {
      if (!seen.has(editor.document)) {
        seen.add(editor.document)
        this.update(editor.document)
      }
    }
  }

  private scheduleUpdate(document: vscode.TextDocument): void {
    if (document.languageId !== 'vue') return
    const key = document.uri.toString()
    clearTimeout(this.timers.get(key))
    this.timers.set(key, setTimeout(() => this.update(document), THROTTLE_MS))
  }

  /** compute once per document, apply to every visible editor showing it */
  private update(document: vscode.TextDocument): void {
    if (document.languageId !== 'vue') return
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === document)
    if (editors.length === 0) return

    const { text } = getDocState(document)
    const uses = getTemplateUses(document, this.host.index)
    const colorTokens = findColorTokens(uses, this.host.index)
    const colorDecorations: vscode.DecorationOptions[] = colorTokens.map((t) => ({
      range: new vscode.Range(document.positionAt(t.start), document.positionAt(t.start)),
      renderOptions: { before: { backgroundColor: t.swatch } },
    }))

    const iconDecorations = this.iconDecorations(document, text, uses.icons)

    for (const editor of editors) {
      editor.setDecorations(this.colorType, colorDecorations)
      editor.setDecorations(this.iconType, iconDecorations)
    }
  }

  private iconDecorations(
    document: vscode.TextDocument,
    text: string,
    iconUses: IconUse[],
  ): vscode.DecorationOptions[] {
    const icons = this.host.icons
    if (!icons || !icons.available) return []

    const color = iconThemeColor()
    const size = Math.round((vscode.workspace.getConfiguration('editor').get<number>('fontSize') ?? 13))
    const out: vscode.DecorationOptions[] = []

    const push = (start: number, set: Parameters<typeof icons.getDataUri>[0], exportName: string, label: string) => {
      const uri = icons.getDataUri(set, exportName, size, color)
      if (!uri) return
      out.push({
        range: new vscode.Range(document.positionAt(start), document.positionAt(start)),
        renderOptions: { before: { contentIconPath: vscode.Uri.parse(uri) } },
        hoverMessage: new vscode.MarkdownString(`\`${label}\` (${set})`),
      })
    }

    // template: icon="close" etc.
    for (const use of iconUses) {
      const ref = resolveIconName(use.name)
      if (ref) push(use.start, ref.set, ref.exportName, use.name)
    }

    // whole document: svg-export identifiers (matClose in imports / :icon bindings)
    EXPORT_PREFIX_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = EXPORT_PREFIX_RE.exec(text)) !== null) {
      const set = EXPORT_PREFIX_TO_SET[m[1]!]
      if (set && icons.isKnownExport(set, m[0])) push(m.index, set, m[0], m[0])
    }
    return out
  }
}
