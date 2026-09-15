# API de fiestas

Hono sobre Cloudflare Workers, MongoDB Atlas, sesión propia con Google.
Sin servidor que administrar y sin framework en el frontend.

## Arrancar

```bash
npm install
cp .dev.vars.example .dev.vars      # rellena MONGODB_URI y JWT_SECRET
npm run secreto                     # genera un JWT_SECRET decente
npm run indices                     # UNA vez por base de datos
npm run seed                        # opcional: 500 fiestas falsas para probar
npm run dev
```

En otra terminal:

```bash
npm run probar
```

Eso recorre la API entera y comprueba, entre otras cosas, que un usuario no
pueda editar ni borrar el evento de otro. Si sale algo en rojo, no sigas.

> En PowerShell las variables van con `$env:MONGODB_URI = '...'`, no con
> `export`, y para llamar a la API usa `curl.exe`, no `curl` (que es un alias
> de `Invoke-WebRequest` y acepta otros argumentos).

## Rutas

| Método | Ruta | Quién |
|---|---|---|
| GET | `/api/eventos?lng=&lat=&r=&tipo=` | público — las burbujas del mapa |
| GET | `/api/eventos/:id` | público — la ficha con la canción |
| POST | `/api/eventos` | con sesión |
| PATCH | `/api/eventos/:id` | **sólo el creador** |
| DELETE | `/api/eventos/:id` | **sólo el creador** |
| POST | `/api/eventos/:id/suscripcion` | con sesión |
| DELETE | `/api/eventos/:id/suscripcion` | con sesión |
| POST | `/api/eventos/:id/denuncia` | con sesión |
| GET | `/api/yo/suscripciones` | con sesión |
| GET | `/api/yo/eventos` | con sesión |
| GET | `/api/sesion/google` | empieza el login |
| GET | `/api/sesion/yo` | quién soy |
| POST | `/api/sesion/salir` | cerrar sesión |
| DELETE | `/api/sesion/yo` | borrar mi cuenta y todo lo mío (RGPD) |

`GET /api` te devuelve esta misma lista, y `GET /api/salud` te dice qué hay
configurado en ese despliegue.

## Probar a mano sin montar Google

Con `MODO_DEV="1"` puedes identificarte con una cabecera:

```bash
curl -H "X-Usuario-Dev: ana" -H "Content-Type: application/json" \
  -d '{"titulo":"Verbena del barrio","tipo":"particular","lng":-3.7038,"lat":40.4168,
       "empiezaEn":"2026-09-20T22:00:00Z","terminaEn":"2026-09-21T04:00:00Z",
       "cancionUrl":"https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"}' \
  http://localhost:8787/api/eventos

curl "http://localhost:8787/api/eventos?lng=-3.7038&lat=40.4168&r=3000"
```

**`MODO_DEV` fuera de tu máquina es un agujero total**: cualquiera se hace pasar
por cualquiera con una cabecera. No lo pongas nunca como secreto en producción.

## Activar el login con Google

1. [console.cloud.google.com](https://console.cloud.google.com) → nuevo proyecto.
2. *APIs y servicios* → *Pantalla de consentimiento de OAuth* → tipo **Externo**.
3. *Credenciales* → *Crear credenciales* → **ID de cliente de OAuth** → *Aplicación web*.
4. En **URIs de redirección autorizados**, exactamente:
   - `http://localhost:8787/api/sesion/google/callback` (desarrollo)
   - `https://api-fiestas.TU-SUBDOMINIO.workers.dev/api/sesion/google/callback` (producción)
5. Copia el ID y el secreto a `.dev.vars`.

El flujo es código de autorización con PKCE y `state`, el secreto nunca sale del
Worker, y la sesión acaba en una cookie `httpOnly` — así un XSS en el frontend
no puede robarla.

**Instagram no está**, y no es un olvido: la Basic Display API se apagó el 4 de
diciembre de 2024 y su sustituta sólo admite cuentas profesionales. No sirve para
que entren usuarios normales. Como mucho, más adelante, para que un bar vincule
su perfil.

## Desplegar

```bash
npx wrangler secret put MONGODB_URI
npx wrangler secret put JWT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

Antes de desplegar, dos cosas obligatorias en `wrangler.jsonc`:

- **quitar `MODO_DEV`** de donde esté,
- poner `ORIGEN_WEB` con el dominio real del frontend, que es lo que cierra el CORS.

En un servidor sin escritorio, `wrangler login` no funciona porque abre un
navegador: usa `export CLOUDFLARE_API_TOKEN="..."`.

## Opcional: límites y caché

Sin configurar nada, la API funciona pero **sin límite de peticiones y sin
caché**. Para activarlos:

```bash
npx wrangler kv namespace create CACHE
```

Pega el id en `wrangler.jsonc` (está el bloque comentado). A partir de ahí:
crear evento queda limitado a 10/hora por usuario, y la consulta del mapa se
cachea 45 s para visitantes anónimos.

## Decisiones que vas a encontrar en el código

**La conexión a Mongo se abre en cada petición** (`src/lib/db.ts`). No es un
descuido: en Workers el contexto de I/O muere con la invocación y un cliente a
nivel de módulo revienta en la segunda llamada. Todo ese coste está concentrado
en una función, así que si algún día medís que es demasiado, es el único sitio
que hay que tocar — un Durable Object que mantenga la conexión viva, o mover el
Worker a un contenedor con pool. El resto del código no se entera.

Cada respuesta que toca la base lleva la cabecera `X-Db-Conexion-Ms`. Esa es la
medición que quedó pendiente; ahora la tenéis en producción sin hacer nada.

**`creadoPor` sale siempre del token, nunca del cuerpo** de la petición. Y cada
edición y cada borrado comprueba que el evento sea tuyo antes de tocarlo. Es el
fallo número uno de OWASP en APIs y no lo cubre ningún hosting.

**El índice único de `suscripciones` es una regla de negocio**, no una
optimización: es lo que impide apuntarse dos veces, y la API detecta el
duplicado por el error que lanza. Si no ejecutas `npm run indices`, eso deja de
funcionar en silencio.

**La denuncia está desde el día uno.** Un mapa público con fiestas de
particulares y manifestaciones lo necesita, y a las 5 denuncias el evento se
esconde solo hasta que lo reviséis. El umbral es provisional.

**La ubicación es un dato personal.** Se usa para la consulta y no se guarda:
no hay historial de posiciones de usuarios en ninguna colección, y `DELETE
/api/sesion/yo` borra todo lo de una persona. Eso es deliberado — lo que no
almacenas no te lo pueden filtrar ni reclamar.

## Estructura

```
src/
  index.ts              monta la app, CORS, rutas
  tipos.ts              qué variables espera el Worker
  esquemas.ts           validación con Zod (todo lo que entra pasa por aquí)
  lib/
    db.ts               conexión por invocación
    auth.ts             sesión JWT en cookie + middlewares
    errores.ts          un solo formato de error para toda la API
    limites.ts          límite de peticiones y caché (opcionales, vía KV)
  rutas/
    eventos.ts          CRUD + denuncias
    suscripciones.ts    apuntarse, desapuntarse, mis fiestas
    sesion.ts           Google OAuth con PKCE, y login de desarrollo
scripts/
  indices.mjs           crea los índices (ejecutar una vez por base)
  seed.mjs              500 fiestas falsas para tener algo en el mapa
  probar.mjs            recorre la API y comprueba permisos
  bench-node.mjs        latencia a Atlas con y sin pool
```

## Lo siguiente

1. El frontend: HTML + JS vanilla con MapLibre o Leaflet contra `/api/eventos`.
2. Subir el umbral de denuncias y montaros una pantalla mínima de moderación.
3. Mirar `X-Db-Conexion-Ms` en producción y decidir si hace falta caché o
   Durable Object.
4. Reglas de Rate Limiting en el panel de Cloudflare (gratis, y paran el tráfico
   antes de que llegue al Worker).
