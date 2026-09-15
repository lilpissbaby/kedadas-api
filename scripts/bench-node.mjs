/**
 * El otro lado de la comparación: la MISMA consulta desde un Node normal.
 *
 * Node puede mantener el pool vivo entre peticiones; Workers no. Este script
 * mide las dos cosas por separado para que el número de Workers tenga con qué
 * compararse:
 *
 *   A) 5 peticiones abriendo conexión cada vez  -> lo que hace un Worker
 *   B) 5 peticiones reutilizando la conexión    -> lo que hace un contenedor
 *
 * La diferencia entre A y B es exactamente lo que cuesta la decisión
 * "Workers" frente a "contenedor en Koyeb/Render".
 *
 * Uso:  MONGODB_URI="mongodb+srv://..." node scripts/bench-node.mjs
 */

import { MongoClient } from 'mongodb'
import { leerUri, comprobarUri, tapar } from './uri.mjs'

const URI = leerUri(process.argv[2])
const DB = process.env.DB_NAME ?? 'fiestas'
const LNG = -3.7038
const LAT = 40.4168
const VUELTAS = 5

comprobarUri(URI)

const filtro = () => ({
  loc: { $near: { $geometry: { type: 'Point', coordinates: [LNG, LAT] }, $maxDistance: 3000 } },
  terminaEn: { $gte: new Date() },
})

const consultar = (client) => client.db(DB).collection('eventos').find(filtro()).limit(50).toArray()

const media = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length)

console.log(`Midiendo contra ${tapar(URI)}\n`)

// --- A) conexión nueva cada vez (el comportamiento de un Worker) ---
const sinPool = []
for (let i = 0; i < VUELTAS; i++) {
  const t = Date.now()
  const c = new MongoClient(URI, { maxPoolSize: 1 })
  await c.connect()
  await consultar(c)
  await c.close()
  sinPool.push(Date.now() - t)
}
console.log('A) conexión nueva cada petición  :', sinPool.map((n) => n + 'ms').join('  '), ' -> media', media(sinPool) + 'ms')

// --- B) pool reutilizado (el comportamiento de un contenedor) ---
const conPool = []
const cliente = new MongoClient(URI)
const tArranque = Date.now()
await cliente.connect()
const arranque = Date.now() - tArranque
for (let i = 0; i < VUELTAS; i++) {
  const t = Date.now()
  await consultar(cliente)
  conPool.push(Date.now() - t)
}
await cliente.close()
console.log('B) pool reutilizado              :', conPool.map((n) => n + 'ms').join('  '), ' -> media', media(conPool) + 'ms')
console.log(`   (arranque del pool, una sola vez: ${arranque}ms)`)

const penalizacion = media(sinPool) - media(conPool)
console.log(`\nPeaje de no tener pool: ~${penalizacion} ms por petición.`)
console.log(
  penalizacion > 400
    ? 'Es alto. En el mapa se va a notar: plantea Durable Object, caché en KV o contenedor.'
    : 'Es asumible para el MVP: sigue con Workers.',
)
