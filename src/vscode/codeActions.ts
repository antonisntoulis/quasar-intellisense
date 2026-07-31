import * as vscode from 'vscode'
import { suggestColorNames, suggestNames } from '../core/features'
import type { IndexHost } from './providers'

/**
 * Quick fixes for our diagnostics:
 *  - unknown-color: "Change to 'primary'" (typo distance against known names)
 *  - class-conflict: "Remove 'q-pa-sm'"
 */
export class QuasarCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  }

  constructor(private host: IndexHost) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = []

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'quasar') continue

      if (diagnostic.code === 'unknown-color' || diagnostic.code === 'unknown-icon') {
        const wrong = document.getText(diagnostic.range)
        const suggestions = diagnostic.code === 'unknown-color'
          ? suggestColorNames(wrong, this.host.index)
          : suggestNames(wrong, this.host.icons?.knownNames ?? [])
        for (const [i, suggestion] of suggestions.entries()) {
          const action = new vscode.CodeAction(`Change to '${suggestion}'`, vscode.CodeActionKind.QuickFix)
          action.diagnostics = [diagnostic]
          action.isPreferred = i === 0
          action.edit = new vscode.WorkspaceEdit()
          action.edit.replace(document.uri, diagnostic.range, suggestion)
          actions.push(action)
        }
      }

      if (diagnostic.code === 'class-conflict') {
        const token = document.getText(diagnostic.range)
        const action = new vscode.CodeAction(`Remove '${token}'`, vscode.CodeActionKind.QuickFix)
        action.diagnostics = [diagnostic]
        action.isPreferred = true
        action.edit = new vscode.WorkspaceEdit()
        // also eat the whitespace before the token so the class list stays tidy
        const lineStart = new vscode.Position(diagnostic.range.start.line, 0)
        const before = document.getText(new vscode.Range(lineStart, diagnostic.range.start))
        const trimmed = before.replace(/\s+$/, '')
        const from = trimmed.length < before.length && trimmed.length > 0
          ? new vscode.Position(diagnostic.range.start.line, trimmed.length)
          : diagnostic.range.start
        action.edit.delete(document.uri, new vscode.Range(from, diagnostic.range.end))
        actions.push(action)
      }
    }
    return actions
  }
}
