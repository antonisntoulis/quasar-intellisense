import * as vscode from 'vscode'
import * as path from 'node:path'
import { getAttributeContext } from '../core/context'
import { COLOR_CLASS_RE } from '../core/features'
import { getDocState } from './docState'
import type { IndexHost } from './providers'

/**
 * Ctrl+Click on text-brand / color="primary" jumps to where the color is
 * defined: custom .text-X rules, --q-X theme declarations, $var overrides,
 * quasar.config brand entries, or quasar's own variables.sass for the palette.
 */
export class QuasarDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private host: IndexHost, private root: string) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    const { text, region } = getDocState(document)
    const offset = document.offsetAt(position)
    if (!region || offset < region.start || offset > region.end) return undefined

    const ctx = getAttributeContext(text, offset, this.host.index.classifyAttr)
    if (!ctx || !ctx.token.text || offset < ctx.token.start || offset > ctx.token.end) return undefined
    if (ctx.kind === 'iconProp') return undefined

    const colorName = ctx.kind === 'colorProp'
      ? ctx.token.text
      : COLOR_CLASS_RE.exec(ctx.token.text)?.[1]
    if (!colorName) return undefined

    const locations = this.host.index.resolveColor(colorName)?.locations
    if (!locations || locations.length === 0) return undefined

    return locations.map((loc) => {
      const file = path.isAbsolute(loc.file) ? loc.file : path.join(this.root, loc.file)
      return new vscode.Location(vscode.Uri.file(file), new vscode.Position(Math.max(0, loc.line - 1), 0))
    })
  }
}
