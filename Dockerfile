# WorkBuddy Web Monitor
# 零依赖 Node.js 应用，仅需挂载 WorkBuddy 数据目录（只读）即可运行
FROM node:22-alpine

WORKDIR /app

# 先复制 package.json 以利用层缓存（本项目无依赖，仅保持规范）
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY pricing.json ./

ENV NODE_ENV=production \
    PORT=3456 \
    HOST=0.0.0.0 \
    WB_HOME=/data/workbuddy

# 声明数据卷：运行时用 -v ~/.workbuddy:/data/workbuddy:ro 挂载
VOLUME ["/data/workbuddy"]

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null 2>&1 || exit 1

USER node

CMD ["node", "server.js"]
