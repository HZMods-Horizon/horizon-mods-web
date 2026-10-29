FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
