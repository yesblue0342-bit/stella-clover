# Stella Clover — OCI 구동 (Node 서버, Vercel 함수 어댑터)
FROM node:22-slim
# ffmpeg: 서버측 오디오 전처리(모노 16kHz 변환 + loudnorm + 무음 기준 분할 — lib/audioPrep.js)
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# CBO Review "계정 로그인" 옵션 전용 CLI(선택 기능) — 미로그인 상태여도 기존 API 키 방식은 그대로 동작한다.
# 최초 1회 컨테이너 안에서 `claude login`/`codex login` 실행 필요(WORK_REPORT.md 참고), 인증 파일은
# /root/.claude, /root/.codex 명명 볼륨(deploy/run-stella-oci.sh)에 저장돼 재배포에도 유지된다.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=8971
EXPOSE 8971
# 컨테이너 alive 체크 (정적 루트는 시크릿 없이도 200)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8971/ >/dev/null || exit 1
CMD ["node", "server.mjs"]
