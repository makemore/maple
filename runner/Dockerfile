# Grove's shared runner: sign-in, and the apps that share it. Small, and asleep when nobody is calling.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libc++1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs dispatcher.js ./
ENV NODE_ENV=production
USER node
CMD ["node", "server.mjs"]
