FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=America/Argentina/Buenos_Aires

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# La base de datos vive en /data: montá ahí un volumen persistente.
RUN apk add --no-cache tzdata && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
