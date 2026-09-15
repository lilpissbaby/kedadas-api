import type { Context } from 'hono'
import { ErrorApi } from './errores'
import type { Contexto } from '../tipos'

/**
 * Límite de peticiones para las rutas que escriben, y caché para la consulta
 * del mapa. Las dos cosas se apoyan en un KV opcional: si el binding CACHE no
 * está configurado, la API funciona igual, sólo que sin límite ni caché.
 *
 * Esto NO sustituye a las reglas de Rate Limiting del panel de Cloudflare, que
 * son gratis y paran el tráfico antes de que llegue al Worker. Esto es la
 * segunda capa, la que cuenta por usuario en lugar de por IP.
 */

type Opciones = {
  clave: string
  limite: number
  ventanaSegundos: number
}

export async function limitar(c: Context<Contexto>, o: Opciones) {
  const kv = c.env.CACHE
  if (!kv) return // sin KV no hay límite; está documentado y es deliberado

  const ventana = Math.floor(Date.now() / 1000 / o.ventanaSegundos)
  const clave = `lim:${o.clave}:${ventana}`

  const actual = Number((await kv.get(clave)) ?? 0)

  if (actual >= o.limite) {
    throw new ErrorApi(
      'demasiadas_peticiones',
      `Has hecho esto ${o.limite} veces en poco rato. Espera un momento.`,
    )
  }

  // No es atómico: bajo carga puede colarse alguna petición de más. Para frenar
  // abuso es suficiente; para contar dinero haría falta un Durable Object.
  // El TTL mínimo que acepta KV son 60 segundos.
  await kv.put(clave, String(actual + 1), { expirationTtl: Math.max(o.ventanaSegundos * 2, 60) })
}

/** Identifica a quien pide: el usuario si hay sesión, la IP si no. */
export function quienPide(c: Context<Contexto>) {
  const usuario = c.get('usuario')
  if (usuario) return usuario.id
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'anonimo'
}

/**
 * Caché de la consulta del mapa. Redondea las coordenadas para que dos
 * personas en la misma calle compartan entrada en lugar de generar una nueva
 * cada una. 3 decimales ~ 110 metros.
 */
export function claveMapa(lng: number, lat: number, radio: number, tipo?: string) {
  const r = (n: number) => n.toFixed(3)
  return `mapa:${r(lng)}:${r(lat)}:${radio}:${tipo ?? 'todos'}`
}

export async function deCache<T>(c: Context<Contexto>, clave: string): Promise<T | undefined> {
  const kv = c.env.CACHE
  if (!kv) return undefined
  try {
    return (await kv.get(clave, 'json')) as T | undefined
  } catch {
    return undefined
  }
}

export async function aCache(c: Context<Contexto>, clave: string, valor: unknown, segundos = 45) {
  const kv = c.env.CACHE
  if (!kv) return
  try {
    await kv.put(clave, JSON.stringify(valor), { expirationTtl: Math.max(segundos, 60) })
  } catch {
    // Que falle la caché nunca debe tumbar la respuesta.
  }
}
