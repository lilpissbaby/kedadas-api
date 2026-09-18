/**
 * Lo mínimo de un bucket R2 que usan src/lib/imagenes.ts y src/rutas/imagenes.ts
 * (put, head, get, delete), guardado en disco. En Docker ese directorio es el
 * volumen `api_fiestas_imagenes`: sobrevive a reinicios y a reconstruir la imagen.
 *
 * Cada objeto son dos ficheros: `<clave>` con los bytes y `<clave>.json` con
 * los metadatos (tipo, quién la subió, etag).
 *
 * Las claves se validan otra vez aquí aunque las rutas ya lo hagan: en disco,
 * una clave con "../" sería leer o pisar cualquier fichero del contenedor.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const CLAVE_VALIDA = /^[A-Za-z0-9_-]{1,100}$/

type Metadatos = {
  etag: string
  size: number
  uploaded: string
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

export function bucketEnDisco(directorio: string) {
  const listo = mkdir(directorio, { recursive: true })

  const ruta = (clave: string) => {
    if (!CLAVE_VALIDA.test(clave)) throw new Error(`Clave de imagen no válida: ${clave}`)
    return join(directorio, clave)
  }

  async function leerMeta(clave: string): Promise<Metadatos | null> {
    try {
      return JSON.parse(await readFile(ruta(clave) + '.json', 'utf8'))
    } catch {
      return null
    }
  }

  const aObjeto = (clave: string, m: Metadatos) => ({
    key: clave,
    size: m.size,
    etag: m.etag,
    httpEtag: `"${m.etag}"`,
    uploaded: new Date(m.uploaded),
    httpMetadata: m.httpMetadata ?? {},
    customMetadata: m.customMetadata ?? {},
  })

  /** Escribe en un temporal y renombra: nunca queda un fichero a medias. */
  async function escribirAtomico(destino: string, datos: Uint8Array | string) {
    const tmp = `${destino}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, datos)
    await rename(tmp, destino)
  }

  return {
    async put(
      clave: string,
      valor: Uint8Array | ArrayBuffer | string,
      opciones?: { httpMetadata?: Metadatos['httpMetadata']; customMetadata?: Metadatos['customMetadata'] },
    ) {
      await listo
      const bytes = typeof valor === 'string' ? Buffer.from(valor) : valor instanceof ArrayBuffer ? new Uint8Array(valor) : valor
      const meta: Metadatos = {
        etag: createHash('md5').update(bytes).digest('hex'),
        size: bytes.byteLength,
        uploaded: new Date().toISOString(),
        httpMetadata: opciones?.httpMetadata,
        customMetadata: opciones?.customMetadata,
      }
      const destino = ruta(clave)
      await escribirAtomico(destino, bytes)
      await escribirAtomico(destino + '.json', JSON.stringify(meta))
      return aObjeto(clave, meta)
    },

    async head(clave: string) {
      if (!CLAVE_VALIDA.test(clave)) return null
      const meta = await leerMeta(clave)
      return meta ? aObjeto(clave, meta) : null
    },

    async get(clave: string) {
      if (!CLAVE_VALIDA.test(clave)) return null
      const meta = await leerMeta(clave)
      if (!meta) return null
      const body = Readable.toWeb(createReadStream(ruta(clave))) as unknown as ReadableStream
      return { ...aObjeto(clave, meta), body }
    },

    async delete(claves: string | string[]) {
      for (const clave of Array.isArray(claves) ? claves : [claves]) {
        if (!CLAVE_VALIDA.test(clave)) continue
        await rm(ruta(clave), { force: true })
        await rm(ruta(clave) + '.json', { force: true })
      }
    },
  }
}
