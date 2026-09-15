import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Un solo formato de error para toda la API. El cliente siempre recibe
 * { error: { codigo, mensaje, detalles? } } y nunca una traza interna.
 */

export type CodigoError =
  | 'peticion_invalida'
  | 'no_autenticado'
  | 'sin_permiso'
  | 'no_encontrado'
  | 'conflicto'
  | 'demasiadas_peticiones'
  | 'no_configurado'
  | 'error_interno'

const ESTADOS: Record<CodigoError, number> = {
  peticion_invalida: 400,
  no_autenticado: 401,
  sin_permiso: 403,
  no_encontrado: 404,
  conflicto: 409,
  demasiadas_peticiones: 429,
  no_configurado: 501,
  error_interno: 500,
}

export class ErrorApi extends HTTPException {
  codigo: CodigoError
  detalles?: unknown

  constructor(codigo: CodigoError, mensaje: string, detalles?: unknown) {
    super(ESTADOS[codigo] as never, { message: mensaje })
    this.codigo = codigo
    this.detalles = detalles
  }
}

export const invalida = (m: string, d?: unknown) => new ErrorApi('peticion_invalida', m, d)
export const noAutenticado = (m = 'Necesitas iniciar sesión') => new ErrorApi('no_autenticado', m)
export const sinPermiso = (m = 'Este evento no es tuyo') => new ErrorApi('sin_permiso', m)
export const noEncontrado = (m = 'No existe') => new ErrorApi('no_encontrado', m)
export const conflicto = (m: string) => new ErrorApi('conflicto', m)

/** Manejador global. Se engancha con app.onError. */
export function manejarError(err: Error, c: Context) {
  if (err instanceof ErrorApi) {
    return c.json({ error: { codigo: err.codigo, mensaje: err.message, detalles: err.detalles } }, err.status)
  }

  if (err instanceof HTTPException) {
    return c.json({ error: { codigo: 'error_interno', mensaje: err.message } }, err.status)
  }

  // Cualquier otra cosa es un fallo nuestro: se registra entero, se devuelve genérico.
  console.error('Error no controlado:', err?.stack ?? err)
  return c.json(
    { error: { codigo: 'error_interno', mensaje: 'Algo ha fallado por nuestra parte' } },
    500,
  )
}
