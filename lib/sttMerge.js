// lib/sttMerge.js — 청크 경계 오버랩 병합 디듀프(공유 순수 모듈).
// 청크를 2~3초 겹쳐 잘라 경계 단어 누락을 막되, 겹친 구간이 두 청크에 중복 전사된다.
// dedupOverlapTokens: 누적 텍스트(prev)의 꼬리와 다음 청크(next)의 머리가 겹치면 머리를 제거.
// 동일 모듈 로직을 index.html 인라인에도 복제(단일파일 PWA라 import 불가) — 수정 시 양쪽 동기화.

// 토큰 정규화: 비교용으로만 사용(구두점/대소문자 차이를 흡수, 원문은 보존).
export function normTok(t) {
  return String(t || "").replace(/[.,!?…·~\-"'()「」『』]/g, "").toLowerCase();
}

// prev 꼬리 k토큰 == next 머리 k토큰(정규화 비교)인 최대 k(>=2)를 찾아 next에서 제거.
// 일치 없으면 next 원형 반환(중복을 만드느니 살짝 겹치는 게 낫다 — 보수적).
export function dedupOverlapTokens(prev, next, maxTokens = 40) {
  const n = String(next == null ? "" : next).trim();
  const p = String(prev == null ? "" : prev).trim();
  if (!p || !n) return n;
  const pt = p.split(/\s+/), nt = n.split(/\s+/);
  const maxK = Math.min(maxTokens, pt.length, nt.length);
  for (let k = maxK; k >= 2; k--) {
    const ptail = pt.slice(pt.length - k).map(normTok).join(" ");
    const nhead = nt.slice(0, k).map(normTok).join(" ");
    if (ptail && ptail === nhead) return nt.slice(k).join(" ");
  }
  return n;
}

export default { normTok, dedupOverlapTokens };
