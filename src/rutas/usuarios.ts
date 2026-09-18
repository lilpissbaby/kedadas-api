import { Hono } from 'hono'
import { z } from 'zod'
import { conDb } from '../lib/db'
import { esDev, exigirSesion, usuarioDe, crearSesion } from '../lib/auth'
import { perfilPublico, perfilPropio, guardarAlEntrar } from '../lib/usuarios'
import { ErrorApi, invalida, noEncontrado } from '../lib/errores'
import { detallesDeZod } from '../esquemas'
import { borrarImagenes } from '../lib/imagenes'
import type { Contexto, Usuario } from '../tipos'

export const usuarios = new Hono<Contexto>()

/** Las rutas de abajo que son de desarrollo no existen si MODO_DEV no está. */
function soloDev(env: Contexto['Bindings']) {
  if (!esDev(env)) throw new ErrorApi('no_encontrado', 'No existe')
}

const NombreDev = z.object({
  nombre: z
    .string()
    .trim()
    .min(2, 'Mínimo 2 caracteres')
    .max(40)
    .regex(/^[a-zA-Z0-9_. áéíóúñÁÉÍÓÚÑ-]+$/, 'Sólo letras, números, espacios, punto, guion y guion bajo'),
  foto: z.string().url().max(500).optional(),
})

/* ------------------------------------------------------------------ *
 *  GET /api/usuarios/yo  ·  mi ficha completa
 * ------------------------------------------------------------------ */
usuarios.get('/yo', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)

  const { valor } = await conDb(c.env, async ({ col }) => {
    const doc = await col.usuarios.findOne({ usuarioId: usuario.id })
    if (!doc) return null

    const [creados, apuntados] = await Promise.all([
      col.eventos.countDocuments({ creadoPor: usuario.id }),
      col.suscripciones.countDocuments({ usuarioId: usuario.id }),
    ])
    return { doc, creados, apuntados }
  })

  // Puede no existir la ficha si la sesión es de antes de que hubiera
  // colección de usuarios. Se responde con lo que hay en el token.
  if (!valor) {
    return c.json({ usuario: { id: usuario.id, nombre: usuario.nombre ?? null, foto: null, desde: null }, eventosCreados: 0, suscripciones: 0 })
  }

  return c.json({
    usuario: perfilPropio(valor.doc),
    eventosCreados: valor.creados,
    suscripciones: valor.apuntados,
  })
})

/* ------------------------------------------------------------------ *
 *  GET /api/usuarios/:id  ·  perfil público de un organizador
 *  Público: el frontend lo usa para "organizado por ...".
 *  Sin email nunca.
 * ------------------------------------------------------------------ */
usuarios.get('/:id', async (c) => {
  const id = c.req.param('id') // Hono ya lo decodifica

  const { valor } = await conDb(c.env, async ({ col }) => {
    const doc = await col.usuarios.findOne({ usuarioId: id })
    if (!doc) return null
    const creados = await col.eventos.countDocuments({ creadoPor: id, oculto: { $ne: true } })
    return { doc, creados }
  })

  if (!valor) throw noEncontrado('No hay ningún usuario con ese id')
  return c.json({ usuario: perfilPublico(valor.doc), eventosCreados: valor.creados })
})

/* ================================================================== *
 *  A partir de aquí, SÓLO DESARROLLO.
 *  Con MODO_DEV apagado estas rutas devuelven 404 como si no existieran.
 *  Sirven para tener usuarios de mentira con los que montar el frontend
 *  sin depender de Google.
 * ================================================================== */

/* POST /api/usuarios/dev  ·  crear usuario de prueba (y entrar con él) */
usuarios.post('/dev', async (c) => {
  soloDev(c.env)

  const analisis = NombreDev.safeParse(await c.req.json().catch(() => ({})))
  if (!analisis.success) throw invalida('Nombre no válido', detallesDeZod(analisis.error))
  const { nombre, foto } = analisis.data

  const usuario: Usuario = { id: `dev:${nombre}`, nombre, foto }

  const { valor } = await conDb(c.env, async ({ col }) => {
    await guardarAlEntrar(col, usuario, 'dev')
    return col.usuarios.findOne({ usuarioId: usuario.id })
  })

  // Deja la cookie puesta: desde el navegador te quedas dentro directamente.
  await crearSesion(c, usuario)

  return c.json(
    {
      usuario: valor ? perfilPropio(valor) : usuario,
      sesionIniciada: true,
      aviso: 'Usuario de desarrollo. Con MODO_DEV apagado esta ruta no existe.',
    },
    201,
  )
})

/* GET /api/usuarios/dev/lista  ·  ver los de prueba que hay */
usuarios.get('/dev/lista', async (c) => {
  soloDev(c.env)

  const { valor } = await conDb(c.env, ({ col }) =>
    col.usuarios.find({ proveedor: 'dev' }).sort({ creadoEn: -1 }).limit(100).toArray(),
  )

  return c.json({
    total: valor.length,
    usuarios: valor.map(perfilPublico),
  })
})

/* DELETE /api/usuarios/dev/:nombre  ·  limpiar un usuario de prueba y lo suyo */
usuarios.delete('/dev/:nombre', async (c) => {
  soloDev(c.env)
  const id = `dev:${c.req.param('nombre')}`

  const { valor } = await conDb(c.env, async ({ col }) => {
    const conFoto = await col.eventos.find({ creadoPor: id, imagen: { $exists: true } } as never).toArray()
    await borrarImagenes(c.env, conFoto.map((e) => e.imagen))
    const eventos = await col.eventos.deleteMany({ creadoPor: id })
    const subs = await col.suscripciones.deleteMany({ usuarioId: id })
    const denuncias = await col.denuncias.deleteMany({ usuarioId: id })
    const usuario = await col.usuarios.deleteOne({ usuarioId: id })
    return {
      usuarioBorrado: usuario.deletedCount > 0,
      eventos: eventos.deletedCount,
      suscripciones: subs.deletedCount,
      denuncias: denuncias.deletedCount,
    }
  })

  return c.json(valor)
})
