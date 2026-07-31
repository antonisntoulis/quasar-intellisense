import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pascal, quasarSvgToSvg, svgToDataUri, type IconSetId, ICON_SET_IDS } from '../core/icons'
import { readQuasarConfig } from './quasarConfig'
import { findInstalledPackage } from './nodeModules'
import bundledLigatures from '../../data/material-ligatures'

const LIGATURES = bundledLigatures as { icons: string[]; symbols: string[] }


export interface IconEntry {
  /** template syntax: 'close', 'o_close', 'mdi-account', 'fas fa-user' */
  name: string
  set: IconSetId
  exportName: string
}

/**
 * Icon data for the sets THIS project loads. Everything lazy:
 *  - set detection: one async scan of source imports + quasar.config
 *  - name lists: bundled ligatures (material) / webfont css parse (class sets)
 *  - svg path data: whole-set index.js parsed on first preview, kept in memory
 */
export class IconData {
  detectedSets: IconSetId[] = []
  defaultSet: IconSetId = 'material-icons'
  /** completion candidates across detected sets, template syntax */
  entries: IconEntry[] = []
  /** template-syntax names of every offered icon, for diagnostics */
  knownNames = new Set<string>()
  /** project defines $q.iconMapFn: names can be anything, suppress diagnostics */
  hasIconMapFn = false
  /** a source file imports quasar.addon.css / flex-addon (non-CLI cssAddon) */
  addonCssDetected = false
  /** export name -> encoded svg, per set (loaded on first preview need) */
  private svgs = new Map<IconSetId, Map<string, string>>()
  private svgLoads = new Map<IconSetId, Promise<void>>()
  private dataUriCache = new Map<string, string>()
  private extrasRoot: string | undefined

  /** root: the quasar app directory; workspaceRoot: where the node_modules walk stops */
  constructor(private root: string, workspaceRoot: string, private log: (msg: string) => void) {
    this.extrasRoot = findInstalledPackage('@quasar/extras', root, workspaceRoot)
  }

  get available(): boolean {
    return this.entries.length > 0
  }

  /** detect which sets the project uses, then build the name entries */
  async initialize(): Promise<void> {
    const started = Date.now()
    try {
      const detected = await this.detectSets()
      this.detectedSets = detected.sets
      this.defaultSet = detected.defaultSet
      for (const set of this.detectedSets) {
        for (const entry of this.loadNames(set)) {
          this.entries.push(entry)
          this.knownNames.add(entry.name)
        }
      }
      this.log(
        `Icons: sets [${this.detectedSets.join(', ')}] (default ${this.defaultSet}), ` +
        `${this.entries.length} names in ${Date.now() - started}ms.`,
      )
    } catch (err) {
      this.log(`Icon detection failed: ${String(err)}`)
    }
  }

  // ---------------------------------------------------------- detection ----

  private async detectSets(): Promise<{ sets: IconSetId[]; defaultSet: IconSetId }> {
    const found = new Set<IconSetId>()
    let defaultSet: IconSetId | undefined

    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, 'src/**/*.{ts,js,mjs,vue}'),
      '**/node_modules/**',
    )
    const importRe = /@quasar\/extras\/(?:svg-)?([a-z0-9-]+)/g
    const iconSetRe = /quasar\/icon-set\/(?:svg-)?([a-z0-9-]+)/
    for (const uri of uris) {
      let text: string
      try {
        text = (await vscode.workspace.fs.readFile(uri)).toString()
      } catch {
        continue
      }
      if (text.includes('iconMapFn')) this.hasIconMapFn = true
      if (text.includes('quasar.addon') || text.includes('flex-addon')) this.addonCssDetected = true
      if (!text.includes('@quasar/extras') && !text.includes('quasar/icon-set')) continue
      for (const m of text.matchAll(importRe)) {
        if ((ICON_SET_IDS as string[]).includes(m[1]!)) found.add(m[1] as IconSetId)
      }
      const is = iconSetRe.exec(text)
      if (is && (ICON_SET_IDS as string[]).includes(is[1]!)) defaultSet ??= is[1] as IconSetId
    }

    // quasar CLI projects: extras: [...] + framework.iconSet
    const config = readQuasarConfig(this.root)
    if (config) {
      const extras = /extras\s*:\s*\[([^\]]*)\]/.exec(config.text)?.[1] ?? ''
      for (const m of extras.matchAll(/['"](?:svg-)?([a-z0-9-]+)['"]/g)) {
        if ((ICON_SET_IDS as string[]).includes(m[1]!)) found.add(m[1] as IconSetId)
      }
      const is = /iconSet\s*:\s*['"](?:svg-)?([a-z0-9-]+)['"]/.exec(config.text)
      if (is && (ICON_SET_IDS as string[]).includes(is[1]!)) defaultSet ??= is[1] as IconSetId
    }

    if (found.size === 0 && this.extrasRoot) found.add('material-icons')
    const sets = [...found]
    const def = defaultSet && sets.includes(defaultSet) ? defaultSet : sets[0] ?? 'material-icons'
    sets.sort((a, b) => Number(b === def) - Number(a === def))
    return { sets, defaultSet: def }
  }

  // --------------------------------------------------------- name lists ----

  private loadNames(set: IconSetId): IconEntry[] {
    const MATERIAL: Partial<Record<IconSetId, { list: string[]; namePrefix: string; exportPrefix: string }>> = {
      'material-icons': { list: LIGATURES.icons, namePrefix: '', exportPrefix: 'mat' },
      'material-icons-outlined': { list: LIGATURES.icons, namePrefix: 'o_', exportPrefix: 'outlined' },
      'material-icons-round': { list: LIGATURES.icons, namePrefix: 'r_', exportPrefix: 'round' },
      'material-icons-sharp': { list: LIGATURES.icons, namePrefix: 's_', exportPrefix: 'sharp' },
      'material-symbols-outlined': { list: LIGATURES.symbols, namePrefix: 'sym_o_', exportPrefix: 'symOutlined' },
      'material-symbols-rounded': { list: LIGATURES.symbols, namePrefix: 'sym_r_', exportPrefix: 'symRounded' },
      'material-symbols-sharp': { list: LIGATURES.symbols, namePrefix: 'sym_s_', exportPrefix: 'symSharp' },
    }
    const material = MATERIAL[set]
    if (!material) return this.loadClassSetNames(set)

    // the INSTALLED extras defines what actually renders: our bundled ligature
    // list tracks Google's current codepoints, which may include names the
    // installed (older) extras lacks — intersect so we never offer phantoms.
    // (Verified: forward mapping covers the installed export list completely.)
    const installed = this.readExportNames(set)
    const usable = installed.size > 0
      ? material.list.filter((n) => installed.has(material.exportPrefix + pascal(n)))
      : material.list
    return usable.map((n) => ({
      name: material.namePrefix + n,
      set,
      exportName: material.exportPrefix + pascal(n),
    }))
  }

  /**
   * Class-based sets: css class tokens (loose collection — FA7 uses custom
   * properties, older sets ::before) validated against the set's svg export
   * list, which is authoritative and drops sizing/modifier classes for free.
   */
  private loadClassSetNames(set: IconSetId): IconEntry[] {
    const css = this.readExtras(set, `${set}.css`)
    if (!css) return []
    const tokens = new Set<string>()
    for (const m of css.matchAll(/\.((?:mdi|fa|bi|la|eva|ti|ion)-[\w-]+)/g)) tokens.add(m[1]!)

    const exports = this.readExportNames(set)
    const entries: IconEntry[] = []
    for (const token of tokens) {
      const base = pascal(token.replace(/^[a-z]+-/, ''))
      if (set === 'fontawesome-v7') {
        for (const style of ['fas', 'far', 'fab'] as const) {
          if (exports.has(style + base)) {
            entries.push({ name: `${style} ${token}`, set, exportName: style + base })
          }
        }
      } else if (set === 'line-awesome') {
        if (exports.has(`la${base}Solid`)) {
          entries.push({ name: `las ${token}`, set, exportName: `la${base}Solid` })
        } else if (exports.has(`la${base}`)) {
          entries.push({ name: `lab ${token}`, set, exportName: `la${base}` })
        }
      } else {
        const prefix = { 'mdi-v7': 'mdi', 'bootstrap-icons': 'bi', 'eva-icons': 'eva', themify: 'ti', 'ionicons-v4': 'ion' }[set as string]!
        const exportName = set === 'ionicons-v4' ? 'ion' + pascal(token.slice(4)) : prefix + base
        if (exports.has(exportName)) entries.push({ name: token, set, exportName })
      }
    }
    return entries
  }

  private readExportNames(set: IconSetId): Set<string> {
    const json = this.readExtras(set, 'icons.json')
    if (json) {
      try {
        return new Set(JSON.parse(json) as string[])
      } catch {
        // fall through to d.ts
      }
    }
    const dts = this.readExtras(set, 'index.d.ts')
    const names = new Set<string>()
    if (dts) for (const m of dts.matchAll(/export declare const (\w+)/g)) names.add(m[1]!)
    return names
  }

  /** handles both extras v2 (exports/<set>/) and v1 (<set>/ + svg-<set>/) layouts */
  private readExtras(set: IconSetId, file: string): string | undefined {
    if (!this.extrasRoot) return undefined
    const svgFile = file === 'index.js' || file === 'index.d.ts' || file === 'icons.json'
    const dirs = svgFile
      ? [`exports/${set}`, `svg-${set}`, set]
      : [`exports/${set}`, set]
    for (const dir of dirs) {
      try {
        return fs.readFileSync(path.join(this.extrasRoot, dir, file), 'utf8')
      } catch {
        // try next layout
      }
    }
    return undefined
  }

  // ------------------------------------------------------------ previews ---

  isKnownExport(set: IconSetId, exportName: string): boolean {
    return this.svgs.get(set)?.has(exportName) ?? false
  }

  /** kick off (once) loading a set's svg bodies; resolves when queryable */
  ensureSvgs(set: IconSetId): Promise<void> {
    let load = this.svgLoads.get(set)
    if (!load) {
      load = new Promise((resolve) => {
        setImmediate(() => {
          const started = Date.now()
          const js = this.readExtras(set, 'index.js')
          const map = new Map<string, string>()
          if (js) {
            for (const m of js.matchAll(/export const (\w+) = ["']([^"']+)["']/g)) {
              map.set(m[1]!, m[2]!)
            }
            this.log(`Icons: loaded ${map.size} svg bodies for ${set} in ${Date.now() - started}ms.`)
          }
          this.svgs.set(set, map)
          resolve()
        })
      })
      this.svgLoads.set(set, load)
    }
    return load
  }

  /** theme-colored preview; undefined until the set's svgs are loaded */
  getDataUri(set: IconSetId, exportName: string, sizePx: number, color: string): string | undefined {
    const key = `${set}|${exportName}|${sizePx}|${color}`
    const cached = this.dataUriCache.get(key)
    if (cached) return cached
    const encoded = this.svgs.get(set)?.get(exportName)
    if (!encoded) return undefined
    const uri = svgToDataUri(quasarSvgToSvg(encoded, sizePx, color))
    this.dataUriCache.set(key, uri)
    return uri
  }

  clearRenderCache(): void {
    this.dataUriCache.clear()
  }
}
