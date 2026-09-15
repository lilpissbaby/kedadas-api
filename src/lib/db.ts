import { MongoClient, type Collection, type Db } from 'mongodb'
import type { Env } from '../tipos'

/**
 * Una conexión por invocación. No es una elección de estilo: en Workers el
 * contexto de I/O muere con la petición, así que un cliente a nivel de módulo
 * revienta en la segunda llamada. No lo "optimices" sacándolo de aquí.
 *
 * Todo el coste de conexión está concentrado en esta función. Si algún día
 * medís que es demasiado, es el ÚNICO sitio que hay que cambiar: un Durable
 * Object que mantenga la conexión, o desplegar en un contenedor con pool.
 */

export type Evento = {
  _id?: unknown
  titulo: string
  descripcion?: string
  tipo: string
  loc: { type: 'Point'; coordinates: [number, number] } // [lng, lat], longitud primero
  empiezaEn: Date
  terminaEn: Date
  creadoPor: string
  cancionUrl?: string
  suscritos: number
  denuncias?: number
  oculto?: boolean
  creadoEn: Date
  actualizadoEn?: Date
}

/**
 * Ficha del usuario. Hasta ahora el usuario sólo existía dentro del token, que
 * basta para autorizar pero no para enseñar "organizado por Ana" en el mapa ni
 * para saber cuánta gente hay. `usuarioId` es la misma cadena que va en el
 * token ("google:123..." o "dev:ana"), y es la que enlaza con creadoPor.
 */
export type UsuarioDoc = {
  _id?: unknown
  usuarioId: string
  nombre: string
  email?: string // nunca sale en respuestas públicas
  foto?: string
  proveedor: 'google' | 'dev'
  creadoEn: Date
  ultimaEntrada: Date
}

export type Suscripcion = {
  eventoId: string
  usuarioId: string
  creadaEn: Date
}

export type Denuncia = {
  eventoId: string
  usuarioId: string
  motivo: string
  creadaEn: Date
}

export type Colecciones = {
  eventos: Collection<Evento>
  usuarios: Collection<UsuarioDoc>
  suscripciones: Collection<Suscripcion>
  denuncias: Collection<Denuncia>
}

export type ConexionDb = {
  db: Db
  col: Colecciones
  cerrar: () => Promise<void>
  msConexion: number
}

export async function conectar(env: Env): Promise<ConexionDb> {
  if (!env.MONGODB_URI) {
    throw new Error('Falta MONGODB_URI. En local va en .dev.vars; desplegado, con wrangler secret put.')
  }

  const t0 = Date.now()
  const cliente = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8_000,
    maxPoolSize: 1, // el pool no sobrevive a la invocación: pedir más no sirve de nada
  })

  await cliente.connect()
  const msConexion = Date.now() - t0
  const db = cliente.db(env.DB_NAME ?? 'fiestas')

  return {
    db,
    col: {
      eventos: db.collection<Evento>('eventos'),
      usuarios: db.collection<UsuarioDoc>('usuarios'),
      suscripciones: db.collection<Suscripcion>('suscripciones'),
      denuncias: db.collection<Denuncia>('denuncias'),
    },
    cerrar: () => cliente.close().catch(() => {}),
    msConexion,
  }
}

/**
 * Azúcar para no olvidar el cierre. Devuelve además los ms de conexión para
 * poder publicarlos en una cabecera y seguir midiendo en producción.
 */
export async function conDb<T>(env: Env, tarea: (c: ConexionDb) => Promise<T>): Promise<{ valor: T; msConexion: number }> {
  const conexion = await conectar(env)
  try {
    const valor = await tarea(conexion)
    return { valor, msConexion: conexion.msConexion }
  } finally {
    await conexion.cerrar()
  }
}
