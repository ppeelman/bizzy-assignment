FROM oven/bun:1.3 AS build

WORKDIR /app

# Native toolchain — re2 (transitive via metascraper) compiles via node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* bun.lockb* ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run build

FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/index.html ./index.html

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
