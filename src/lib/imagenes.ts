import type { Env } from '../tipos'
import { ErrorApi, invalida } from './errores'

/**
 * Imágenes de los eventos, en R2 (nunca en Mongo).
 *
 * Cada imagen son DOS objetos: `<id>` (grande, hasta 1080 px) y `<id>-mini`
 * (160 px, para las burbujas del mapa). El redimensionado lo hace el
 * navegador antes de subir: en Workers no hay librería de imagen gratis, y
 * así un mapa con 100 burbujas descarga 100 miniaturas de ~6 KB y no 100
 * fotos de 200 KB.
 *
 * Qué se comprueba aquí, porque el cliente puede mentir:
 *   - Los bytes son de verdad WebP o JPEG (no se mira el Content-Type).
 *   - No llevan metadatos EXIF/XMP. Una foto del móvil trae las coordenadas
 *     GPS de donde se hizo, y en una app de fiestas eso suele ser la casa de
 *     alguien. El navegador los quita al volver a codificar; si alguien sube
 *     directamente a la API sin pasar por ahí, se rechaza.
 *   - Tamaño máximo.
 * El id es aleatorio y la ruta de lectura sólo acepta ese formato, así que
 * nadie puede leer ni pisar otras claves del bucket.
 */

export const ID_IMAGEN = /^[a-f0-9]{24}$/
const ARCHIVO_IMAGEN = /^([a-f0-9]{24})(-mini)?$/

export const MAX_GRANDE = 1_500_000
export const MAX_MINI = 100_000

export function exigirBucket(env: Env) {
  if (!env.IMAGENES) {
    throw new ErrorApi(
      'no_configurado',
      'Las imágenes no están activadas en este despliegue. Falta el bucket R2 IMAGENES (ver README).',
    )
  }
  return env.IMAGENES
}

export function nuevoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function archivoValido(archivo: string) {
  return ARCHIVO_IMAGEN.test(archivo)
}

/** Lo que ve el cliente. Rutas relativas: el frontend sirve la API bajo su dominio. */
export function urlsImagen(id?: string | null) {
  if (!id) return null
  return { grande: `/api/imagenes/${id}`, mini: `/api/imagenes/${id}-mini` }
}

/* ------------------------------------------------------------------ *
 *  Validación de bytes
 * ------------------------------------------------------------------ */

const ascii = (b: Uint8Array, desde: number, largo: number) => String.fromCharCode(...b.subarray(desde, desde + largo))

/** Devuelve el content-type real o lanza 400 explicando por qué no vale. */
export function validarBytes(bytes: Uint8Array, maximo: number, nombre: string): 'image/webp' | 'image/jpeg' {
  if (bytes.length === 0) throw invalida(`La imagen "${nombre}" está vacía`)
  if (bytes.length > maximo) throw invalida(`La imagen "${nombre}" pesa demasiado (máximo ${Math.round(maximo / 1000)} KB)`)

  // --- WebP: RIFF....WEBP y luego chunks ---
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    let pos = 12
    while (pos + 8 <= bytes.length) {
      const tipo = ascii(bytes, pos, 4)
      const largo = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24)
      if (tipo === 'EXIF' || tipo === 'XMP ') throw invalida(`La imagen "${nombre}" lleva metadatos (EXIF/XMP). Súbela desde la app, que los quita.`)
      if (largo < 0) break
      pos += 8 + largo + (largo % 2)
    }
    return 'image/webp'
  }

  // --- JPEG: FFD8 y segmentos hasta el inicio de los datos (FFDA) ---
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let pos = 2
    while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
      const marcador = bytes[pos + 1]
      if (marcador === 0xda) break // empiezan los datos de imagen
      const largo = (bytes[pos + 2] << 8) | bytes[pos + 3]
      // APP1 es donde van EXIF (con GPS) y XMP.
      if (marcador === 0xe1) throw invalida(`La imagen "${nombre}" lleva metadatos (EXIF/XMP). Súbela desde la app, que los quita.`)
      pos += 2 + largo
    }
    return 'image/jpeg'
  }

  throw invalida(`"${nombre}" no es una imagen WebP ni JPEG`)
}

/* ------------------------------------------------------------------ *
 *  Propiedad y borrado
 * ------------------------------------------------------------------ */

/**
 * Antes de enlazar una imagen a un evento se comprueba que exista y que la
 * haya subido quien crea o edita. Sin esto, cualquiera podría poner en su
 * evento la foto de otra persona, y al borrarlo, borrarla.
 */
export async function comprobarImagenPropia(env: Env, id: string, usuarioId: string) {
  const bucket = exigirBucket(env)
  const cabecera = await bucket.head(id)
  if (!cabecera || cabecera.customMetadata?.subidoPor !== usuarioId) {
    throw invalida('Esa imagen no existe o no la has subido tú. Vuelve a elegirla.', [
      { campo: 'imagen', problema: 'Imagen no encontrada' },
    ])
  }
}

/** Borra grande y miniatura. Sin bucket o con fallo, no rompe la petición. */
export async function borrarImagenes(env: Env, ids: (string | null | undefined)[]) {
  const bucket = env.IMAGENES
  const validos = ids.filter((i): i is string => Boolean(i && ID_IMAGEN.test(i)))
  if (!bucket || validos.length === 0) return
  try {
    await bucket.delete(validos.flatMap((id) => [id, `${id}-mini`]))
  } catch (err) {
    // Queda una imagen huérfana en R2: cuesta céntimos y no se ve en ningún sitio.
    console.error('No se pudieron borrar imágenes de R2:', err)
  }
}
