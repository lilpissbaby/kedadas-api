/**
 * Encuentra la cadena de conexión mires donde la mires, y avisa claro si lo
 * que has puesto todavía es el ejemplo en lugar de tu cluster.
 *
 * Orden de búsqueda:
 *   1. argumento:  node scripts/seed.mjs "mongodb+srv://..."
 *   2. variable:   export MONGODB_URI='mongodb+srv://...'
 *   3. fichero .dev.vars  (el mismo que usa wrangler dev)
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

function deDevVars(clave) {
  const fichero = join(RAIZ, '.dev.vars')
  if (!existsSync(fichero)) return undefined
  for (const linea of readFileSync(fichero, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(linea)) continue
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && m[1] === clave) return m[2].replace(/^["']|["']$/g, '')
  }
  return undefined
}

export function leerUri(desdeArgumento) {
  return desdeArgumento ?? process.env.MONGODB_URI ?? deDevVars('MONGODB_URI')
}

/** Oculta la contraseña para poder enseñar la cadena sin regalarla. */
export function tapar(uri = '') {
  return uri.replace(/\/\/[^@]*@/, '//***:***@')
}

export function comprobarUri(uri) {
  if (!uri) {
    console.error(`
No encuentro la cadena de conexión. Tienes tres formas, elige una:

  1)  export MONGODB_URI='mongodb+srv://usuario:password@cluster0.ab1cd.mongodb.net/?retryWrites=true&w=majority'
      npm run seed

  2)  node scripts/seed.mjs 'mongodb+srv://usuario:password@cluster0.ab1cd.mongodb.net/?retryWrites=true&w=majority'

  3)  cp .dev.vars.example .dev.vars    (y editas MONGODB_URI dentro)
      npm run seed

Comillas SIMPLES: la cadena lleva ? y &, y el bash se los come entre comillas dobles.
`)
    process.exit(1)
  }

  const sigueDeEjemplo =
    uri.includes('...') ||
    uri.includes('<db_password>') ||
    uri.includes('xxxx') ||
    /:\s*password\s*@/.test(uri) ||
    uri.includes('usuario:')

  if (sigueDeEjemplo) {
    console.error(`
Esa cadena sigue siendo el EJEMPLO, no tu cluster:

    ${tapar(uri)}

La de verdad la copias en Atlas:
  cloud.mongodb.com  ->  tu cluster  ->  botón "Connect"  ->  "Drivers"  ->  Node.js

Tiene esta pinta, con el nombre de TU cluster en medio:
  mongodb+srv://mp7:MiPassGenerada@cluster0.ab1cd.mongodb.net/?retryWrites=true&w=majority

Y sustituye <db_password> por la contraseña del usuario de base de datos
(la de "Database Access", no la de tu cuenta de MongoDB).
`)
    process.exit(1)
  }

  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    console.error(`\nLa cadena tiene que empezar por mongodb+srv:// o mongodb://. La tuya empieza por: ${uri.slice(0, 20)}...\n`)
    process.exit(1)
  }
}

/** Traduce el error de Mongo a algo accionable. */
export function explicarError(err) {
  const m = err?.message ?? String(err)
  if (m.includes('EBADNAME') || m.includes('querySrv')) {
    return 'El nombre del cluster no existe en DNS. Casi siempre es que la cadena sigue teniendo el ejemplo, o que copiaste mal el trozo cluster0.xxxxx.mongodb.net.'
  }
  if (m.includes('ServerSelection') || m.includes('timed out')) {
    return 'Resuelve el DNS pero no deja conectar: en Atlas > Network Access añade 0.0.0.0/0.'
  }
  if (m.includes('already exists with a different name')) {
    return 'Ese índice ya existe con otro nombre. Los índices los crea "npm run indices"; ningún otro script debe crearlos. Si quieres empezar de cero: db.eventos.dropIndexes() en Atlas y vuelve a lanzar npm run indices.'
  }
  if (m.includes('Authentication failed') || m.includes('bad auth')) {
    return 'Usuario o contraseña incorrectos. Ojo: es el usuario de "Database Access", no tu cuenta de MongoDB. Si la contraseña lleva @ / : o #, hay que codificarla (@ -> %40).'
  }
  return 'Sin diagnóstico automático para este error.'
}
