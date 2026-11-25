# Build context: server/ (after `npm run server:build`, which makes dist/server.mjs).
#   docker build -t taiko-server server
FROM node:24-trixie-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
# The whole server is this one file; it uses nothing but Node itself.
COPY dist/server.mjs ./server.mjs
# Created here so the named volume mounted on /data starts out owned by `node`.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
