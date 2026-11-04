FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY oauth-server.mjs compat.cjs ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
LABEL org.opencontainers.image.source="https://github.com/sistemabritto/evocrm-mcp"
# Padrão: HTTP com tokens estáticos (src/http.ts). Para OAuth 2.1 (Claude, ChatGPT/Codex, Grok) e módulos opcionais:
#   command: ["node", "--require", "/app/compat.cjs", "oauth-server.mjs"]
CMD ["npm", "run", "start:http"]
