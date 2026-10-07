# SIEGE-LITE dedicated server. Self-contained: builds the game inside Docker,
# so Render/Railway/Fly can deploy straight from git (no local dist needed).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build && npm run build-server

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server-dist/lan.mjs"]
