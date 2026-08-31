# syntax=docker/dockerfile:1.7
# Build context is the repo root: docker compose -f deploy/docker-compose.yml build
#
# Stage 1 builds shared + web + server; stage 2 is a slim runtime with only
# production dependencies, running as the unprivileged `node` user.
# Debian slim (not Alpine) because argon2 and sharp want glibc. The flat
# renderer's text (M4, §10) resolves fonts through fontconfig: the runtime
# installs the fontconfig package and pins FONTCONFIG_PATH at the repo config
# (server/fontconfig), which registers exactly one font — the vendored
# shared/fonts/Inter-Regular.ttf — so librsvg draws the same glyphs the
# editor does. Removing these silently breaks text in flat renders.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- dependencies + build ---------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY extension/package.json extension/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @snapping-turtle/shared... \
      --filter @snapping-turtle/server... --filter @snapping-turtle/web...
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
RUN pnpm --filter @snapping-turtle/shared build \
 && pnpm --filter @snapping-turtle/web build \
 && pnpm --filter @snapping-turtle/server build

# ---- production node_modules -----------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter @snapping-turtle/shared... --filter @snapping-turtle/server...

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    # Deterministic font resolution for the flat renderer (§10); the cache
    # lands under XDG_CACHE_HOME because the container filesystem is
    # read-only apart from the /tmp tmpfs.
    FONTCONFIG_PATH=/app/server/fontconfig \
    PANGOCAIRO_BACKEND=fontconfig \
    XDG_CACHE_HOME=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=prod-deps --chown=node:node /app/shared/node_modules ./shared/node_modules
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/shared/fonts ./shared/fonts
COPY --from=build --chown=node:node /app/server/fontconfig ./server/fontconfig
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/drizzle ./server/drizzle
COPY --from=build --chown=node:node /app/web/dist ./web/dist
RUN mkdir -p /data/images && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/start.js"]
