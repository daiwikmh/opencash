FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "backend..."
COPY packages/shared packages/shared
COPY backend backend
WORKDIR /app/backend
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/index.ts"]
