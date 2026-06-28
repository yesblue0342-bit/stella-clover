#!/usr/bin/env bash
#
# Stella Clover — OCI 배포 (stella-ai-workspace 와 동일한 npm_default 패턴)
# 사전: /opt/stella-clover 에 clone + .env 작성 완료 상태 (cp .env.example .env && 값 채우기)
# 실행: bash deploy/run-stella-oci.sh
#
set -euo pipefail

NAME=stella-clover
NETWORK=npm_default
PORT=8971

cd "$(dirname "$0")/.."

# docker 권한: 사용자가 docker 그룹이면 sudo 불필요(CI/비대화식 SSH에서 sudo 비번 멈춤 방지).
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  DOCKER="sudo docker"
  echo "  ⚠️ docker 권한 확인 필요: 'sudo usermod -aG docker \$USER' 후 재로그인(권장) 또는 NOPASSWD sudo."
fi

echo "▶ 1/5 .env 확인"
if [ ! -f .env ]; then
  echo "  ❌ .env 가 없습니다. 먼저 작성하세요:  cp .env.example .env  &&  nano .env"
  exit 1
fi
echo "  ✅ .env 존재 (docker 실행: $DOCKER)"

echo "▶ 2/5 이미지 빌드 (Node deps 설치 — 수 분 소요 가능)"
$DOCKER build -t "$NAME" .

echo "▶ 3/5 기존 컨테이너 정리"
$DOCKER rm -f "$NAME" 2>/dev/null || true

echo "▶ 4/5 $NETWORK 네트워크에 컨테이너 실행 (.env 주입)"
$DOCKER run -d --name "$NAME" \
  --network "$NETWORK" \
  --env-file .env \
  --restart unless-stopped \
  "$NAME"

echo "▶ 5/5 헬스체크 (12초 대기)"
sleep 12
if $DOCKER exec "$NAME" curl -fsS "http://127.0.0.1:$PORT/" >/dev/null; then
  echo "  ✅ 컨테이너 내부 정상 (정적 서빙 OK)"
else
  echo "  ⚠️ 응답 없음 — 로그 확인: $DOCKER logs $NAME --tail 50"
fi

echo ""
echo "🎉 빌드/실행 완료. NPM(Nginx Proxy Manager) Proxy Host 설정:"
echo "   Forward Host/IP : $NAME"
echo "   Forward Port    : $PORT"
echo "   (Websockets Support 켜기)  SSL 탭 → Request a new Certificate → Force SSL → Save"
echo ""
echo "API 확인: $DOCKER exec $NAME curl -s http://127.0.0.1:$PORT/api/meetings | head -c 200"
