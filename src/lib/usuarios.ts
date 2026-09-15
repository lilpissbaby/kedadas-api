import type { Colecciones, UsuarioDoc } from './db'
import type { Usuario } from '../tipos'

/**
 * La ficha del usuario se guarda al entrar, no al registrarse: no hay
 * "registro" que hacer. La primera vez que alguien entra con Google se crea su
 * fila; las siguientes sólo se actualiza la fecha y los datos que Google haya
 * cambiado. Un upsert y se acabó.
 */
export async function guardarAlEntrar(
  col: Colecciones,
  usuario: Usuario,
  proveedor: 'google' | 'dev',
): Promise<void> {
  const ahora = new Date()

  await col.usuarios.updateOne(
    { usuarioId: usuario.id },
    {
      $set: {
        nombre: usuario.nombre ?? usuario.id.split(':')[1] ?? 'Sin nombre',
        ...(usuario.email ? { email: usuario.email } : {}),
        ...(usuario.foto ? { foto: usuario.foto } : {}),
        proveedor,
        ultimaEntrada: ahora,
      },
      // creadoEn sólo se escribe la primera vez: si fuera $set, cada login
      // falsearía la antigüedad de la cuenta.
      $setOnInsert: { usuarioId: usuario.id, creadoEn: ahora },
    } as never,
    { upsert: true },
  )
}

/** Lo que se puede enseñar de otra persona. El email NO está, a propósito. */
export function perfilPublico(doc: UsuarioDoc) {
  return {
    id: doc.usuarioId,
    nombre: doc.nombre,
    foto: doc.foto ?? null,
    desde: doc.creadoEn,
  }
}

/** Perfil de uno mismo: aquí sí va el email, porque es suyo. */
export function perfilPropio(doc: UsuarioDoc) {
  return { ...perfilPublico(doc), email: doc.email ?? null, proveedor: doc.proveedor }
}

/**
 * Busca varios de golpe y devuelve un mapa id -> perfil, para no hacer una
 * consulta por evento al pintar una lista.
 */
export async function perfilesDe(col: Colecciones, ids: string[]) {
  const unicos = [...new Set(ids)].filter(Boolean)
  if (unicos.length === 0) return new Map<string, ReturnType<typeof perfilPublico>>()

  const docs = await col.usuarios.find({ usuarioId: { $in: unicos } }).toArray()
  return new Map(docs.map((d) => [d.usuarioId, perfilPublico(d)]))
}
