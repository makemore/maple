# Grove's shared runner: sign-in, and the apps that share it. Small, and asleep when nobody is calling.
FROM node:22-slim
# libc++ for the sandbox runtime; the Postgres 17 tools for trial copies and exports.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libc++1 curl gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs dispatcher.js ./
COPY shims ./shims
# One file starts much faster than thousands (see pack.mjs).
RUN node pack.mjs
ENV NODE_ENV=production
USER node
CMD ["node", "dist/server.mjs"]
