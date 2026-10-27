# Build stage: the TypeScript toolchain and the compiler for better-sqlite3's
# native addon live here and never reach the runtime image.
FROM node:22-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Legacy peer resolution, as in bitsocial-indexer: React Native is only a peer
# of a browser/WebRTC dependency of pkc-js and is never used by this Node-only
# RPC client.
RUN npm ci --legacy-peer-deps

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --legacy-peer-deps

# Runtime stage: one node process on compiled JavaScript (see bitsocial-indexer's
# Dockerfile for why not tsx).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
# Inside the container the API must listen on all interfaces; publish the port
# on the host's loopback (see docker-compose.yml) unless the list is meant to be public.
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/discovery.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# ESM needs the package's "type": "module" next to dist/.
COPY package.json ./

EXPOSE 4100
CMD ["node", "dist/index.js"]
