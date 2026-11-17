# Mos Eisley Exchange. Same pattern as death-star-audit: alpine Node, unprivileged user, port 3000.
#
# With DB_ENGINE=sqlite (default) mount a volume at /app/data so users and settings survive restarts:
#   docker run -p 3000:3000 -v exchange-data:/app/data mos-eisley-exchange
# With DB_ENGINE=mysql nothing is written inside the container.
#
# Optional dependencies (the Anthropic SDK) are left out; add `--include=optional` to the npm ci
# line if you use LLM_API=anthropic. The openai path needs no SDK.
FROM docker.io/library/node:24.22.3-alpine3.24

ENV NODE_ENV=production \
    PORT=3000 \
    DB_ENGINE=sqlite \
    SQLITE_PATH=/app/data/exchange.sqlite

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/readyz || exit 1
CMD ["node", "server.js"]
