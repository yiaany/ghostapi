FROM oven/bun:1.3.14-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN bun install --production
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/server.ts"]
