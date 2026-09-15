import { Hono } from 'hono'
import { ObjectId } from 'mongodb'
import { conDb, type Evento } from '../lib/db'
import { exigirSesion, usuarioDe } from '../lib/auth'
import { perfilPublico } from '../lib/usuarios'
import { limitar, quienPide, claveMapa, deCache, aCache } from '../lib/limites'
import { invalida, noEncontrado, sinPermiso, conflicto } from '../lib/errores'
import { ConsultaCercanos, CrearEvento, EditarEvento, CrearDenuncia, detallesDeZod } from '../esquemas'
import type { Contexto } from '../tipos'

export const eventos = new Hono<Contexto>()

/** Lo que sale hacia el cliente. Nunca se devuelve el documento crudo. */
function aPublico(e: Evento & { _id: ObjectId }, usuarioId?: string) {
  return {
    id: e._id.toString(),
    titulo: e.titulo,
    descripcion: e.descripcion ?? null,
    tipo: e.tipo,
    lng: e.loc.coordinates[0],
    lat: e.loc.coordinates[1],
    empiezaEn: e.empiezaEn,
    terminaEn: e.terminaEn,
    cancionUrl: e.cancionUrl ?? null,
    suscritos: e.suscritos ?? 0,
    creadoPor: e.creadoPor, // id del organizador: /api/usuarios/:id da su perfil
    esMio: usuarioId ? e.creadoPor === usuarioId : false,
  }
}

function idValido(bruto: string) {
  if (!ObjectId.isValid(bruto)) throw noEncontrado('Ese evento no existe')
  return new ObjectId(bruto)
}

/* ------------------------------------------------------------------ *
 *  GET /api/eventos  ·  las burbujas del mapa
 *  Público. Es la ruta más llamada de toda la app, así que es la única
 *  que pasa por caché.
 * ------------------------------------------------------------------ */
eventos.get('/', async (c) => {
  const analisis = ConsultaCercanos.safeParse(c.req.query())
  if (!analisis.success) throw invalida('Parámetros del mapa incorrectos', detallesDeZod(analisis.error))
  const { lng, lat, r, tipo, limite } = analisis.data

  const clave = claveMapa(lng, lat, r, tipo)
  const cacheado = await deCache<{ eventos: unknown[] }>(c, clave)
  if (cacheado) {
    c.header('X-Cache', 'HIT')
    return c.json({ ...cacheado, centro: [lng, lat], radio: r })
  }

  const { valor, msConexion } = await conDb(c.env, async ({ col }) => {
    const ahora = new Date()
    const filtro: Record<string, unknown> = {
      loc: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: r } },
      terminaEn: { $gte: ahora },
      oculto: { $ne: true },
    }
    if (tipo) filtro.tipo = tipo

    return col.eventos.find(filtro).limit(limite).toArray()
  })

  const usuario = c.get('usuario')
  const salida = { eventos: valor.map((e) => aPublico(e as never, usuario?.id)) }

  // Sin usuario en la respuesta la caché es compartible; con "esMio" dentro no
  // lo sería, así que sólo se cachea la versión anónima.
  if (!usuario) await aCache(c, clave, salida, 45)

  c.header('X-Cache', 'MISS')
  c.header('X-Db-Conexion-Ms', String(msConexion))
  return c.json({ ...salida, centro: [lng, lat], radio: r })
})

/* ------------------------------------------------------------------ *
 *  GET /api/eventos/:id  ·  la ficha, con la canción
 * ------------------------------------------------------------------ */
eventos.get('/:id', async (c) => {
  const id = idValido(c.req.param('id'))
  const usuario = c.get('usuario')

  const { valor } = await conDb(c.env, async ({ col }) => {
    const evento = await col.eventos.findOne({ _id: id as never })
    if (!evento || evento.oculto) return null

    // En la ficha sí se trae el organizador: es una consulta más, pero es la
    // pantalla donde el usuario quiere ver quién monta la fiesta.
    const creador = await col.usuarios.findOne({ usuarioId: evento.creadoPor })

    // Y si hay sesión, si esa persona ya está apuntada.
    const apuntado = usuario
      ? Boolean(await col.suscripciones.findOne({ eventoId: id.toString(), usuarioId: usuario.id }))
      : false

    return { evento, creador, apuntado }
  })

  if (!valor) throw noEncontrado('Ese evento no existe')

  return c.json({
    evento: aPublico(valor.evento as never, usuario?.id),
    organizador: valor.creador ? perfilPublico(valor.creador) : null,
    estoyApuntado: valor.apuntado,
  })
})

/* ------------------------------------------------------------------ *
 *  POST /api/eventos  ·  crear
 * ------------------------------------------------------------------ */
eventos.post('/', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)

  const cuerpo = await c.req.json().catch(() => null)
  const analisis = CrearEvento.safeParse(cuerpo)
  if (!analisis.success) throw invalida('Revisa los datos del evento', detallesDeZod(analisis.error))
  const d = analisis.data

  // El límite va DESPUÉS de validar: corregir un typo tres veces no debe
  // gastarte la cuota del día. Lo que frena el abuso de verdad son las reglas
  // de Rate Limiting del panel, que actúan antes de llegar hasta aquí.
  await limitar(c, { clave: `crear:${quienPide(c)}`, limite: 10, ventanaSegundos: 3_600 })

  const documento: Evento = {
    titulo: d.titulo,
    descripcion: d.descripcion,
    tipo: d.tipo,
    loc: { type: 'Point', coordinates: [d.lng, d.lat] },
    empiezaEn: d.empiezaEn,
    terminaEn: d.terminaEn,
    creadoPor: usuario.id, // del token, JAMÁS del cuerpo de la petición
    cancionUrl: d.cancionUrl,
    suscritos: 0,
    creadoEn: new Date(),
  }

  const { valor } = await conDb(c.env, ({ col }) => col.eventos.insertOne(documento as never))

  return c.json({ evento: aPublico({ ...documento, _id: valor.insertedId } as never, usuario.id) }, 201)
})

/* ------------------------------------------------------------------ *
 *  PATCH /api/eventos/:id  ·  editar (sólo el creador)
 * ------------------------------------------------------------------ */
eventos.patch('/:id', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const id = idValido(c.req.param('id'))

  const cuerpo = await c.req.json().catch(() => null)
  const analisis = EditarEvento.safeParse(cuerpo)
  if (!analisis.success) throw invalida('Revisa los cambios', detallesDeZod(analisis.error))
  const d = analisis.data

  const cambios: Record<string, unknown> = { actualizadoEn: new Date() }
  const borrados: Record<string, ''> = {}

  if (d.titulo !== undefined) cambios.titulo = d.titulo
  if (d.descripcion !== undefined) cambios.descripcion = d.descripcion
  if (d.tipo !== undefined) cambios.tipo = d.tipo
  if (d.empiezaEn !== undefined) cambios.empiezaEn = d.empiezaEn
  if (d.terminaEn !== undefined) cambios.terminaEn = d.terminaEn
  if (d.lng !== undefined && d.lat !== undefined) {
    cambios.loc = { type: 'Point', coordinates: [d.lng, d.lat] }
  }
  if (d.cancionUrl === null) borrados.cancionUrl = ''
  else if (d.cancionUrl !== undefined) cambios.cancionUrl = d.cancionUrl

  const { valor } = await conDb(c.env, async ({ col }) => {
    const actual = await col.eventos.findOne({ _id: id as never })
    if (!actual) throw noEncontrado('Ese evento no existe')

    // La comprobación que ningún hosting hace por ti.
    if (actual.creadoPor !== usuario.id) throw sinPermiso()

    // Coherencia de fechas cuando sólo se cambia una de las dos.
    const empieza = (cambios.empiezaEn as Date) ?? actual.empiezaEn
    const termina = (cambios.terminaEn as Date) ?? actual.terminaEn
    if (termina <= empieza) throw invalida('La fiesta no puede terminar antes de empezar')

    const operacion: Record<string, unknown> = { $set: cambios }
    if (Object.keys(borrados).length) operacion.$unset = borrados

    return col.eventos.findOneAndUpdate({ _id: id as never }, operacion as never, { returnDocument: 'after' })
  })

  if (!valor) throw noEncontrado('Ese evento no existe')
  return c.json({ evento: aPublico(valor as never, usuario.id) })
})

/* ------------------------------------------------------------------ *
 *  DELETE /api/eventos/:id  ·  borrar (sólo el creador)
 * ------------------------------------------------------------------ */
eventos.delete('/:id', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const id = idValido(c.req.param('id'))

  await conDb(c.env, async ({ col }) => {
    const actual = await col.eventos.findOne({ _id: id as never })
    if (!actual) throw noEncontrado('Ese evento no existe')
    if (actual.creadoPor !== usuario.id) throw sinPermiso()

    await col.eventos.deleteOne({ _id: id as never })
    await col.suscripciones.deleteMany({ eventoId: id.toString() })
  })

  return c.body(null, 204)
})

/* ------------------------------------------------------------------ *
 *  POST /api/eventos/:id/denuncia  ·  moderación
 *  Va en el MVP, no después: el mapa es público y hay fiestas de
 *  particulares y manifestaciones.
 * ------------------------------------------------------------------ */
eventos.post('/:id/denuncia', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const id = idValido(c.req.param('id'))
  await limitar(c, { clave: `denuncia:${quienPide(c)}`, limite: 10, ventanaSegundos: 3_600 })

  const analisis = CrearDenuncia.safeParse(await c.req.json().catch(() => null))
  if (!analisis.success) throw invalida('Motivo de denuncia no válido', detallesDeZod(analisis.error))

  const { valor } = await conDb(c.env, async ({ col }) => {
    const evento = await col.eventos.findOne({ _id: id as never })
    if (!evento) throw noEncontrado('Ese evento no existe')

    const yaEsta = await col.denuncias.findOne({ eventoId: id.toString(), usuarioId: usuario.id })
    if (yaEsta) throw conflicto('Ya habías denunciado este evento')

    await col.denuncias.insertOne({
      eventoId: id.toString(),
      usuarioId: usuario.id,
      motivo: analisis.data.motivo,
      creadaEn: new Date(),
    })

    const actualizado = await col.eventos.findOneAndUpdate(
      { _id: id as never },
      { $inc: { denuncias: 1 } } as never,
      { returnDocument: 'after' },
    )

    // Umbral provisional: a las 5 denuncias se esconde solo y lo revisáis a mano.
    // Cuando tengáis usuarios de verdad habrá que afinarlo.
    const total = actualizado?.denuncias ?? 0
    if (total >= 5 && !actualizado?.oculto) {
      await col.eventos.updateOne({ _id: id as never }, { $set: { oculto: true } } as never)
      return { ocultado: true, total }
    }
    return { ocultado: false, total }
  })

  return c.json({ recibida: true, ocultadoAutomaticamente: valor.ocultado }, 201)
})
