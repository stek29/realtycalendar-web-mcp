# Hosted HTTP server only (D42): stdio users run Node from a checkout.
# dist/ and the prod dependencies are plain JS (no native modules), so one build on the runner serves every arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.source=https://github.com/stek29/realtycalendar-web-mcp \
      org.opencontainers.image.description="RealtyCalendar MCP server (hosted HTTP, OAuth)" \
      org.opencontainers.image.version=$VERSION
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
