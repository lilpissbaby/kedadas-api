# API de fiestas

Hono sobre Cloudflare Workers **o en Docker**, MongoDB Atlas, sesión propia con Google.
El mismo código corre en los dos sitios (ver *Desplegar con Docker*).

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
| POST | `/api/imagenes` | con sesión — subir foto (ver *Imágenes*) |
| GET | `/api/imagenes/:id` | público — `:id` o `:id-mini` |
| GET | `/api/usuarios/yo` | con sesión — mi ficha con contadores |
| GET | `/api/usuarios/:id` | público — perfil del organizador, sin email |
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

## Documentación ejecutable

En `postman/` tienes la API entera documentada y lista para lanzar:

| Fichero | Para qué |
|---|---|
| `fiestas.postman_collection.json` | 30 peticiones en 7 carpetas, con descripción cada una |
| `fiestas.local.postman_environment.json` | apunta a `localhost:8787` |
| `fiestas.produccion.postman_environment.json` | cambia `baseUrl` por tu dominio y ya |
| `fiestas.http` | lo mismo sin Postman, para la extensión REST Client de VS Code |

En Postman: *Import* → arrastra los tres `.json` → arriba a la derecha elige el
entorno **Fiestas · local**.

Tres cosas que hacen que no tengas que copiar ids a mano:

- **`eventoId` se rellena sola.** Al crear un evento o consultar el mapa, un
  script guarda el id en la variable, así que las peticiones siguientes ya
  apuntan al evento correcto.
- **Las fechas nunca caducan.** `enUnaHora` y `enSeisHoras` se calculan antes de
  cada petición, así que los ejemplos siguen siendo válidos dentro de un año.
- **La carpeta `6 · Permisos` está para fallar.** Espera 401, 403, 400 y 404. Si
  alguna de esas peticiones sale bien, tenéis un agujero. Lánzala entera con el
  Runner después de cada cambio en la autorización.

Mira la cabecera `X-Db-Conexion-Ms` en cualquier respuesta que toque la base.

## Usuarios

No hay pantalla de registro: **entrar es registrarse**. La primera vez que
alguien entra con Google se crea su ficha en la colección `usuarios`; las
siguientes sólo se actualiza. El `usuarioId` es la misma cadena que va en el
token (`google:123...` o `dev:ana`) y es la que enlaza con `creadoPor`.

Para montar el frontend sin depender de Google, con `MODO_DEV="1"`:

```bash
# crea el usuario Y deja la cookie puesta: el navegador queda dentro
curl -X POST http://localhost:8787/api/usuarios/dev \
  -H "Content-Type: application/json" -d '{"nombre":"ana"}' -c cookies.txt

curl http://localhost:8787/api/usuarios/dev/lista     # ver los que hay
curl -X DELETE http://localhost:8787/api/usuarios/dev/ana   # borrarlo con todo lo suyo
```

Desde el navegador basta con `fetch('/api/usuarios/dev', {method:'POST',
credentials:'include', body: JSON.stringify({nombre:'ana'})})` y ya estás
dentro, con la misma cookie que pondría Google.

**Estas rutas devuelven 404 con `MODO_DEV` apagado**, como si no existieran.

El perfil público (`GET /api/usuarios/:id`) **nunca incluye el email**: es de
otra persona. El tuyo (`/api/usuarios/yo`) sí, porque es tuyo.

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

## Desplegar con Docker (homelab)

La alternativa al Worker: la misma API en un contenedor Node, junto a kedada
en el VPS. No se toca nada de `src/`; `node/servidor.ts` le da a Hono lo que
en Cloudflare le da el Worker:

| En Cloudflare | En Docker |
|---|---|
| `wrangler secret` / `.dev.vars` | `.env` |
| KV `CACHE` | en memoria (se vacía al reiniciar; vale para 1 réplica) |
| R2 `IMAGENES` | disco, volumen `api_fiestas_imagenes` |
| una conexión a Mongo por petición | pool compartido (`MONGO_POOL`), sin coste de conexión |

```bash
cp .env.example .env                 # MONGODB_URI, JWT_SECRET, ORIGEN_WEB, Google
docker compose up -d --build
docker compose run --rm api-fiestas node scripts/indices.mjs    # UNA vez por base
docker compose logs -f api-fiestas
```

Y en kedada, en su `.env`:

```bash
API_UPSTREAM=api-fiestas:8787
API_ESQUEMA=http
```

Cómo queda:

- **Sin puertos publicados.** Está en `proxy_network`, como el resto del
  homelab, y sólo le habla el nginx de kedada. No hace falta `.conf` en el
  reverse proxy: el subdominio sigue siendo el de kedada.
- **Contenedor endurecido:** usuario `node`, sistema de ficheros de sólo
  lectura (salvo el volumen de imágenes y `/tmp`), sin capabilities,
  `no-new-privileges`, 256 MB de tope y healthcheck contra `/api/salud`.
- **IP de los límites:** la API reescribe `CF-Connecting-IP` con la IP que
  pone nginx, para que nadie se salte el límite mandándola a mano.
- **Atlas con IP fija.** A diferencia del Worker, aquí sabéis desde qué IP se
  conecta: en *Network Access* quitad `0.0.0.0/0` y dejad sólo la del VPS.
- **Copias de seguridad:** el volumen `api_fiestas_imagenes` (las fotos). La
  base, si es Atlas, ya la tiene Atlas.
- `GOOGLE_REDIRECT_URI` es obligatoria (la API ve el host interno, no el
  dominio público). Registra la misma URL en Google Cloud Console.

**Mongo en el propio VPS** (opcional, en lugar de Atlas):

```bash
docker compose --profile mongo-local up -d --build
# .env:  MONGODB_URI=mongodb://mongo:27017
```

Va en una red interna sin salida ni puertos: sólo lo ve la API. Las copias de
la base pasan a ser cosa vuestra.

Sin Docker, para probar el mismo servidor en local: `npm run construir` y
`npm start` (con las variables en el entorno, no en `.dev.vars`).

## Opcional: límites y caché

Sin configurar nada, la API funciona pero **sin límite de peticiones y sin
caché**. Para activarlos:

```bash
npx wrangler kv namespace create CACHE
```

Pega el id en `wrangler.jsonc` (está el bloque comentado). A partir de ahí:
crear evento queda limitado a 10/hora por usuario, y la consulta del mapa se
cachea 45 s para visitantes anónimos.

## Opcional: imágenes de los eventos

Sin configurar nada, los eventos llevan el emoji de su tipo y `POST
/api/imagenes` responde 501. Para activar las fotos:

```bash
npx wrangler r2 bucket create fiestas-imagenes
```

y descomenta el bloque `r2_buckets` de `wrangler.jsonc`. En local, `wrangler
dev` simula el bucket solo en cuanto el bloque está descomentado. R2 da 10 GB
gratis y no cobra por la descarga.

Cómo funciona:

1. El cliente sube `multipart/form-data` con dos campos, `grande` (lado mayor
   1080 px, hasta 1,5 MB) y `mini` (160×160, hasta 100 KB). El redimensionado
   lo hace el navegador: en Workers no hay librería de imagen gratis, y así el
   mapa descarga miniaturas de ~6 KB y no fotos enteras.
2. La API responde `{ id, imagen: { grande, mini } }`.
3. Ese `id` se manda como `imagen` al crear o editar el evento (`null` en un
   PATCH vuelve al emoji). Los eventos devuelven `imagen: { grande, mini }` o `null`.

Lo que se comprueba, porque el cliente puede mentir:

- **Los bytes**, no el Content-Type: sólo WebP o JPEG de verdad.
- **Que no haya EXIF ni XMP.** Una foto de móvil trae el GPS de donde se hizo,
  y en una app de fiestas eso suele ser la casa de alguien. El frontend los
  quita al recodificar; si alguien sube directo a la API con metadatos, 400.
- **Que la imagen sea tuya** al enlazarla a un evento (el uploader va en los
  metadatos del objeto en R2). Si no, podrías usar la foto de otro y borrársela.
- **Limpieza:** cambiar o quitar la foto, borrar el evento o borrar la cuenta
  borra también los objetos de R2.

Las imágenes se sirven con `Cache-Control: immutable` (cambiar la foto crea
otro id), y el nginx del frontend las cachea: cada imagen llega al Worker una
sola vez aunque la vean mil personas.

Queda por hacer: una subida que nunca llega a enlazarse a un evento (alguien
elige foto y cierra) se queda huérfana. Cuesta céntimos; cuando moleste, una
regla de ciclo de vida en R2 o un cron que borre lo no enlazado.

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
    usuarios.ts         alta al entrar (upsert) y perfiles
    auth.ts             sesión JWT en cookie + middlewares
    errores.ts          un solo formato de error para toda la API
    limites.ts          límite de peticiones y caché (opcionales, vía KV)
    imagenes.ts         validación de bytes, EXIF, propiedad y borrado en R2
  rutas/
    usuarios.ts         perfiles, y creación de usuarios de prueba
    eventos.ts          CRUD + denuncias
    suscripciones.ts    apuntarse, desapuntarse, mis fiestas
    sesion.ts           Google OAuth con PKCE, y login de desarrollo
    imagenes.ts         subir y servir imágenes (opcional, vía R2)
scripts/
  indices.mjs           crea los índices (ejecutar una vez por base)
  seed.mjs              500 fiestas falsas para tener algo en el mapa
  probar.mjs            recorre la API y comprueba permisos
  bench-node.mjs        latencia a Atlas con y sin pool
node/
  servidor.ts           la API como proceso Node (Docker)
  kv-memoria.ts         sustituto del KV CACHE
  r2-disco.ts           sustituto del bucket R2 IMAGENES, en disco
  construir.mjs         compila src/ y node/ a dist/
Dockerfile · docker-compose.yml · .env.example
postman/
  fiestas.postman_collection.json     la API documentada y ejecutable
  fiestas.*.postman_environment.json  local y producción
  fiestas.http                        lo mismo para VS Code REST Client
```

## Lo siguiente

1. El frontend: HTML + JS vanilla con MapLibre o Leaflet contra `/api/eventos`.
2. Subir el umbral de denuncias y montaros una pantalla mínima de moderación.
3. Mirar `X-Db-Conexion-Ms` en producción y decidir si hace falta caché o
   Durable Object.
4. Reglas de Rate Limiting en el panel de Cloudflare (gratis, y paran el tráfico
   antes de que llegue al Worker).
