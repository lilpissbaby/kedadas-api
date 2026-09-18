/**
 * Lo mínimo de un KV de Cloudflare que usa src/lib/limites.ts: get y put con
 * caducidad. Vive en memoria del proceso, así que:
 *   - se vacía al reiniciar el contenedor (son límites por hora y una caché de
 *     45 s: no pasa nada),
 *   - no se comparte entre réplicas. Con una sola réplica, que es lo que hay,
 *     da igual. Si algún día hay varias, esto pasa a ser Redis.
 */

type Entrada = { valor: string; caduca: number }

const MAX_ENTRADAS = 50_000 // tope por si alguien barre coordenadas para llenar la memoria

export function kvEnMemoria() {
  const datos = new Map<string, Entrada>()

  const barrido = setInterval(() => {
    const ahora = Date.now()
    for (const [clave, e] of datos) if (e.caduca <= ahora) datos.delete(clave)
  }, 60_000)
  barrido.unref()

  return {
    async get(clave: string, tipo?: 'text' | 'json') {
      const e = datos.get(clave)
      if (!e) return null
      if (e.caduca <= Date.now()) {
        datos.delete(clave)
        return null
      }
      return tipo === 'json' ? JSON.parse(e.valor) : e.valor
    },

    async put(clave: string, valor: string, opciones?: { expirationTtl?: number }) {
      if (datos.size >= MAX_ENTRADAS && !datos.has(clave)) {
        // Fuera la más antigua (Map mantiene el orden de inserción).
        const primera = datos.keys().next().value
        if (primera !== undefined) datos.delete(primera)
      }
      const ttl = Math.max(opciones?.expirationTtl ?? 3600, 60)
      datos.set(clave, { valor: String(valor), caduca: Date.now() + ttl * 1000 })
    },

    async delete(clave: string) {
      datos.delete(clave)
    },
  }
}
