# Stella Clover — OCI 구동 (Node 서버, Vercel 함수 어댑터)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=8970
EXPOSE 8970
# 컨테이너 alive 체크 (정적 루트는 시크릿 없이도 200)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8970/ >/dev/null || exit 1
CMD ["node", "server.mjs"]
