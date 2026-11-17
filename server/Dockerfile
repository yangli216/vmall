# =================================================================
# 微信云托管官方标准多阶段构建 Dockerfile
# 极简轻量 Node.js 运行时，秒级冷启动唤醒，低内存占用
# =================================================================

# 阶段 1: 依赖安装与代码构建
FROM node:18-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 阶段 2: 生产运行镜像
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=80

COPY package.json ./
RUN npm install --only=production --registry=https://registry.npmmirror.com

COPY --from=builder /app/dist ./dist

# 微信云托管默认监听 80 端口
EXPOSE 80

CMD ["node", "dist/index.js"]
