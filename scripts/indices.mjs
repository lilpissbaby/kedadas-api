/**
 * Crea los índices. Ejecútalo UNA vez contra cada base (la tuya y la de
 * producción) y cada vez que añadas una consulta nueva.
 *
 * No se crean desde el Worker a propósito: crear un índice es una operación de
 * administración, lenta y bloqueante, y no tiene nada que hacer dentro de una
 * petición de usuario.
 *
 * Uso:  npm run indices      (con MONGODB_URI puesta)
 */

import { MongoClient } from 'mongodb'
import { leerUri, comprobarUri, tapar, explicarError } from './uri.mjs'

const URI = leerUri(process.argv[2])
const DB = process.env.DB_NAME ?? 'fiestas'
comprobarUri(URI)

const cliente = new MongoClient(URI)

try {
  console.log(`Conectando a ${tapar(URI)}`)
  await cliente.connect()
  const db = cliente.db(DB)

  // --- eventos ---
  // El 2dsphere es el que hace que "fiestas cerca de mí" no escanee la colección.
  await db.collection('eventos').createIndex({ loc: '2dsphere' }, { name: 'geo' })
  // Para descartar rápido lo que ya ha terminado.
  await db.collection('eventos').createIndex({ terminaEn: 1 }, { name: 'por_fin' })
  // Para "los eventos que he creado".
  await db.collection('eventos').createIndex({ creadoPor: 1, empiezaEn: -1 }, { name: 'por_creador' })
  console.log('eventos        -> geo (2dsphere), por_fin, por_creador')

  // --- suscripciones ---
  // Este índice ÚNICO no es una optimización: es la regla que impide
  // apuntarse dos veces a la misma fiesta. La API depende de que exista,
  // porque detecta el duplicado por el error 11000 que lanza.
  await db
    .collection('suscripciones')
    .createIndex({ eventoId: 1, usuarioId: 1 }, { unique: true, name: 'una_por_persona' })
  await db.collection('suscripciones').createIndex({ usuarioId: 1, creadaEn: -1 }, { name: 'mis_fiestas' })
  console.log('suscripciones  -> una_por_persona (ÚNICO), mis_fiestas')

  // --- denuncias ---
  await db
    .collection('denuncias')
    .createIndex({ eventoId: 1, usuarioId: 1 }, { unique: true, name: 'una_denuncia_por_persona' })
  console.log('denuncias      -> una_denuncia_por_persona (ÚNICO)')

  console.log('\nListo.')
} catch (err) {
  console.error('\nHa fallado:', err.message)
  console.error('->', explicarError(err))
  process.exitCode = 1
} finally {
  await cliente.close()
}
