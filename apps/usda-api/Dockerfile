# syntax=docker/dockerfile:1

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm globally
RUN npm i -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies including devDependencies for build
RUN pnpm install --frozen-lockfile

# Copy source code and config
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

# Build the application
RUN pnpm run build

# Production stage  
FROM node:20-alpine AS production

WORKDIR /app

# Install pnpm globally
RUN npm i -g pnpm@9 && apk add --no-cache su-exec wget gzip sqlite ca-certificates pv && update-ca-certificates

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create data directory and optionally copy database
RUN mkdir -p ./data

## Note: We do not bake the SQLite DB into the image (Strategy A).
## The DB is uploaded once to the Fly volume via `fly sftp` to keep image small.

## Create non-root user but keep running as root for entrypoint; entrypoint will drop privileges
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Entrypoint ensures /data ownership then execs as node user
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["pnpm", "start"]
EXPOSE 8080
ENV NODE_ENV=production
