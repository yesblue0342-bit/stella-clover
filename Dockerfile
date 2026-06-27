# Stella Clover — 앱 이미지 (raw Node, 의존성 pg·openai·googleapis·formidable)
FROM node:20-alpine

WORKDIR /app

# 의존성만 먼저 복사해 레이어 캐시 (소스 변경 시 재설치 최소화)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 앱 소스
COPY . .

ENV NODE_ENV=production
ENV PORT=8842
# 업로드 본문 한도(=청크 우회). nginx-proxy-manager 쪽 client_max_body_size도 함께 상향 필요.
ENV MAX_BODY_BYTES=31457280

EXPOSE 8842

# 헬스체크: server.js의 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8842/healthz || exit 1

CMD ["node", "server.js"]
