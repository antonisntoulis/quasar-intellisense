import * as vscode from 'vscode'
import type { IndexHost } from './providers'

export const SHOW_OUTPUT_COMMAND = 'quasar-intellisense.showOutput'

export interface StatusInfo {
  /** version of the installed quasar package; undefined when using bundled data */
  quasarVersion?: string
  /** quasar app dir relative to the workspace folder; '' when they coincide */
  appRootRel: string
  /** quasar.config file name when one exists (Quasar CLI flavor) */
  configFile?: string
}

/**
 * Status bar badge, shown only when the extension is active (quasar found):
 * the Quasar logo (contributed icon font glyph), the installed version, and
 * a tooltip summarizing what the extension detected. Click opens the log.
 */
export class QuasarStatusBar {
  private item = vscode.window.createStatusBarItem(
    'quasarIntellisense.status', vscode.StatusBarAlignment.Right, 100)

  constructor(private host: IndexHost, private info: StatusInfo) {
    this.item.name = 'Quasar IntelliSense'
    this.item.command = SHOW_OUTPUT_COMMAND
  }

  register(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
    context.subscriptions.push(
      this.item,
      vscode.commands.registerCommand(SHOW_OUTPUT_COMMAND, () => output.show()),
    )
    this.refresh()
    this.item.show()
  }

  /** recompute text and tooltip from the live index / icon state */
  refresh(): void {
    const { index, icons } = this.host
    const v = this.info.quasarVersion

    this.item.text = v ? `$(quasar-logo) ${v} $(check)` : '$(quasar-logo) Quasar'

    const md = new vscode.MarkdownString(undefined, true)
    md.appendMarkdown('**Quasar IntelliSense**\n\n')
    md.appendMarkdown(this.info.configFile
      ? `Quasar CLI project (${this.info.configFile})\n\n`
      : 'Vite plugin / plain Vue project (no quasar.config)\n\n')
    if (this.info.appRootRel) md.appendMarkdown(`App: \`${this.info.appRootRel}/\`\n\n`)

    md.appendMarkdown(v
      ? `$(check) quasar ${v} installed\n\n`
      : '$(warning) quasar package not readable, using bundled snapshots\n\n')
    if (icons?.extrasVersion) md.appendMarkdown(`$(check) @quasar/extras ${icons.extrasVersion}\n\n`)

    md.appendMarkdown(
      `$(check) ${index.classEntries.length} classes, ${index.colors.size} colors, ` +
      `${index.colorPropNames.size} color props\n\n`)
    if (icons?.available) {
      md.appendMarkdown(`$(check) icons: ${icons.detectedSets.join(', ')} (${icons.entries.length} names)\n\n`)
    }
    md.appendMarkdown(`css addon: ${index.cssAddon ? 'on' : 'off'}\n\n`)
    md.appendMarkdown('---\n\nClick to open the output log')
    this.item.tooltip = md
  }
}
