# ======================================================================
# api-fiestas en un contenedor Node (la misma API que el Worker)
# ======================================================================

# --- 1. compilar TypeScript -> dist/ ---------------------------------
FROM node:22-alpine AS construir
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no descargar workerd ni sharp, que aquí no pintan nada.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY node ./node
RUN node node/construir.mjs

# --- 2. imagen final: sólo dependencias de producción -----------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PUERTO=8787 \
    IMAGENES_DIR=/datos/imagenes
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY --from=construir /app/dist ./dist
# Para `docker compose run --rm api-fiestas node scripts/indices.mjs` (y seed.mjs).
COPY scripts ./scripts

# El volumen hereda este dueño la primera vez que se crea.
RUN mkdir -p /datos/imagenes && chown node:node /datos/imagenes
USER node

EXPOSE 8787
CMD ["node", "dist/node/servidor.js"]
