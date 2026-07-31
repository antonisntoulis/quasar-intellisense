import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { QuasarIndex } from './core/quasarIndex'
import type { ColorPropsData } from './core/types'
import { QuasarCompletionProvider, QuasarHoverProvider, themeKind, type IndexHost } from './vscode/providers'
import { ColorDecorations } from './vscode/decorations'
import { ColorDiagnostics } from './vscode/diagnostics'
import { QuasarDefinitionProvider } from './vscode/definitions'
import { QuasarCodeActionProvider } from './vscode/codeActions'
import { CustomColorScanner } from './vscode/watchers'
import { IconData } from './vscode/iconData'

const SELECTOR: vscode.DocumentSelector = { language: 'vue', scheme: 'file' }

let output: vscode.OutputChannel

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Quasar IntelliSense')
  context.subscriptions.push(output)

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root || !hasQuasarDependency(root)) {
    output.appendLine('No quasar dependency found in workspace, staying dormant.')
    return
  }

  const started = Date.now()
  const host: IndexHost = { index: new QuasarIndex(buildStaticInputs(root)) }

  host.index.setActiveTheme(themeKind())

  const completionProvider = new QuasarCompletionProvider(host)
  const decorations = new ColorDecorations(host)
  const diagnostics = new ColorDiagnostics(host)
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, completionProvider, '"', "'", ' ', '='),
    vscode.languages.registerHoverProvider(SELECTOR, new QuasarHoverProvider(host)),
    vscode.languages.registerDefinitionProvider(SELECTOR, new QuasarDefinitionProvider(host, root)),
    vscode.languages.registerCodeActionsProvider(
      SELECTOR, new QuasarCodeActionProvider(host), QuasarCodeActionProvider.metadata),
    vscode.window.onDidChangeActiveColorTheme(() => {
      host.index.setActiveTheme(themeKind())
      host.icons?.clearRenderCache()
      decorations.updateAll()
      diagnostics.refreshAll()
    }),
  )
  decorations.register(context)
  diagnostics.register(context)

  output.appendLine(
    `Activated in ${Date.now() - started}ms: ${host.index.classEntries.length} classes, ` +
    `${host.index.colors.size} colors, ${host.index.colorPropNames.size} color props.`,
  )

  // custom colors arrive asynchronously; completions work immediately with defaults
  const scanner = new CustomColorScanner(
    host, root,
    () => {
      decorations.updateAll()
      diagnostics.refreshAll()
    },
    (msg) => output.appendLine(msg),
  )
  scanner.register(context)
  void scanner.scan()

  // the 152-file dist/api walk costs ~13ms: run it after activation and swap
  // the (rarely different) runtime table over the bundled one when it lands
  setImmediate(() => {
    try {
      host.index.setColorProps(walkApiForColorProps(path.join(root, 'node_modules/quasar/dist/api')))
    } catch {
      output.appendLine('quasar/dist/api not readable, keeping bundled color-prop table.')
    }
  })

  // icons: detect sets, load name lists, then preload svg bodies for previews;
  // all off the activation path, decorations appear when data lands
  const icons = new IconData(root, (msg) => output.appendLine(msg))
  host.icons = icons
  void icons.initialize().then(async () => {
    await Promise.all(icons.detectedSets.map((set) => icons.ensureSvgs(set)))
    decorations.updateAll()
    diagnostics.refreshAll()
  })
}

export function deactivate(): void {}

function hasQuasarDependency(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return Boolean(pkg.dependencies?.quasar ?? pkg.devDependencies?.quasar)
  } catch {
    return false
  }
}

function buildStaticInputs(root: string): {
  variablesSassText?: string
  variablesSassPath?: string
} {
  const inputs: { variablesSassText?: string; variablesSassPath?: string } = {}
  try {
    const variablesPath = path.join(root, 'node_modules/quasar/src/css/variables.sass')
    inputs.variablesSassText = fs.readFileSync(variablesPath, 'utf8')
    inputs.variablesSassPath = variablesPath
  } catch {
    output.appendLine('quasar/src/css/variables.sass not readable, using bundled palette snapshot.')
  }
  return inputs
}

const kebab = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()

/** NamedColor-tagged, or an untagged String prop whose desc references the palette
 *  (quasar's own metadata misses QDate.event-color, QEditor.toolbar-toggle-color) */
function isColorPropDef(def: { tsType?: string; type?: unknown; desc?: string }): boolean {
  if (def?.tsType === 'NamedColor') return true
  const type = Array.isArray(def?.type) ? def.type : [def?.type]
  return type.includes('String') && /quasar (color )?palette/i.test(def?.desc ?? '')
}

function walkApiForColorProps(apiDir: string): ColorPropsData {
  const components: Record<string, string[]> = {}
  const propNames = new Set<string>()
  for (const file of fs.readdirSync(apiDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const api = JSON.parse(fs.readFileSync(path.join(apiDir, file), 'utf8'))
      const props = api.props as Record<string, { tsType?: string; type?: unknown; desc?: string }> | undefined
      if (!props) continue
      const colorProps = Object.entries(props)
        .filter(([, def]) => isColorPropDef(def))
        .map(([key]) => kebab(key))
      if (colorProps.length > 0) {
        components[kebab(path.basename(file, '.json'))] = colorProps
        colorProps.forEach((p) => propNames.add(p))
      }
    } catch {
      // single unreadable api file: skip
    }
  }
  if (propNames.size === 0) throw new Error('no color props found')
  return { components, propNames: [...propNames].sort() }
}
