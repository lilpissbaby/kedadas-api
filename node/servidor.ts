/**
 * La misma API, fuera de Cloudflare: un proceso Node para Docker.
 *
 * El código de src/ no sabe dónde corre. Hono sólo necesita una función
 * fetch(Request, env) y aquí se le da:
 *   - un servidor HTTP de Node que convierte cada petición en un Request,
 *   - las variables de entorno del contenedor como `env`,
 *   - CACHE  -> KV en memoria (límites y caché del mapa),
 *   - IMAGENES -> "bucket" en disco, en el volumen /datos/imagenes,
 *   - MONGO_POOL=1 -> la conexión a Mongo se reutiliza entre peticiones.
 *
 * Sin dependencias nuevas a propósito: nada que auditar ni que actualizar.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import app from '../src/index'
import { cerrarPool } from '../src/lib/db'
import type { Env } from '../src/tipos'
import { kvEnMemoria } from './kv-memoria'
import { bucketEnDisco } from './r2-disco'

const PUERTO = Number(process.env.PUERTO ?? 8787)

/* ---------------- env ---------------- */

const variables = [
  'MONGODB_URI', 'JWT_SECRET', 'DB_NAME', 'ORIGEN_WEB',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'MODO_DEV',
] as const

const env: Env = { MONGODB_URI: '', JWT_SECRET: '' }
for (const nombre of variables) {
  const valor = process.env[nombre]
  if (valor !== undefined && valor !== '') (env as Record<string, unknown>)[nombre] = valor
}
env.MONGO_POOL = '1'

if (process.env.CACHE !== 'no') env.CACHE = kvEnMemoria() as unknown as Env['CACHE']
if (process.env.IMAGENES_DIR) env.IMAGENES = bucketEnDisco(process.env.IMAGENES_DIR) as unknown as Env['IMAGENES']

// Fallar al arrancar, no en la primera petición de un usuario.
const faltan = (['MONGODB_URI', 'JWT_SECRET'] as const).filter((n) => !env[n])
if (faltan.length) {
  console.error(`Faltan variables obligatorias: ${faltan.join(', ')}. Revisa el .env.`)
  process.exit(1)
}
if (env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET tiene que tener al menos 32 caracteres.')
  process.exit(1)
}
if (env.MODO_DEV === '1') {
  console.warn('\n  ⚠  MODO_DEV=1: cualquiera puede hacerse pasar por cualquiera con una cabecera.')
  console.warn('     Sólo para probar. Quítalo del .env antes de exponer esto.\n')
}

/* ---------------- Node <-> fetch ---------------- */

function aRequest(req: IncomingMessage): Request {
  const cabeceras = new Headers()
  for (const [nombre, valor] of Object.entries(req.headers)) {
    if (valor === undefined) continue
    if (Array.isArray(valor)) valor.forEach((v) => cabeceras.append(nombre, v))
    else cabeceras.set(nombre, valor)
  }

  // El contenedor no publica puertos: sólo le habla el nginx del frontend, que
  // pisa X-Forwarded-For con la IP real. CF-Connecting-IP, en cambio, la podría
  // mandar cualquiera desde fuera para saltarse los límites; aquí se reescribe.
  cabeceras.delete('cf-connecting-ip')
  const ipReal = cabeceras.get('x-forwarded-for')?.split(',')[0]?.trim() || req.socket.remoteAddress
  if (ipReal) cabeceras.set('cf-connecting-ip', ipReal)

  const url = `http://${req.headers.host ?? `localhost:${PUERTO}`}${req.url ?? '/'}`
  const conCuerpo = req.method !== 'GET' && req.method !== 'HEAD'

  return new Request(url, {
    method: req.method,
    headers: cabeceras,
    body: conCuerpo ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Obligatorio en Node cuando el cuerpo es un stream.
    ...(conCuerpo ? { duplex: 'half' } : {}),
  } as RequestInit)
}

async function responder(respuesta: Response, res: ServerResponse) {
  const cabeceras: Record<string, string | string[]> = {}
  respuesta.headers.forEach((valor, nombre) => {
    if (nombre !== 'set-cookie') cabeceras[nombre] = valor
  })
  const cookies = respuesta.headers.getSetCookie()
  if (cookies.length) cabeceras['set-cookie'] = cookies

  res.writeHead(respuesta.status, cabeceras)
  if (!respuesta.body) return void res.end()

  await new Promise<void>((resolver, rechazar) => {
    Readable.fromWeb(respuesta.body as never)
      .on('error', rechazar)
      .pipe(res)
      .on('finish', resolver)
      .on('error', rechazar)
  })
}

const servidor = createServer(async (req, res) => {
  try {
    const respuesta = await app.fetch(aRequest(req), env)
    await responder(respuesta, res)
  } catch (err) {
    console.error('Error sin capturar:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { codigo: 'interno', mensaje: 'Algo ha fallado' } }))
    } else {
      res.destroy()
    }
  }
})

// Que un cliente lento no tenga sockets abiertos para siempre.
servidor.headersTimeout = 15_000
servidor.requestTimeout = 90_000
servidor.keepAliveTimeout = 65_000 // mayor que el keepalive de nginx

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`api-fiestas escuchando en :${PUERTO} · caché ${env.CACHE ? 'en memoria' : 'no'} · imágenes ${env.IMAGENES ? process.env.IMAGENES_DIR : 'no'}`)
})

/* ---------------- apagado limpio ---------------- */

let apagando = false
for (const senal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(senal, () => {
    if (apagando) return
    apagando = true
    console.log(`${senal}: terminando peticiones en curso…`)
    servidor.close(async () => {
      await cerrarPool()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
