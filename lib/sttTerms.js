// lib/sttTerms.js — STT 도메인 사전 (공유 모듈, 신규 라우트/키 없음).
//   · SAP_PROMPT: Whisper prompt 파라미터용 도메인 용어 힌트(인식 정확도↑). 200토큰 이내 유지.
//   · CORRECTIONS + applyCorrections: 전사 후처리 교정 사전(자주 틀리는 SAP/회의 용어 복원).
// 순수 모듈 — env/네트워크 의존 없음. _stt.js(전사)와 단위테스트가 공유.

// 핵심 SAP/ERP·회의 전문용어. 프롬프트로 주입돼 Whisper가 해당 표기를 선호하게 만든다.
// (200토큰 이내: 영문 약어 + 한국어 빈출어 위주. 너무 길면 디코딩 편향·환각 위험.)
export const SAP_TERMS = [
  "SAP", "ERP", "ABAP", "BAPI", "IDoc", "BOM", "MRP", "QM", "PP", "MM", "SD",
  "FI", "CO", "WM", "PM", "S/4HANA", "ECC", "모듈", "트랜잭션", "인터페이스",
  "배치", "마스터데이터", "자재마스터", "구매오더", "생산오더", "품질검사",
  "검사로트", "입고", "출고", "재고", "워크플로우", "커스터마이징", "컨피그",
  "스프린트", "고도화", "마이그레이션", "롤아웃", "표준화", "단위테스트",
  "통합테스트", "컷오버", "운영이관", "리허설",
];

// Whisper prompt 파라미터 문자열 (기존 _stt.js SAP_PROMPT와 동일 의미, 단일 출처로 통합).
export const SAP_PROMPT = SAP_TERMS.join(", ") + ".";

// 후처리 교정 사전: [틀린 표기(정규식), 올바른 표기].
// 보수 원칙 — 오탐(정상어 손상) 위험이 낮은 도메인 고유 표현만. 영문 약어는 대소문자 무시(i),
// 한국어 띄어쓰기 변형(에이 밥/에이밥)까지 흡수. 일상어(피피·시오 등 단독)는 넣지 않는다.
export const CORRECTIONS = [
  // 영문 약어가 한글 음차로 잘못 전사되는 케이스 (도메인 한정 → 오탐 거의 없음).
  // 주의: JS 정규식 \b는 한글에 동작하지 않아 한국어 패턴엔 사용하지 않는다(조사는 그대로 보존).
  [/에이\s?밥/g, "ABAP"],
  [/아이\s?닥/g, "IDoc"],
  [/아이\s?독/g, "IDoc"],
  [/바\s?피/g, "BAPI"],
  [/에스\s?포\s?하나/g, "S/4HANA"],
  [/에스\s?사\s?하나/g, "S/4HANA"],
  [/S4\s?HANA/gi, "S/4HANA"],
  [/S\s?4\s?하나/g, "S/4HANA"],
  // 도메인 합성어 띄어쓰기 정규화 (의미 불변, 검색 일관성↑)
  [/검사\s+로트/g, "검사로트"],
  [/자재\s+마스터/g, "자재마스터"],
  [/마스터\s+데이터/g, "마스터데이터"],
  [/생산\s+오더/g, "생산오더"],
  [/구매\s+오더/g, "구매오더"],
  [/품질\s+검사/g, "품질검사"],
  [/컷\s+오버/g, "컷오버"],
  [/운영\s+이관/g, "운영이관"],
];

// 전사 텍스트에 교정 사전을 일괄 적용. 입력이 비거나 문자열이 아니면 안전 통과.
export function applyCorrections(text) {
  let s = String(text == null ? "" : text);
  if (!s) return s;
  for (const [re, to] of CORRECTIONS) s = s.replace(re, to);
  return s;
}

export default { SAP_TERMS, SAP_PROMPT, CORRECTIONS, applyCorrections };
