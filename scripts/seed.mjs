/**
 * Prepara el cluster para la prueba:
 *   1. crea el índice 2dsphere (la línea de la que depende todo el mapa)
 *   2. mete 500 fiestas falsas repartidas en 10 km alrededor de un centro
 *   3. comprueba con explain() que la consulta USA el índice y no escanea
 *
 * Uso:  MONGODB_URI="mongodb+srv://..." node scripts/seed.mjs
 *       node scripts/seed.mjs "mongodb+srv://..." -3.7038 40.4168
 */

import { MongoClient } from 'mongodb'
import { leerUri, comprobarUri, explicarError, tapar } from './uri.mjs'

const URI = leerUri(process.argv[2])
const LNG = Number(process.argv[3] ?? -3.7038) // Puerta del Sol
const LAT = Number(process.argv[4] ?? 40.4168)
const DB = process.env.DB_NAME ?? 'fiestas'
const CUANTOS = 500

comprobarUri(URI)

const TIPOS = ['ayuntamiento', 'bar', 'discoteca', 'pub', 'casual', 'manifestacion', 'particular']
const NOMBRES = ['Noche de', 'Fiesta en', 'Concierto de', 'Verbena de', 'Sesión de', 'Tardeo en', 'Cierre de']
const SITIOS = ['la plaza', 'el casco viejo', 'el polígono', 'la ribera', 'el mercado', 'la nave', 'el parque']

/** Desplaza un punto unos metros al azar (aprox. suficiente para una prueba). */
function cerca(lng, lat, metrosMax) {
  const r = Math.sqrt(Math.random()) * metrosMax
  const ang = Math.random() * 2 * Math.PI
  const dLat = (r * Math.cos(ang)) / 111_320
  const dLng = (r * Math.sin(ang)) / (111_320 * Math.cos((lat * Math.PI) / 180))
  return [lng + dLng, lat + dLat]
}

const client = new MongoClient(URI)

try {
  console.log(`Conectando a ${tapar(URI)}`)
  const t0 = Date.now()
  await client.connect()
  console.log(`Conectado en ${Date.now() - t0} ms`)

  const col = client.db(DB).collection('eventos')
  await col.deleteMany({ _semilla: true })

  const ahora = Date.now()
  const docs = Array.from({ length: CUANTOS }, (_, i) => {
    const empieza = new Date(ahora + (Math.random() * 14 - 2) * 24 * 3600 * 1000)
    return {
      _semilla: true,
      titulo: `${NOMBRES[i % NOMBRES.length]} ${SITIOS[i % SITIOS.length]} #${i + 1}`,
      tipo: TIPOS[i % TIPOS.length],
      loc: { type: 'Point', coordinates: cerca(LNG, LAT, 10_000) },
      empiezaEn: empieza,
      terminaEn: new Date(empieza.getTime() + 6 * 3600 * 1000),
      creadoPor: `dev:usuario_${i % 40}`,
      cancionUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      suscritos: Math.floor(Math.random() * 200),
      creadoEn: new Date(),
    }
  })

  await col.insertMany(docs)
  console.log(`Insertadas ${docs.length} fiestas alrededor de [${LNG}, ${LAT}]`)

  // Los índices NO se crean aquí: son cosa de `npm run indices`, que además
  // les pone nombre. Si los creara también este script con otro nombre, Mongo
  // rechazaría el segundo ("Index already exists with a different name").
  // Aquí sólo se comprueba que estén.
  const indices = await col.indexes()
  const hayGeo = indices.some((i) => Object.values(i.key).includes('2dsphere'))
  if (!hayGeo) {
    console.error('\nNo hay índice 2dsphere en "eventos". Ejecuta primero:  npm run indices')
    process.exit(1)
  }
  console.log(`Índices presentes: ${indices.map((i) => i.name).join(', ')}`)

  // ¿Usa el índice o está escaneando la colección entera?
  const plan = await col
    .find({
      loc: { $near: { $geometry: { type: 'Point', coordinates: [LNG, LAT] }, $maxDistance: 3000 } },
      terminaEn: { $gte: new Date() },
    })
    .limit(50)
    .explain('executionStats')

  const etapa = JSON.stringify(plan.queryPlanner?.winningPlan ?? {})
  const stats = plan.executionStats ?? {}
  console.log('\n--- explain ---')
  console.log('usa GEO_NEAR_2DSPHERE :', etapa.includes('GEO_NEAR_2DSPHERE') ? 'SÍ' : 'NO  <-- mal, revisa el índice')
  console.log('documentos devueltos  :', stats.nReturned)
  console.log('documentos examinados :', stats.totalDocsExamined)
  console.log('tiempo en el servidor :', stats.executionTimeMillis, 'ms')
  console.log('\nListo. Si no lo has hecho aún: npm run indices, y luego npm run dev')
} catch (err) {
  console.error('\nHa fallado:', err.message)
  console.error('->', explicarError(err))
  process.exitCode = 1
} finally {
  await client.close()
}