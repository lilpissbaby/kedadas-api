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
 *
 * Lo segundo ya está: con Docker (node/servidor.ts) se usa el pool compartido
 * de más abajo. El Worker sigue abriendo una conexión por invocación.
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
  imagen?: string // id en R2 (ver lib/imagenes.ts)
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

/**
 * Pool compartido, SÓLO fuera de Workers (contenedor Node, ver node/servidor.ts,
 * que pone MONGO_POOL="1"). En un proceso que vive, abrir conexión en cada
 * petición es tirar 100-300 ms; aquí se abre una vez y se reutiliza.
 * En el Worker MONGO_POOL no existe y esta variable nunca se usa.
 */
let clienteCompartido: Promise<MongoClient> | undefined

function poolCompartido(uri: string) {
  if (!clienteCompartido) {
    const cliente = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000, maxPoolSize: 20 })
    clienteCompartido = cliente.connect().catch((err) => {
      clienteCompartido = undefined // que la próxima petición vuelva a intentarlo
      throw err
    })
  }
  return clienteCompartido
}

/** Cierra el pool al apagar el contenedor. En Workers no hace nada. */
export async function cerrarPool() {
  const pendiente = clienteCompartido
  clienteCompartido = undefined
  if (pendiente) await (await pendiente.catch(() => undefined))?.close().catch(() => {})
}

function envolver(cliente: MongoClient, env: Env, msConexion: number, cerrar: () => Promise<void>): ConexionDb {
  const db = cliente.db(env.DB_NAME ?? 'fiestas')
  return {
    db,
    col: {
      eventos: db.collection<Evento>('eventos'),
      usuarios: db.collection<UsuarioDoc>('usuarios'),
      suscripciones: db.collection<Suscripcion>('suscripciones'),
      denuncias: db.collection<Denuncia>('denuncias'),
    },
    cerrar,
    msConexion,
  }
}

export async function conectar(env: Env): Promise<ConexionDb> {
  if (!env.MONGODB_URI) {
    throw new Error('Falta MONGODB_URI. En local va en .dev.vars; desplegado, con wrangler secret put (o en .env con Docker).')
  }

  const t0 = Date.now()

  if (env.MONGO_POOL === '1') {
    const cliente = await poolCompartido(env.MONGODB_URI)
    // cerrar no hace nada: la conexión vuelve al pool y la reutiliza la siguiente petición.
    return envolver(cliente, env, Date.now() - t0, async () => {})
  }

  const cliente = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8_000,
    maxPoolSize: 1, // el pool no sobrevive a la invocación: pedir más no sirve de nada
  })

  await cliente.connect()
  return envolver(cliente, env, Date.now() - t0, () => cliente.close().catch(() => {}))
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
