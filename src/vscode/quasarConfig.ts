import * as fs from 'node:fs'
import * as path from 'node:path'

const CONFIG_CANDIDATES = ['quasar.config.ts', 'quasar.config.js', 'quasar.conf.js']

/** first readable quasar config in the workspace root, if any */
export function readQuasarConfig(root: string): { text: string; file: string } | undefined {
  for (const name of CONFIG_CANDIDATES) {
    try {
      return { text: fs.readFileSync(path.join(root, name), 'utf8'), file: name }
    } catch {
      // try next candidate
    }
  }
  return undefined
}
