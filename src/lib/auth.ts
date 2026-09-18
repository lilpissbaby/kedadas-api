import type { Context, MiddlewareHandler } from 'hono'
import { sign, verify } from 'hono/jwt'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { noAutenticado } from './errores'
import type { Contexto, Env, Usuario } from '../tipos'

/**
 * Sesión propia: un JWT corto guardado en una cookie httpOnly.
 *
 * En cookie y no en localStorage a propósito: si algún día os cuelan un XSS
 * en el frontend, el script no puede leer la cookie ni robar la sesión.
 * A cambio hace falta SameSite=Lax para que no la usen desde otro dominio.
 */

export const COOKIE_SESION = 'sesion'
const DURACION_SESION = 60 * 60 * 24 * 30 // 30 días

type Carga = {
  sub: string
  nombre?: string
  email?: string
  foto?: string
  exp: number
}

export async function crearSesion(c: Context<Contexto>, usuario: Usuario) {
  const carga: Carga = {
    sub: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    foto: usuario.foto,
    exp: Math.floor(Date.now() / 1000) + DURACION_SESION,
  }

  const token = await sign(carga, exigirSecreto(c.env), 'HS256')

  setCookie(c, COOKIE_SESION, token, {
    httpOnly: true,
    secure: !esDev(c.env), // en localhost wrangler sirve por http
    sameSite: 'Lax',
    path: '/',
    maxAge: DURACION_SESION,
  })
}

export function cerrarSesion(c: Context<Contexto>) {
  deleteCookie(c, COOKIE_SESION, { path: '/' })
}

/**
 * Lee la sesión si la hay, pero NO obliga. Se aplica a toda la API para que
 * las rutas públicas puedan saber quién mira sin exigir login.
 */
export const sesionOpcional: MiddlewareHandler<Contexto> = async (c, siguiente) => {
  const usuario = await leerUsuario(c)
  if (usuario) c.set('usuario', usuario)
  await siguiente()
}

/** Obliga. Se aplica sólo a las rutas que escriben. */
export const exigirSesion: MiddlewareHandler<Contexto> = async (c, siguiente) => {
  if (!c.get('usuario')) throw noAutenticado()
  await siguiente()
}

/** Atajo para las rutas: el usuario ya validado, sin comprobar de nuevo. */
export function usuarioDe(c: Context<Contexto>): Usuario {
  const u = c.get('usuario')
  if (!u) throw noAutenticado()
  return u
}

async function leerUsuario(c: Context<Contexto>): Promise<Usuario | undefined> {
  // Puerta trasera SÓLO de desarrollo, para poder probar la API sin montar
  // un proyecto en Google Cloud. Si MODO_DEV no vale "1", esto no existe.
  if (esDev(c.env)) {
    const dev = c.req.header('X-Usuario-Dev')
    if (dev) return { id: `dev:${dev}`, nombre: dev }
  }

  const token = getCookie(c, COOKIE_SESION) ?? tokenDeCabecera(c)
  if (!token) return undefined

  try {
    const carga = (await verify(token, exigirSecreto(c.env), 'HS256')) as unknown as Carga
    if (!carga?.sub) return undefined
    return { id: carga.sub, nombre: carga.nombre, email: carga.email, foto: carga.foto }
  } catch {
    // Token caducado o manipulado: se trata como "sin sesión", no como error.
    return undefined
  }
}

/** Para la app móvil del futuro, que no usará cookies. */
function tokenDeCabecera(c: Context<Contexto>) {
  const cabecera = c.req.header('Authorization')
  if (!cabecera?.startsWith('Bearer ')) return undefined
  return cabecera.slice(7).trim() || undefined
}

export function esDev(env: Env) {
  return env.MODO_DEV === '1'
}

function exigirSecreto(env: Env) {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error(
      'JWT_SECRET falta o es demasiado corto (mínimo 32 caracteres). Genera uno: openssl rand -base64 48',
    )
  }
  return env.JWT_SECRET
}
