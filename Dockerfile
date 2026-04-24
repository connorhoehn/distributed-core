# =============================================================================
# Dockerfile — distributed-core / cluster-collab reference image
#
# Multi-stage build: the builder compiles TypeScript so the runtime stage
# carries only compiled dist/ — no devDependencies or tsc toolchain.
# =============================================================================

# Stage 1 — builder: install all deps (incl. devDeps for tsc) and compile.
FROM node:20-alpine AS builder
WORKDIR /app
# lz4 and zstd-codec are native modules that require node-gyp, which needs
# Python and a C compiler. Install build tools here; they stay out of the
# runtime stage, keeping the final image lean.
RUN apk add --no-cache python3 make g++
# Copy manifests first: Docker cache skips npm ci unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2 — runtime
# Non-root user (node, uid=1000) ships in node:20-alpine. Running as root
# inside a container violates least-privilege and many CIS benchmarks.
FROM node:20-alpine AS runtime
WORKDIR /app
# Native modules (lz4, zstd-codec) need the same build tools at install time
# but not at runtime — their .node binaries are copied from the builder stage.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Remove build toolchain from the runtime image after npm ci completes.
RUN apk del python3 make g++

# Compiled library output from the builder stage.
COPY --from=builder /app/dist ./dist/

# cluster-collab sources copied as a reference. In your own service, replace
# this COPY with your compiled application and update CMD accordingly.
COPY examples/cluster-collab/ ./examples/cluster-collab/

USER node

# Override at runtime: docker run -e PORT=9090 ...
ENV PORT=8080
EXPOSE 8080

# HEALTHCHECK — your application must expose GET /health returning 200.
# Wire ForwardingServer or a plain http.createServer to handle this route.
# See docs/DEPLOYMENT.md §Probe configuration for wiring instructions.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Default CMD: minimal HTTP stub that responds to /health.
# Replace with your real entry point before deploying: CMD ["node", "dist/server.js"]
CMD ["node", "-e", "\
  const http = require('http'); \
  const port = process.env.PORT || 8080; \
  http.createServer((req, res) => { \
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); } \
    else { res.writeHead(200); res.end('distributed-core runtime image. Replace CMD with your application.'); } \
  }).listen(port, () => console.log('stub server on :' + port)); \
"]
