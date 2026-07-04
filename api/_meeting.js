// api/_meeting.js — 회의록/요약 입력 전처리 + 프롬프트 빌더 (전사 전체 사용, 잘림 없음).
// 순수 함수로 분리해 단위 테스트 가능. (RALPH clover: STT 전체 반영 + 한국어 비즈니스 회의록)

// 단일 호출로 안전한 길이(문자). 초과 시 map-reduce(부분요약→통합)로 잘림 없이 처리.
export const SINGLE_PASS_LIMIT = 40000;

// 한 줄 내 n-gram 반복 축소(개행은 호출부에서 보존).
function collapseLine(line, maxRepeat) {
  const cleanTok = (t) => t.replace(/[,.，。·!?~…-]+$/u, "").trim().toLowerCase();
  let toks = line.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return line; // 단일 토큰/빈 줄은 원형 보존(거대 토큰 길이 보존)
  for (let n = 4; n >= 1; n--) {
    const out = [];
    let i = 0;
    while (i < toks.length) {
      const gram = i + n <= toks.length ? toks.slice(i, i + n).map(cleanTok).join(" ") : "";
      if (gram && gram.replace(/\s/g, "")) {
        let rep = 1;
        while (i + (rep + 1) * n <= toks.length &&
               toks.slice(i + rep * n, i + (rep + 1) * n).map(cleanTok).join(" ") === gram) rep++;
        if (rep > maxRepeat) {
          for (let k = 0; k < maxRepeat * n; k++) out.push(toks[i + k]);
          i += rep * n;
          continue;
        }
      }
      out.push(toks[i]); i++;
    }
    toks = out;
  }
  return toks.join(" ").replace(/\s+([,.!?。])/g, "$1");
}

// Whisper 반복 환각("3, 3, 3, …", "네 네 네 …") 축소. n-gram(4→1)이 maxRepeat 초과 연속 반복되면
// 앞 maxRepeat개만 남긴다. 개행 구조는 보존(줄 단위 처리), 정상 텍스트는 변형 없음.
export function collapseRepeats(text, maxRepeat = 3) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return raw.trim();
  return raw.split("\n").map((line) => collapseLine(line, maxRepeat)).join("\n");
}

// Whisper verbose_json 세그먼트가 "무음/반복 환각"인지 판정(말 없음 확률↑+확신도↓, 또는 압축비↑).
// 보수적 기준 → 실제 발화 제거 위험 최소화.
export function isHallucinatedSegment(s) {
  const nsp = Number((s && s.no_speech_prob) || 0);
  const alp = Number((s && s.avg_logprob) || 0);
  const cr = Number((s && s.compression_ratio) || 0);
  if (nsp >= 0.6 && alp <= -0.7) return true;   // 침묵/배경음 환각
  if (cr >= 2.6 && alp <= -0.5) return true;     // 비정상 반복(압축비 큼)
  return false;
}

// 전사 전처리: 개행 정규화 + 트림 + 반복 환각 축소(길이 컷 절대 없음, 정상 내용 보존).
export function prepareTranscript(t) {
  const s = String(t == null ? "" : t).replace(/\r\n/g, "\n").trim();
  return collapseRepeats(s);
}

// 단일 호출로 처리 불가(너무 김) 여부.
export function needsMapReduce(t, limit = SINGLE_PASS_LIMIT) {
  return prepareTranscript(t).length > limit;
}

// map-reduce용 분할 — 가능하면 공백/문장 경계에서 끊되, 분할 결과를 합치면 원본과 동일(누락 0).
export function splitTranscript(t, size = 16000) {
  const s = prepareTranscript(t);
  if (!s) return [];
  if (s.length <= size) return [s];
  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      // 경계 보정: 마지막 공백/개행에서 끊기(너무 앞이면 그냥 size)
      const win = s.slice(i, end);
      const cut = Math.max(win.lastIndexOf("\n"), win.lastIndexOf(". "), win.lastIndexOf(" "));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    parts.push(s.slice(i, end));
    i = end;
  }
  return parts;
}

// 분할이 원본을 빠짐없이 덮는지 검증(테스트/런타임 가드용).
export function splitCoversAll(t) {
  const s = prepareTranscript(t);
  return splitTranscript(s).join("") === s;
}

// 파일명에서 회의 날짜 추출 (예: 260612_주간회의.m4a → 2026-06-12, 20260612_... 도 지원). 실패 시 "".
export function meetingDateFromName(name) {
  const s = String(name || "");
  let m = s.match(/(20\d{2})[._-]?(\d{2})[._-]?(\d{2})/); // 2026-06-12 / 20260612
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(?:^|[^\d])(\d{2})(\d{2})(\d{2})(?:[^\d]|$)/); // 260612 → 20YY-MM-DD
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `20${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

// 업로드 기본 제목(키 제목) — KST 기준 "YYYY-MM-DD HH:MM 회의록".
// AI가 제목을 못 뽑거나 "회의록"만 나올 때 날짜+시각으로 각 업로드를 구분 가능하게.
export function defaultMeetingTitle(date = new Date(), suffix = "회의록") {
  const d = date instanceof Date ? date : new Date(date);
  const kst = new Date((isNaN(d.getTime()) ? Date.now() : d.getTime()) + 9 * 60 * 60 * 1000);
  const Y = kst.getUTCFullYear();
  const M = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const D = String(kst.getUTCDate()).padStart(2, "0");
  const h = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${mi}${suffix ? " " + suffix : ""}`;
}

// AI 추출 제목이 비었거나 일반(generic)이면 날짜+시각 키 제목으로 대체. 의미있는 제목은 보존.
export function resolveMeetingTitle(aiTitle, date = new Date()) {
  const t = String(aiTitle || "").replace(/[\\/:*?"<>|]/g, "").trim();
  if (!t || t === "회의록" || t === "제목 없음" || t === "무제") return defaultMeetingTitle(date);
  return t;
}

// 한국어 비즈니스 회의록 시스템 프롬프트. 본문에 없는 사실은 창작 금지, 일정/날짜는 빠짐없이.
export function buildMinutesSystemPrompt({ outLang = "한국어", writtenDate = "", meetingDate = "", customBlock = "" } = {}) {
  const wd = String(writtenDate || "").trim() || "미확인";
  const md = String(meetingDate || "").trim(); // 파일명 추출 날짜(있으면 일시 기본값 힌트)
  const ilsi = md
    ? `(본문에 명시되면 그 값, 없으면 파일 날짜 ${md} 사용)`
    : `(본문에 명시되면 기재, 없으면 미확인)`;
  return `당신은 한국어 비즈니스 회의록 작성 전문 AI입니다. (SAP/ERP 컨설팅 프로젝트 맥락)
SAP 전문용어(ABAP, BAPI, IDoc, BOM, MRP, QM, PP, MM, SD, FI, CO, S/4HANA, 검사로트, 자재마스터, 생산오더, 고도화, 인터페이스, 마이그레이션, 컷오버, 리허설 등)를 정확히 이해해 반영하세요.

[정확도·사실충실 규칙 — 최우선]
- 제공된 전사(발언) 전체에만 근거해 작성합니다. 본문에 없는 사실(일시·장소·담당자·수치)은 절대 지어내지 마세요.
- 화자가 말하지 않은 일시/장소는 "미확인"으로 둡니다.
- 본문에 등장하는 날짜·일정(예: 8월·9월 일정, 준비/검증, 이행, 사전 리허설=인터널 체크, 마이그레이션 단계: 추출→정제→변환→이행→점검)은 "6. 일정" 항목에 빠짐없이 정리합니다.
- STT 오인식으로 보이는 용어만 맥락에 맞게 신중히 교정하고, 불확실하면 "(불확실)"로 표기합니다.

아래 형식 그대로 ${outLang}로 작성하세요(섹션 제목 고정):

# 회의록

## 회의 제목
(본문 기반 핵심 주제 한 줄)

## 1. 회의 기본정보
- 일시: ${ilsi}
- 장소: (본문 명시 시 기재, 없으면 미확인)
- 주제: (본문 기반)
- 작성일: ${wd}

## 2. 참석자
(본문에서 추론, 없으면 미확인)

## 3. 안건별 논의
(안건마다 소제목 + 논의 배경·핵심 쟁점·오간 의견/근거/이견을 구체적으로 단락 서술. 본문 전체를 빠짐없이 반영)

## 4. 결정사항
- (항목별, 결정 배경 한 줄 포함)

## 5. Action Item
| 담당자 | 할 일 | 기한 |
|--------|------|------|
| | | |

## 6. 일정
- (본문에 등장하는 모든 날짜·일정·마일스톤을 빠짐없이. 단계와 리허설 포함)

## 핵심 요약
(3~5줄로 회의 핵심 + 주요 결정/일정/리스크를 압축)

## 주요 키워드
(이 회의의 핵심 SAP 용어/주제를 쉼표로 5~10개)${customBlock}`;
}

// 짧은 AI 요약(JSON 아님, 텍스트) 시스템 프롬프트 — 핵심 3~5줄 + 결정/일정/리스크.
export function buildSummarySystemPrompt({ outLang = "한국어" } = {}) {
  return `당신은 한국어 회의 요약 AI입니다. 제공된 전사 전체에 근거해 ${outLang}로 간결히 요약하세요.
- 핵심 3~5줄.
- 주요 결정사항, 일정/날짜(본문에 나온 것 모두), 리스크를 짧게.
- 본문에 없는 내용은 만들지 마세요.`;
}

// map-reduce 부분요약 프롬프트 — 분할 조각을 누락 없이 요점화.
export function buildPartialSystemPrompt({ outLang = "한국어", idx = 0, total = 1 } = {}) {
  return `긴 회의 전사의 ${idx + 1}/${total} 부분입니다. ${outLang}로 이 부분의 모든 논의·결정·일정·담당자·수치를 누락 없이 요점만 정리하세요(해석/창작 금지). 이후 통합 회의록 작성에 쓰입니다.`;
}

export default {
  SINGLE_PASS_LIMIT, prepareTranscript, needsMapReduce, splitTranscript, splitCoversAll,
  buildMinutesSystemPrompt, buildSummarySystemPrompt, buildPartialSystemPrompt,
  meetingDateFromName, defaultMeetingTitle, resolveMeetingTitle, collapseRepeats, isHallucinatedSegment,
};
