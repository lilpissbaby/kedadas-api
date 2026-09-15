import type { KVNamespace } from '@cloudflare/workers-types'

/** Todo lo que el Worker recibe de fuera. Nada de esto se escribe en el código. */
export type Env = {
  // --- obligatorio ---
  MONGODB_URI: string
  JWT_SECRET: string

  // --- opcional ---
  DB_NAME?: string
  ORIGEN_WEB?: string // dominio del frontend, para CORS y redirecciones. Ej: https://fiestas.app

  // Login con Google. Si faltan, la API arranca igual pero /api/sesion/google responde 501.
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // Sólo si la URL de vuelta no coincide con el dominio del Worker (proxy, dominio propio).
  GOOGLE_REDIRECT_URI?: string

  // Sólo para desarrollo: permite la cabecera X-Usuario-Dev y salta Google.
  // NUNCA lo pongas en producción.
  MODO_DEV?: string

  // Opcional: si existe, se usa para límites de peticiones y caché del mapa.
  // Sin él la API funciona igual, sólo que sin límite ni caché.
  CACHE?: KVNamespace
}

export type Usuario = {
  id: string // "google:1234567890" o "dev:mupsim"
  nombre?: string
  email?: string
  foto?: string
}

/** Lo que las rutas pueden leer del contexto una vez pasado el middleware. */
export type Variables = {
  usuario?: Usuario
  tiempoDb?: number
}

export type Contexto = { Bindings: Env; Variables: Variables }
