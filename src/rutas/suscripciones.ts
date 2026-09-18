import { Hono } from 'hono'
import { ObjectId } from 'mongodb'
import { conDb } from '../lib/db'
import { exigirSesion, usuarioDe } from '../lib/auth'
import { limitar, quienPide } from '../lib/limites'
import { noEncontrado, conflicto } from '../lib/errores'
import { urlsImagen } from '../lib/imagenes'
import type { Contexto } from '../tipos'

/**
 * Apuntarse a una fiesta y desapuntarse.
 *
 * El contador `suscritos` del evento y la fila en `suscripciones` se tocan por
 * separado, sin transacción. Si una de las dos falla puede quedar descuadrado
 * por uno: el número que se enseña en el mapa es orientativo y no vale la pena
 * pagar una transacción por él. La verdad está en la colección, y de ahí se
 * puede recalcular cuando queráis.
 */

export const suscripciones = new Hono<Contexto>()

function idValido(bruto: string) {
  if (!ObjectId.isValid(bruto)) throw noEncontrado('Ese evento no existe')
  return new ObjectId(bruto)
}

/* POST /api/eventos/:id/suscripcion  ·  apuntarse */
suscripciones.post('/:id/suscripcion', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const id = idValido(c.req.param('id'))
  await limitar(c, { clave: `suscribir:${quienPide(c)}`, limite: 60, ventanaSegundos: 3_600 })

  const { valor } = await conDb(c.env, async ({ col }) => {
    const evento = await col.eventos.findOne({ _id: id as never })
    if (!evento || evento.oculto) throw noEncontrado('Ese evento no existe')
    if (evento.terminaEn < new Date()) throw conflicto('Esa fiesta ya ha terminado')

    try {
      await col.suscripciones.insertOne({
        eventoId: id.toString(),
        usuarioId: usuario.id,
        creadaEn: new Date(),
      })
    } catch (err) {
      // El índice único es quien impide apuntarse dos veces. Si salta, es que
      // ya estaba: no es un error que deba ver el usuario como fallo.
      if ((err as { code?: number })?.code === 11000) {
        return { suscritos: evento.suscritos ?? 0, yaEstaba: true }
      }
      throw err
    }

    const actualizado = await col.eventos.findOneAndUpdate(
      { _id: id as never },
      { $inc: { suscritos: 1 } } as never,
      { returnDocument: 'after' },
    )
    return { suscritos: actualizado?.suscritos ?? 0, yaEstaba: false }
  })

  return c.json({ suscrito: true, ...valor }, valor.yaEstaba ? 200 : 201)
})

/* DELETE /api/eventos/:id/suscripcion  ·  desapuntarse */
suscripciones.delete('/:id/suscripcion', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const id = idValido(c.req.param('id'))

  const { valor } = await conDb(c.env, async ({ col }) => {
    const borrada = await col.suscripciones.deleteOne({
      eventoId: id.toString(),
      usuarioId: usuario.id,
    })

    if (borrada.deletedCount === 0) {
      const evento = await col.eventos.findOne({ _id: id as never })
      return { suscritos: evento?.suscritos ?? 0 }
    }

    const actualizado = await col.eventos.findOneAndUpdate(
      { _id: id as never },
      { $inc: { suscritos: -1 } } as never,
      { returnDocument: 'after' },
    )
    return { suscritos: Math.max(actualizado?.suscritos ?? 0, 0) }
  })

  return c.json({ suscrito: false, ...valor })
})

/* GET /api/yo/suscripciones  ·  mis fiestas */
export const mias = new Hono<Contexto>()

mias.get('/suscripciones', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)
  const incluirPasadas = c.req.query('pasadas') === '1'

  const { valor } = await conDb(c.env, async ({ col }) => {
    const filas = await col.suscripciones
      .find({ usuarioId: usuario.id })
      .sort({ creadaEn: -1 })
      .limit(200)
      .toArray()

    if (filas.length === 0) return []

    const ids = filas.map((f) => new ObjectId(f.eventoId))
    const filtro: Record<string, unknown> = { _id: { $in: ids }, oculto: { $ne: true } }
    if (!incluirPasadas) filtro.terminaEn = { $gte: new Date() }

    return col.eventos.find(filtro as never).sort({ empiezaEn: 1 }).toArray()
  })

  return c.json({
    eventos: valor.map((e) => ({
      id: (e._id as ObjectId).toString(),
      titulo: e.titulo,
      tipo: e.tipo,
      lng: e.loc.coordinates[0],
      lat: e.loc.coordinates[1],
      empiezaEn: e.empiezaEn,
      terminaEn: e.terminaEn,
      cancionUrl: e.cancionUrl ?? null,
      imagen: urlsImagen(e.imagen),
      suscritos: e.suscritos ?? 0,
      esMio: e.creadoPor === usuario.id,
    })),
  })
})

/* GET /api/yo/eventos  ·  los que he creado */
mias.get('/eventos', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)

  const { valor } = await conDb(c.env, ({ col }) =>
    col.eventos.find({ creadoPor: usuario.id }).sort({ empiezaEn: -1 }).limit(200).toArray(),
  )

  return c.json({
    eventos: valor.map((e) => ({
      id: (e._id as ObjectId).toString(),
      titulo: e.titulo,
      tipo: e.tipo,
      empiezaEn: e.empiezaEn,
      terminaEn: e.terminaEn,
      imagen: urlsImagen(e.imagen),
      suscritos: e.suscritos ?? 0,
      denuncias: e.denuncias ?? 0,
      oculto: e.oculto ?? false,
    })),
  })
})
