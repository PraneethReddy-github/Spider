# Spider server + worker image (hosted mode, S-4). Build: docker build -t spider .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
# git: clones of analysed repositories
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 spider \
  && mkdir /data && chown spider /data
WORKDIR /app
COPY --from=build --chown=spider /app /app
USER spider
ENV NODE_ENV=production SPIDER_HOME=/data
VOLUME /data
EXPOSE 4747
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4747"]
