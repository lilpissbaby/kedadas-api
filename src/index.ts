import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { sesionOpcional, esDev } from './lib/auth'
import { manejarError } from './lib/errores'
import { eventos } from './rutas/eventos'
import { suscripciones, mias } from './rutas/suscripciones'
import { sesion } from './rutas/sesion'
import { usuarios } from './rutas/usuarios'
import type { Contexto } from './tipos'

const app = new Hono<Contexto>()

app.onError(manejarError)

app.notFound((c) =>
  c.json({ error: { codigo: 'no_encontrado', mensaje: `No hay nada en ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404),
)

app.use('*', secureHeaders())

/**
 * CORS cerrado al dominio del frontend. En desarrollo se abre, porque el
 * frontend estará en otro puerto.
 *
 * `credentials: true` es obligatorio: la sesión viaja en cookie, y sin esto el
 * navegador no la manda. Y por eso mismo el origen NO puede ser "*" en
 * producción — el navegador lo rechaza y, aunque no lo hiciera, sería regalar
 * la sesión a cualquier web.
 */
app.use('/api/*', async (c, siguiente) => {
  const permitidos = esDev(c.env)
    ? ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8788', 'http://127.0.0.1:5500']
    : [c.env.ORIGEN_WEB].filter((o): o is string => Boolean(o))

  return cors({
    origin: (origen) => (permitidos.includes(origen) ? origen : permitidos[0] ?? ''),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', ...(esDev(c.env) ? ['X-Usuario-Dev'] : [])],
    maxAge: 86_400,
  })(c, siguiente)
})

// Lee la sesión si la hay. No obliga: las rutas que escriben ya exigen por su cuenta.
app.use('/api/*', sesionOpcional)

/* ---------------- rutas ---------------- */

app.route('/api/sesion', sesion)
app.route('/api/usuarios', usuarios)
app.route('/api/eventos', eventos)
app.route('/api/eventos', suscripciones) // /:id/suscripcion
app.route('/api/yo', mias)

/* ---------------- salud ---------------- */

app.get('/api/salud', (c) =>
  c.json({
    ok: true,
    modoDev: esDev(c.env),
    loginGoogle: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    cache: Boolean(c.env.CACHE),
    hora: new Date().toISOString(),
  }),
)

app.get('/api', (c) =>
  c.json({
    api: 'fiestas',
    rutas: {
      'GET    /api/eventos?lng=&lat=&r=&tipo=': 'las burbujas del mapa (público)',
      'GET    /api/eventos/:id': 'ficha del evento (público)',
      'POST   /api/eventos': 'crear (sesión)',
      'PATCH  /api/eventos/:id': 'editar (sólo el creador)',
      'DELETE /api/eventos/:id': 'borrar (sólo el creador)',
      'POST   /api/eventos/:id/suscripcion': 'apuntarse (sesión)',
      'DELETE /api/eventos/:id/suscripcion': 'desapuntarse (sesión)',
      'POST   /api/eventos/:id/denuncia': 'denunciar (sesión)',
      'GET    /api/yo/suscripciones': 'mis fiestas (sesión)',
      'GET    /api/yo/eventos': 'los que he creado (sesión)',
      'GET    /api/usuarios/yo': 'mi ficha con contadores (sesión)',
      'GET    /api/usuarios/:id': 'perfil público de un organizador',
      'GET    /api/sesion/google': 'empezar login con Google',
      'GET    /api/sesion/yo': 'quién soy',
      'POST   /api/sesion/salir': 'cerrar sesión',
      'DELETE /api/sesion/yo': 'borrar mi cuenta y todo lo mío',
    },
    soloDesarrollo: esDev(c.env)
      ? {
          'POST   /api/sesion/dev': 'entrar como {"nombre":"ana"} sin Google',
          'POST   /api/usuarios/dev': 'crear usuario de prueba y entrar con él',
          'GET    /api/usuarios/dev/lista': 'ver los usuarios de prueba',
          'DELETE /api/usuarios/dev/:nombre': 'borrar un usuario de prueba y todo lo suyo',
          'cabecera X-Usuario-Dev: ana': 'identificarse en una sola petición, sin cookie',
        }
      : 'MODO_DEV apagado: las rutas de desarrollo no existen',
  }),
)

export default app
