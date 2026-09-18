import { Hono } from 'hono'
import { exigirSesion, usuarioDe } from '../lib/auth'
import { limitar, quienPide } from '../lib/limites'
import { invalida, noEncontrado } from '../lib/errores'
import { exigirBucket, nuevoId, validarBytes, archivoValido, urlsImagen, MAX_GRANDE, MAX_MINI } from '../lib/imagenes'
import type { Contexto } from '../tipos'

export const imagenes = new Hono<Contexto>()

/* ------------------------------------------------------------------ *
 *  POST /api/imagenes  ·  subir (con sesión)
 *  multipart/form-data con dos campos: `grande` y `mini`.
 *  Devuelve { id, imagen: { grande, mini } }. El id es lo que se manda
 *  luego como `imagen` al crear o editar un evento.
 * ------------------------------------------------------------------ */
imagenes.post('/', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const bucket = exigirBucket(c.env)

  // Antes de leer el cuerpo: no gastar memoria en peticiones que se van a rechazar.
  const largo = Number(c.req.header('Content-Length') ?? 0)
  if (largo > MAX_GRANDE + MAX_MINI + 10_000) throw invalida('La imagen pesa demasiado')

  await limitar(c, { clave: `imagen:${quienPide(c)}`, limite: 30, ventanaSegundos: 3_600 })

  let formulario: FormData
  try {
    formulario = await c.req.formData()
  } catch {
    throw invalida('Se esperaba multipart/form-data con los campos "grande" y "mini"')
  }

  const grande = formulario.get('grande')
  const mini = formulario.get('mini')
  if (!(grande instanceof File) || !(mini instanceof File)) {
    throw invalida('Faltan los campos "grande" y "mini"')
  }

  const bytesGrande = new Uint8Array(await grande.arrayBuffer())
  const bytesMini = new Uint8Array(await mini.arrayBuffer())
  const tipoGrande = validarBytes(bytesGrande, MAX_GRANDE, 'grande')
  const tipoMini = validarBytes(bytesMini, MAX_MINI, 'mini')

  const id = nuevoId()
  const comunes = { customMetadata: { subidoPor: usuario.id, subidaEn: new Date().toISOString() } }

  await Promise.all([
    bucket.put(id, bytesGrande, { ...comunes, httpMetadata: { contentType: tipoGrande } }),
    bucket.put(`${id}-mini`, bytesMini, { ...comunes, httpMetadata: { contentType: tipoMini } }),
  ])

  return c.json({ id, imagen: urlsImagen(id) }, 201)
})

/* ------------------------------------------------------------------ *
 *  GET /api/imagenes/:archivo  ·  servir (público)
 *  Los ids nunca se reutilizan (cambiar la foto crea otro), así que la
 *  respuesta se puede cachear para siempre en el navegador y en nginx:
 *  cada imagen llega al Worker una sola vez.
 * ------------------------------------------------------------------ */
imagenes.get('/:archivo', async (c) => {
  const archivo = c.req.param('archivo')
  if (!archivoValido(archivo)) throw noEncontrado('Esa imagen no existe')
  const bucket = exigirBucket(c.env)

  const objeto = await bucket.get(archivo)
  if (!objeto) throw noEncontrado('Esa imagen no existe')

  const etag = objeto.httpEtag
  const cabeceras = {
    'Content-Type': objeto.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    // Si alguien abre la URL directamente, que no se ejecute nada.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }

  if (c.req.header('If-None-Match') === etag) return c.body(null, 304, cabeceras)
  return c.body(objeto.body as ReadableStream, 200, cabeceras)
})
