import { z } from 'zod'

/**
 * Validación en el borde. Todo lo que entra del cliente pasa por aquí antes
 * de tocar la base de datos. Sin excepciones: es la mitad de la seguridad de
 * una API, y la otra mitad es la autorización por objeto.
 */

export const TIPOS_EVENTO = [
  'ayuntamiento',
  'bar',
  'discoteca',
  'pub',
  'casual',
  'manifestacion',
  'particular',
] as const

const longitud = z.number().min(-180).max(180)
const latitud = z.number().min(-90).max(90)

/** Consulta del mapa: ?lng=&lat=&r=&tipo= */
export const ConsultaCercanos = z.object({
  lng: z.coerce.number().pipe(longitud),
  lat: z.coerce.number().pipe(latitud),
  // 50 km es el techo duro: una consulta más amplia no es un mapa, es un volcado.
  r: z.coerce.number().int().min(100).max(50_000).default(3_000),
  tipo: z.enum(TIPOS_EVENTO).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
})

const urlCancion = z
  .string()
  .url('Tiene que ser una URL completa')
  .max(500)
  .refine(
    (u) => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, '')
        return [
          'open.spotify.com',
          'youtube.com',
          'youtu.be',
          'music.youtube.com',
          'music.apple.com',
          'soundcloud.com',
          'bandcamp.com',
        ].some((p) => host === p || host.endsWith('.' + p))
      } catch {
        return false
      }
    },
    { message: 'Sólo se admiten enlaces de Spotify, YouTube, Apple Music, SoundCloud o Bandcamp' },
  )

const fecha = z.coerce.date()

/** Id de una imagen ya subida con POST /api/imagenes. Nunca una URL: así no se cuelan enlaces externos. */
const idImagen = z.string().regex(/^[a-f0-9]{24}$/, 'Imagen no válida')

export const CrearEvento = z
  .object({
    titulo: z.string().trim().min(3, 'Mínimo 3 caracteres').max(120),
    descripcion: z.string().trim().max(2_000).optional(),
    tipo: z.enum(TIPOS_EVENTO),
    lng: longitud,
    lat: latitud,
    empiezaEn: fecha,
    terminaEn: fecha,
    cancionUrl: urlCancion.optional(),
    imagen: idImagen.optional(),
  })
  .refine((d) => d.terminaEn > d.empiezaEn, {
    message: 'La fiesta no puede terminar antes de empezar',
    path: ['terminaEn'],
  })
  .refine((d) => d.terminaEn.getTime() - d.empiezaEn.getTime() <= 7 * 24 * 3600 * 1000, {
    message: 'Una fiesta no puede durar más de 7 días',
    path: ['terminaEn'],
  })
  .refine((d) => d.empiezaEn.getTime() > Date.now() - 24 * 3600 * 1000, {
    message: 'No se pueden crear fiestas que ya han pasado',
    path: ['empiezaEn'],
  })

/** En la edición todo es opcional, pero lo que venga se valida igual de duro. */
export const EditarEvento = z
  .object({
    titulo: z.string().trim().min(3).max(120).optional(),
    descripcion: z.string().trim().max(2_000).optional(),
    tipo: z.enum(TIPOS_EVENTO).optional(),
    lng: longitud.optional(),
    lat: latitud.optional(),
    empiezaEn: fecha.optional(),
    terminaEn: fecha.optional(),
    cancionUrl: urlCancion.nullable().optional(), // null = quitar la canción
    imagen: idImagen.nullable().optional(), // null = volver al emoji
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No has enviado ningún cambio' })
  .refine((d) => (d.lng === undefined) === (d.lat === undefined), {
    message: 'Para mover una fiesta hacen falta lng y lat a la vez',
  })
  .refine((d) => !(d.empiezaEn && d.terminaEn) || d.terminaEn > d.empiezaEn, {
    message: 'La fiesta no puede terminar antes de empezar',
    path: ['terminaEn'],
  })

export const CrearDenuncia = z.object({
  motivo: z.enum(['spam', 'contenido_ofensivo', 'no_existe', 'peligroso', 'otro']),
  comentario: z.string().trim().max(500).optional(),
})

export const Paginacion = z.object({
  limite: z.coerce.number().int().min(1).max(100).default(50),
  desde: z.string().optional(), // _id del último resultado de la página anterior
})

/** Convierte un fallo de Zod en algo que un humano pueda leer en la UI. */
export function detallesDeZod(err: z.ZodError) {
  return err.issues.map((i) => ({
    campo: i.path.join('.') || '(cuerpo)',
    problema: i.message,
  }))
}
