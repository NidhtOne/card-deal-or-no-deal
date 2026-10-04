# 文档外补充：选择 glibc 平台，better-sqlite3 ^11.10.0 通常可直接使用预编译产物；
# 不选 Alpine，以避免无必要地引入 node-gyp 编译依赖。
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# 文档外补充：npm workspaces 执行 npm ci 时，根清单、锁文件和两个成员清单缺一不可。
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
# 若 better-sqlite3 预编译产物拉取失败，其源码编译需要 python3、make、g++；
# slim 默认不包含这些工具，遇到实际构建失败时再在本阶段补装【文档外补充】。
RUN npm ci

FROM deps AS build
COPY server ./server
COPY web ./web
COPY config ./config
COPY assets ./assets
COPY scripts ./scripts
COPY .env.example ./.env.example
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 文档外补充：运行时重新安装生产依赖，保持最终镜像干净。
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci --omit=dev

# 保持 monorepo 相对结构。服务端通过 __dirname 推导 /app 根目录；
# DATABASE_URL 与 STORAGE_DIR 的相对路径也锚定 /app，与 compose 数据卷一致【文档外补充】。
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY config ./config
COPY assets ./assets
COPY scripts/init-env.js ./scripts/init-env.js
COPY scripts/start-prod.js ./scripts/start-prod.js
# init-env 在 .env 缺失时会复制此文件；该样例不含真实密钥【文档外补充】。
COPY .env.example ./.env.example

RUN mkdir -p /app/data /app/storage \
  && chown -R node:node /app

# database.module 已启用 migrationsRun: true，启动时会自动执行未应用迁移。
USER node
EXPOSE 8080

# 文档外补充：镜像不安装 curl/wget，使用 Node 20 内置 fetch 执行健康检查。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "scripts/start-prod.js"]
