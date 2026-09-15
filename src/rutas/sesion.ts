import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { crearSesion, cerrarSesion, esDev, usuarioDe, exigirSesion } from '../lib/auth'
import { conDb } from '../lib/db'
import { ErrorApi, invalida } from '../lib/errores'
import type { Contexto, Env, Usuario } from '../tipos'

/**
 * Login con Google, flujo de código de autorización con PKCE.
 *
 * Sin librerías de terceros a propósito: son ~120 líneas y así no dependéis de
 * un paquete de auth que suba de precio o cambie de API. El secreto de cliente
 * nunca sale del Worker, y el id_token llega por TLS directamente de Google en
 * el intercambio servidor-a-servidor, así que se puede leer sin verificar la
 * firma: nadie ha podido tocarlo por el camino.
 *
 * Instagram no está, y no es un olvido: la Basic Display API se apagó en
 * diciembre de 2024 y su sustituta sólo admite cuentas profesionales. No sirve
 * como login de usuarios normales.
 */

export const sesion = new Hono<Contexto>()

const COOKIE_ESTADO = 'oauth_estado'
const COOKIE_VERIFICADOR = 'oauth_verificador'
const AUTORIZAR = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'

/* ---------- utilidades de PKCE ---------- */

function base64url(datos: ArrayBuffer | Uint8Array) {
  const bytes = datos instanceof Uint8Array ? datos : new Uint8Array(datos)
  let binario = ''
  for (const b of bytes) binario += String.fromCharCode(b)
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function aleatorio(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function reto(verificador: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador))
  return base64url(hash)
}

function decodificarCarga(idToken: string): Record<string, unknown> {
  const partes = idToken.split('.')
  if (partes.length !== 3) throw new Error('id_token con formato raro')
  const relleno = '='.repeat((4 - (partes[1].length % 4)) % 4)
  const binario = atob(partes[1].replace(/-/g, '+').replace(/_/g, '/') + relleno)
  // atob da bytes sueltos: hay que decodificarlos como UTF-8 o los nombres con
  // acentos o eñes llegan rotos.
  const bytes = Uint8Array.from(binario, (ch) => ch.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function urlDeVuelta(c: { req: { url: string } }, env: Env) {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI
  return new URL('/api/sesion/google/callback', c.req.url).toString()
}

function destinoFinal(env: Env) {
  return env.ORIGEN_WEB ?? '/'
}

function exigirGoogle(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ErrorApi(
      'no_configurado',
      'El login con Google no está configurado en este despliegue. Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.',
    )
  }
  return { id: env.GOOGLE_CLIENT_ID, secreto: env.GOOGLE_CLIENT_SECRET }
}

/* ---------- 1. arrancar el login ---------- */

sesion.get('/google', async (c) => {
  const { id } = exigirGoogle(c.env)

  const estado = aleatorio(16)
  const verificador = aleatorio(32)

  const opciones = {
    httpOnly: true,
    secure: !esDev(c.env),
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: 600, // 10 minutos: sólo tiene que durar el viaje de ida y vuelta
  }
  setCookie(c, COOKIE_ESTADO, estado, opciones)
  setCookie(c, COOKIE_VERIFICADOR, verificador, opciones)

  const destino = new URL(AUTORIZAR)
  destino.searchParams.set('client_id', id)
  destino.searchParams.set('redirect_uri', urlDeVuelta(c, c.env))
  destino.searchParams.set('response_type', 'code')
  destino.searchParams.set('scope', 'openid email profile')
  destino.searchParams.set('state', estado)
  destino.searchParams.set('code_challenge', await reto(verificador))
  destino.searchParams.set('code_challenge_method', 'S256')
  destino.searchParams.set('prompt', 'select_account')

  return c.redirect(destino.toString(), 302)
})

/* ---------- 2. la vuelta de Google ---------- */

sesion.get('/google/callback', async (c) => {
  const { id, secreto } = exigirGoogle(c.env)

  const error = c.req.query('error')
  if (error) throw invalida(`Google ha rechazado el login: ${error}`)

  const codigo = c.req.query('code')
  const estadoRecibido = c.req.query('state')
  const estadoGuardado = getCookie(c, COOKIE_ESTADO)
  const verificador = getCookie(c, COOKIE_VERIFICADOR)

  // Sin esta comprobación, cualquiera puede hacerte iniciar sesión con SU
  // cuenta desde otra pestaña. Es el CSRF clásico del flujo OAuth.
  if (!codigo || !estadoRecibido || !estadoGuardado || estadoRecibido !== estadoGuardado) {
    throw invalida('El login ha caducado o no cuadra. Vuelve a empezar.')
  }
  if (!verificador) throw invalida('El login ha caducado. Vuelve a empezar.')

  deleteCookie(c, COOKIE_ESTADO, { path: '/' })
  deleteCookie(c, COOKIE_VERIFICADOR, { path: '/' })

  const respuesta = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: codigo,
      client_id: id,
      client_secret: secreto,
      redirect_uri: urlDeVuelta(c, c.env),
      grant_type: 'authorization_code',
      code_verifier: verificador,
    }),
  })

  if (!respuesta.ok) {
    console.error('Google token endpoint:', respuesta.status, await respuesta.text())
    throw invalida('Google no ha aceptado el intercambio. Revisa el redirect_uri registrado.')
  }

  const datos = (await respuesta.json()) as { id_token?: string }
  if (!datos.id_token) throw invalida('Google no ha devuelto id_token')

  const carga = decodificarCarga(datos.id_token)

  if (carga.aud !== id) throw invalida('El id_token no es para esta aplicación')
  if (typeof carga.exp === 'number' && carga.exp * 1000 < Date.now()) throw invalida('id_token caducado')
  if (!String(carga.iss ?? '').includes('accounts.google.com')) throw invalida('Emisor del id_token inesperado')
  if (carga.email_verified === false) throw invalida('Verifica tu correo en Google antes de entrar')

  const usuario: Usuario = {
    id: `google:${carga.sub}`,
    nombre: typeof carga.name === 'string' ? carga.name : undefined,
    email: typeof carga.email === 'string' ? carga.email : undefined,
    foto: typeof carga.picture === 'string' ? carga.picture : undefined,
  }

  await crearSesion(c, usuario)
  return c.redirect(destinoFinal(c.env), 302)
})

/* ---------- 3. quién soy ---------- */

sesion.get('/yo', (c) => {
  const usuario = c.get('usuario')
  if (!usuario) return c.json({ usuario: null })
  return c.json({ usuario })
})

/* ---------- 4. salir ---------- */

sesion.post('/salir', (c) => {
  cerrarSesion(c)
  return c.json({ ok: true })
})

/* ---------- 5. entrar sin Google, sólo en desarrollo ---------- */

sesion.post('/dev', async (c) => {
  if (!esDev(c.env)) throw new ErrorApi('no_encontrado', 'No existe')

  const cuerpo = (await c.req.json().catch(() => ({}))) as { nombre?: string }
  const nombre = (cuerpo.nombre ?? 'mupsim').trim().slice(0, 40) || 'mupsim'

  const usuario: Usuario = { id: `dev:${nombre}`, nombre }
  await crearSesion(c, usuario)
  return c.json({ usuario, aviso: 'Sesión de desarrollo. Esto no existe con MODO_DEV apagado.' })
})

/* ---------- 6. borrar mi cuenta (RGPD) ---------- */

sesion.delete('/yo', exigirSesion, async (c) => {
  const usuario = usuarioDe(c)

  await conDb(c.env, async ({ col }) => {
    await col.suscripciones.deleteMany({ usuarioId: usuario.id })
    await col.eventos.deleteMany({ creadoPor: usuario.id })
    await col.denuncias.deleteMany({ usuarioId: usuario.id })
  })

  cerrarSesion(c)
  return c.json({ borrado: true })
})
