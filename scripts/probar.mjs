/**
 * Recorre la API entera contra el servidor local y comprueba que cada ruta
 * hace lo que dice. Incluye las pruebas que de verdad importan: que un usuario
 * NO pueda editar ni borrar el evento de otro.
 *
 * Necesita `npm run dev` corriendo en otra terminal y MODO_DEV="1" en .dev.vars.
 *
 * Uso:  npm run probar
 *       node scripts/probar.mjs http://localhost:8787
 */

const BASE = process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8787'

let pasadas = 0
let fallos = 0

function comprobar(descripcion, condicion, extra = '') {
  if (condicion) {
    pasadas++
    console.log(`  ok   ${descripcion}`)
  } else {
    fallos++
    console.log(`  FALLO ${descripcion}${extra ? `  -> ${extra}` : ''}`)
  }
}

async function pedir(metodo, ruta, { usuario, cuerpo } = {}) {
  const cabeceras = {}
  if (usuario) cabeceras['X-Usuario-Dev'] = usuario
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json'

  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  })

  let datos = null
  const texto = await r.text()
  if (texto) {
    try {
      datos = JSON.parse(texto)
    } catch {
      datos = texto
    }
  }
  return { estado: r.status, datos, cabeceras: r.headers }
}

const MADRID = { lng: -3.7038, lat: 40.4168 }
const enUnaHora = new Date(Date.now() + 3_600_000).toISOString()
const enCincoHoras = new Date(Date.now() + 5 * 3_600_000).toISOString()

console.log(`Probando ${BASE}\n`)

/* ---------- 0. está vivo y en modo dev ---------- */
console.log('salud')
const salud = await pedir('GET', '/api/salud')
comprobar('responde', salud.estado === 200, `estado ${salud.estado}`)
if (salud.estado !== 200) {
  console.log('\nEl servidor no responde. ¿Tienes `npm run dev` corriendo?')
  process.exit(1)
}
comprobar('MODO_DEV encendido', salud.datos?.modoDev === true, 'pon MODO_DEV="1" en .dev.vars')
if (salud.datos?.modoDev !== true) process.exit(1)

/* ---------- 1. crear ---------- */
console.log('\ncrear evento')
const creado = await pedir('POST', '/api/eventos', {
  usuario: 'ana',
  cuerpo: {
    titulo: 'Verbena de prueba',
    tipo: 'particular',
    lng: MADRID.lng,
    lat: MADRID.lat,
    empiezaEn: enUnaHora,
    terminaEn: enCincoHoras,
    cancionUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  },
})
comprobar('devuelve 201', creado.estado === 201, `estado ${creado.estado} ${JSON.stringify(creado.datos)}`)
const idEvento = creado.datos?.evento?.id
comprobar('devuelve un id', Boolean(idEvento))
comprobar('el creador se toma del token, no del cuerpo', creado.datos?.evento?.esMio === true)

/* ---------- 2. validación ---------- */
console.log('\nvalidación')
const malo = await pedir('POST', '/api/eventos', {
  usuario: 'ana',
  cuerpo: { titulo: 'x', tipo: 'inventado', lng: 999, lat: 0, empiezaEn: enUnaHora, terminaEn: enUnaHora },
})
comprobar('rechaza datos malos con 400', malo.estado === 400, `estado ${malo.estado}`)
comprobar('dice qué campos fallan', Array.isArray(malo.datos?.error?.detalles) && malo.datos.error.detalles.length > 0)

const alReves = await pedir('POST', '/api/eventos', {
  usuario: 'ana',
  cuerpo: {
    titulo: 'Termina antes de empezar',
    tipo: 'bar',
    lng: MADRID.lng,
    lat: MADRID.lat,
    empiezaEn: enCincoHoras,
    terminaEn: enUnaHora,
  },
})
comprobar('rechaza que termine antes de empezar', alReves.estado === 400)

const cancionMala = await pedir('POST', '/api/eventos', {
  usuario: 'ana',
  cuerpo: {
    titulo: 'Canción de sitio raro',
    tipo: 'bar',
    lng: MADRID.lng,
    lat: MADRID.lat,
    empiezaEn: enUnaHora,
    terminaEn: enCincoHoras,
    cancionUrl: 'https://sitio-cualquiera.example/pista.mp3',
  },
})
comprobar('rechaza enlaces de música de cualquier sitio', cancionMala.estado === 400)

/* ---------- 3. el mapa ---------- */
console.log('\nconsulta del mapa')
const mapa = await pedir('GET', `/api/eventos?lng=${MADRID.lng}&lat=${MADRID.lat}&r=3000`)
comprobar('responde 200', mapa.estado === 200)
comprobar('encuentra el evento recién creado', mapa.datos?.eventos?.some((e) => e.id === idEvento))

const lejos = await pedir('GET', '/api/eventos?lng=2.1734&lat=41.3851&r=1000') // Barcelona
comprobar('no devuelve fiestas de otra ciudad', !lejos.datos?.eventos?.some((e) => e.id === idEvento))

const coordMala = await pedir('GET', '/api/eventos?lng=999&lat=999')
comprobar('rechaza coordenadas imposibles', coordMala.estado === 400)

/* ---------- 4. autorización por objeto ---------- */
console.log('\nautorización (lo que ningún hosting hace por ti)')
const editaOtro = await pedir('PATCH', `/api/eventos/${idEvento}`, {
  usuario: 'bruno',
  cuerpo: { titulo: 'Me apropio de tu fiesta' },
})
comprobar('bruno NO puede editar el evento de ana', editaOtro.estado === 403, `estado ${editaOtro.estado}`)

const borraOtro = await pedir('DELETE', `/api/eventos/${idEvento}`, { usuario: 'bruno' })
comprobar('bruno NO puede borrar el evento de ana', borraOtro.estado === 403, `estado ${borraOtro.estado}`)

const sinSesion = await pedir('POST', '/api/eventos', {
  cuerpo: { titulo: 'Sin sesión', tipo: 'bar', lng: 0, lat: 0, empiezaEn: enUnaHora, terminaEn: enCincoHoras },
})
comprobar('sin sesión no se puede crear', sinSesion.estado === 401, `estado ${sinSesion.estado}`)

const editaDueño = await pedir('PATCH', `/api/eventos/${idEvento}`, {
  usuario: 'ana',
  cuerpo: { titulo: 'Verbena de prueba (editada)' },
})
comprobar('ana SÍ puede editar lo suyo', editaDueño.estado === 200, `estado ${editaDueño.estado}`)
comprobar('el título cambió', editaDueño.datos?.evento?.titulo?.includes('editada'))

/* ---------- 5. suscripciones ---------- */
console.log('\nsuscripciones')
const sub1 = await pedir('POST', `/api/eventos/${idEvento}/suscripcion`, { usuario: 'bruno' })
comprobar('bruno se apunta', sub1.estado === 201, `estado ${sub1.estado} ${JSON.stringify(sub1.datos)}`)
comprobar('el contador sube a 1', sub1.datos?.suscritos === 1, `suscritos=${sub1.datos?.suscritos}`)

const sub2 = await pedir('POST', `/api/eventos/${idEvento}/suscripcion`, { usuario: 'bruno' })
comprobar('apuntarse dos veces no duplica', sub2.datos?.suscritos === 1, `suscritos=${sub2.datos?.suscritos}`)

const mias = await pedir('GET', '/api/yo/suscripciones', { usuario: 'bruno' })
comprobar('aparece en "mis fiestas"', mias.datos?.eventos?.some((e) => e.id === idEvento))

const noMias = await pedir('GET', '/api/yo/suscripciones', { usuario: 'ana' })
comprobar('no aparece en las de ana', !noMias.datos?.eventos?.some((e) => e.id === idEvento))

const desub = await pedir('DELETE', `/api/eventos/${idEvento}/suscripcion`, { usuario: 'bruno' })
comprobar('se desapunta', desub.estado === 200 && desub.datos?.suscritos === 0, `suscritos=${desub.datos?.suscritos}`)

/* ---------- 6. denuncias ---------- */
console.log('\ndenuncias')
const den1 = await pedir('POST', `/api/eventos/${idEvento}/denuncia`, {
  usuario: 'bruno',
  cuerpo: { motivo: 'spam' },
})
comprobar('se puede denunciar', den1.estado === 201, `estado ${den1.estado}`)

const den2 = await pedir('POST', `/api/eventos/${idEvento}/denuncia`, {
  usuario: 'bruno',
  cuerpo: { motivo: 'spam' },
})
comprobar('no se puede denunciar dos veces', den2.estado === 409, `estado ${den2.estado}`)

/* ---------- 7. sesión ---------- */
console.log('\nsesión')
const yo = await pedir('GET', '/api/sesion/yo', { usuario: 'ana' })
comprobar('/api/sesion/yo identifica al usuario', yo.datos?.usuario?.id === 'dev:ana')

const anonimo = await pedir('GET', '/api/sesion/yo')
comprobar('sin sesión devuelve usuario null', anonimo.datos?.usuario === null)

/* ---------- 7b. usuarios ---------- */
console.log('\nusuarios')
const creado1 = await pedir('POST', '/api/usuarios/dev', { cuerpo: { nombre: 'ana' } })
comprobar('se crea un usuario de prueba', creado1.estado === 201, `estado ${creado1.estado}`)
comprobar('devuelve el id con prefijo dev:', creado1.datos?.usuario?.id === 'dev:ana')
comprobar('deja la sesión iniciada', creado1.datos?.sesionIniciada === true)

const repetido = await pedir('POST', '/api/usuarios/dev', { cuerpo: { nombre: 'ana' } })
comprobar('crear el mismo dos veces no duplica', repetido.estado === 201)

const nombreMalo = await pedir('POST', '/api/usuarios/dev', { cuerpo: { nombre: 'a' } })
comprobar('rechaza nombres de un carácter', nombreMalo.estado === 400)

const lista = await pedir('GET', '/api/usuarios/dev/lista')
comprobar('los lista', Array.isArray(lista.datos?.usuarios) && lista.datos.usuarios.length > 0)

const publico = await pedir('GET', '/api/usuarios/dev:ana')
comprobar('el perfil público existe', publico.estado === 200, `estado ${publico.estado}`)
comprobar('el perfil público NO lleva email', publico.datos?.usuario?.email === undefined)

const ficha = await pedir('GET', '/api/usuarios/yo', { usuario: 'ana' })
comprobar('mi ficha trae contadores', typeof ficha.datos?.eventosCreados === 'number')

const noExiste = await pedir('GET', '/api/usuarios/dev:nadie_con_este_nombre')
comprobar('un usuario inexistente da 404', noExiste.estado === 404)

const conOrganizador = await pedir('GET', `/api/eventos/${idEvento}`, { usuario: 'bruno' })
comprobar('la ficha del evento trae el organizador', conOrganizador.datos?.organizador?.id === 'dev:ana')
comprobar('y dice si estoy apuntado', typeof conOrganizador.datos?.estoyApuntado === 'boolean')

/* ---------- 8. limpieza ---------- */
console.log('\nlimpieza')
const borrado = await pedir('DELETE', `/api/eventos/${idEvento}`, { usuario: 'ana' })
comprobar('el dueño borra lo suyo', borrado.estado === 204, `estado ${borrado.estado}`)

const yaNo = await pedir('GET', `/api/eventos/${idEvento}`)
comprobar('ya no existe', yaNo.estado === 404, `estado ${yaNo.estado}`)

const inventado = await pedir('GET', '/api/eventos/noesunid')
comprobar('un id con formato raro da 404, no un error feo', inventado.estado === 404)

// Los usuarios de prueba que ha creado este script se van con lo suyo detrás,
// para no dejar basura en la base entre ejecuciones.
for (const nombre of ['ana', 'bruno']) {
  const limpiado = await pedir('DELETE', `/api/usuarios/dev/${nombre}`)
  comprobar(`se limpia el usuario de prueba ${nombre}`, limpiado.estado === 200)
}

/* ---------- resultado ---------- */
console.log(`\n${'-'.repeat(50)}`)
console.log(`${pasadas} bien, ${fallos} mal`)
if (fallos > 0) {
  console.log('\nAlgo no cuadra. No sigas hasta arreglarlo.')
  process.exit(1)
}
console.log('La API hace lo que dice.')
