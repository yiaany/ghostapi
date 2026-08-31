FROM oven/bun:1.3.14-alpine AS bun

FROM node:24.6.0-alpine3.22 AS build
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
RUN bun --version && npm run typecheck && npm test && npm run build && npm prune --omit=dev --ignore-scripts

FROM oven/bun:1.3.14-alpine AS runtime
RUN apk upgrade --no-cache libcrypto3 libssl3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/healthz');if(!r.ok)process.exit(1)"]
CMD ["bun", "dist/server.js"]
