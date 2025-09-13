# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# System deps and global tooling
RUN apk add --no-cache su-exec wget sqlite ca-certificates pv bc bash curl rclone zstd && update-ca-certificates \
  && npm i -g pnpm@9 tsx@4

# Workspace manifests (speeds up install caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/usda-api/package.json apps/usda-api/package.json
COPY packages/usda-schemas/package.json packages/usda-schemas/package.json

# Install dependencies (including devDeps for tsx)
RUN pnpm install --frozen-lockfile

# Bring in source
COPY apps/usda-api/ apps/usda-api/
COPY packages/ packages/

# Make download script executable
RUN chmod +x apps/usda-api/src/download-database.sh

# Ensure workspace links are correct for the app package
RUN pnpm --filter @recipehub/usda-api install --frozen-lockfile

# Create non-root user
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && chown -R nodejs:nodejs /app

WORKDIR /app/apps/usda-api

ENTRYPOINT ["tsx", "src/docker-entrypoint.ts"]
CMD ["pnpm", "start"]
EXPOSE 8080
ENV NODE_ENV=production
