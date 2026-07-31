import * as vscode from 'vscode'
import { getAttributeContext, type AttrContext } from '../core/context'
import { getHoverData } from '../core/features'
import { resolveIconName } from '../core/icons'
import { getDocState } from './docState'
import type { ClassEntry, ColorDef } from '../core/types'
import type { QuasarIndex } from '../core/quasarIndex'
import type { IconData, IconEntry } from './iconData'

export interface IndexHost {
  index: QuasarIndex
  icons?: IconData
}

/** entry lookup for resolve, without polluting CompletionItem typing */
const itemEntries = new WeakMap<vscode.CompletionItem, ClassEntry | ColorDef | IconEntry>()

export function themeKind(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark'
}

export function iconThemeColor(): string {
  return themeKind() === 'light' ? '#424242' : '#e0e0e0'
}

export async function iconPreviewMarkdown(
  icons: IconData,
  entry: IconEntry,
  sizePx = 48,
): Promise<vscode.MarkdownString | undefined> {
  await icons.ensureSvgs(entry.set)
  const uri = icons.getDataUri(entry.set, entry.exportName, sizePx, iconThemeColor())
  if (!uri) return undefined
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`| |\n|:---:|\n| ![](${uri}) |\n\n\`${entry.name}\` (${entry.set})`)
  return md
}

const CATEGORY_ORDER: Record<string, string> = {
  color: '1', spacing: '2', flex: '3', grid: '4', gutter: '5', typography: '6',
}

function sortPrefix(category: string): string {
  return CATEGORY_ORDER[category] ?? '7'
}

export class QuasarCompletionProvider implements vscode.CompletionItemProvider {
  private classItems: vscode.CompletionItem[] = []
  private colorItems: vscode.CompletionItem[] = []
  private iconItems: vscode.CompletionItem[] | undefined
  private builtVersion = -1

  constructor(private host: IndexHost) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const offset = document.offsetAt(position)
    const ctx = contextAt(document, offset, this.host)
    if (!ctx) return undefined

    this.ensureItems()

    const range: vscode.CompletionItem['range'] = {
      inserting: new vscode.Range(document.positionAt(ctx.token.start), position),
      replacing: new vscode.Range(document.positionAt(ctx.token.start), document.positionAt(ctx.token.end)),
    }
    const items = ctx.kind === 'class' ? this.classItems
      : ctx.kind === 'colorProp' ? this.colorItems
      : this.ensureIconItems()

    // typed `attr=` without quotes yet: completions must insert the quotes too
    if (ctx.needsQuotes) {
      return items.map((item) => {
        const clone = new vscode.CompletionItem(item.label, item.kind)
        const name = typeof item.label === 'string' ? item.label : item.label.label
        clone.insertText = `"${name}"`
        clone.filterText = item.filterText
        clone.sortText = item.sortText
        clone.detail = item.detail
        clone.range = range
        const entry = itemEntries.get(item)
        if (entry) itemEntries.set(clone, entry)
        return clone
      })
    }

    for (const item of items) item.range = range
    return items
  }

  async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
    const entry = itemEntries.get(item)
    if (!entry) return item

    if ('exportName' in entry) {
      // IconEntry: preview image, loaded lazily
      if (this.host.icons) {
        const md = await iconPreviewMarkdown(this.host.icons, entry)
        if (md) item.documentation = md
      }
      return item
    }

    const md = new vscode.MarkdownString()
    if ('css' in entry) {
      // ClassEntry
      if (entry.color) appendColorInfo(md, entry.color)
      md.appendCodeblock(entry.css, 'css')
    } else {
      appendColorInfo(md, entry)
    }
    item.documentation = md
    return item
  }

  private ensureIconItems(): vscode.CompletionItem[] {
    if (this.iconItems) return this.iconItems
    const icons = this.host.icons
    if (!icons || !icons.available) return []
    this.iconItems = icons.entries.map((entry) => {
      const item = new vscode.CompletionItem(
        { label: entry.name, description: entry.set },
        vscode.CompletionItemKind.Value,
      )
      item.filterText = entry.name
      item.sortText = `${entry.set === icons.defaultSet ? '0' : '1'}-${entry.name}`
      itemEntries.set(item, entry)
      return item
    })
    return this.iconItems
  }

  private ensureItems(): void {
    const index = this.host.index
    if (this.builtVersion === index.version) return

    this.classItems = index.classEntries.map((entry) => {
      const isColor = entry.kind === 'color'
      const item = new vscode.CompletionItem(
        { label: entry.name, description: entry.category },
        isColor ? vscode.CompletionItemKind.Color : vscode.CompletionItemKind.Value,
      )
      item.filterText = entry.name
      item.sortText = `${sortPrefix(entry.category)}-${entry.name}`
      // strict-match color in detail -> suggest-widget swatch, independent of resolved docs
      if (entry.swatch) item.detail = entry.swatch
      else if (entry.summary) item.detail = entry.summary
      itemEntries.set(item, entry)
      return item
    })

    this.colorItems = [...index.colors.values()].map((color) => {
      const item = new vscode.CompletionItem(
        { label: color.name, description: color.source === 'palette' ? 'quasar' : color.source },
        vscode.CompletionItemKind.Color,
      )
      item.filterText = color.name
      const custom = color.source !== 'palette' && color.source !== 'brand-default'
      item.sortText = `${custom ? '0' : '1'}-${color.name}`
      if (color.swatch) item.detail = color.swatch
      itemEntries.set(item, color)
      return item
    })

    this.builtVersion = index.version
  }
}

/** attribute context at an offset, via the per-version doc cache */
function contextAt(document: vscode.TextDocument, offset: number, host: IndexHost): AttrContext | null {
  const { text, region } = getDocState(document)
  if (!region || offset < region.start || offset > region.end) return null
  return getAttributeContext(text, offset, host.index.classifyAttr)
}

/** small rounded color chip as an inline markdown image (data-uri svg) */
function chip(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">` +
    `<rect width="12" height="12" rx="2" fill="${color}" stroke="#80808080"/></svg>`
  return `![](data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`
}

function appendColorInfo(md: vscode.MarkdownString, color: ColorDef): void {
  const tv = color.themeValues
  if (tv && (tv.light || tv.dark)) {
    const parts: string[] = []
    if (tv.light) parts.push(`light ${chip(tv.light)} \`${tv.light}\``)
    if (tv.dark) parts.push(`dark ${chip(tv.dark)} \`${tv.dark}\``)
    md.appendMarkdown(`${parts.join(' · ')}\n\n`)
  } else if (color.swatch) {
    md.appendMarkdown(`${chip(color.swatch)} \`${color.hex ?? color.value}\`\n\n`)
  } else {
    md.appendMarkdown(`\`${color.value}\`\n\n`)
  }
}

export class QuasarHoverProvider implements vscode.HoverProvider {
  constructor(private host: IndexHost) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const offset = document.offsetAt(position)
    const ctx = contextAt(document, offset, this.host)
    if (!ctx || !ctx.token.text || offset < ctx.token.start || offset > ctx.token.end) return undefined
    const range = new vscode.Range(document.positionAt(ctx.token.start), document.positionAt(ctx.token.end))

    if (ctx.kind === 'iconProp') {
      const icons = this.host.icons
      const ref = resolveIconName(ctx.token.text)
      if (!icons || !ref) return undefined
      const md = await iconPreviewMarkdown(icons, {
        name: ctx.token.text, set: ref.set, exportName: ref.exportName,
      })
      return md ? new vscode.Hover(md, range) : undefined
    }

    const data = getHoverData(ctx, this.host.index)
    if (!data) return undefined

    const md = new vscode.MarkdownString()
    if (data.color) appendColorInfo(md, data.color)
    if (data.css) md.appendCodeblock(data.css, 'css')

    return new vscode.Hover(md, range)
  }
}
