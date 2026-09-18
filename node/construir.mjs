/**
 * Compila src/ y node/ a JavaScript en dist/, para el contenedor.
 *
 * Sólo transpila (quita los tipos), no comprueba: para eso está `npm run tipos`.
 * Sale en CommonJS para que los imports sin extensión de src/ (que es lo que
 * espera wrangler) funcionen en Node tal cual, sin tocar ni una línea.
 *
 * Uso:  npm run construir   ->  node dist/node/servidor.js
 */

import ts from 'typescript'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(RAIZ, 'dist')

const opciones = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  sourceMap: false,
}

function* ficherosTs(dir) {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) yield* ficherosTs(ruta)
    else if (nombre.endsWith('.ts') && !nombre.endsWith('.d.ts')) yield ruta
  }
}

rmSync(DIST, { recursive: true, force: true })
let n = 0
for (const carpeta of ['src', 'node']) {
  for (const fichero of ficherosTs(join(RAIZ, carpeta))) {
    const { outputText, diagnostics } = ts.transpileModule(readFileSync(fichero, 'utf8'), {
      compilerOptions: opciones,
      fileName: fichero,
      reportDiagnostics: true,
    })
    if (diagnostics?.length) {
      for (const d of diagnostics) console.error(`${relative(RAIZ, fichero)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
      process.exit(1)
    }
    const destino = join(DIST, relative(RAIZ, fichero)).replace(/\.ts$/, '.js')
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, outputText)
    n++
  }
}
// El package.json raíz dice "type": "module"; dist/ es CommonJS.
writeFileSync(join(DIST, 'package.json'), '{ "type": "commonjs" }\n')
console.log(`${n} ficheros compilados en dist/`)
