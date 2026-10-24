# Causa: one image, API + office UI on $PORT (default 8000).
#   docker build -t causa .
#   docker run --rm -p 8000:8000 --env-file .env causa
#   docker run --rm -p 8000:8000 -e SAMPLE_MODE=true causa      # no credentials at all
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0 CAUSA_DATA=/app/data/runtime

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run web:build && mkdir -p logs data/runtime

EXPOSE 8000
CMD ["npx", "tsx", "src/server.ts"]
