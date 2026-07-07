// lib/sttTerms.js — STT 도메인 사전 (공유 모듈, 신규 라우트/키 없음).
//   · SAP_PROMPT: Whisper/gpt-4o-transcribe prompt 파라미터용 도메인 용어 힌트(인식 정확도↑). 200토큰 이내 유지.
//   · CORRECTIONS + applyCorrections: 전사 후처리 교정 사전(자주 틀리는 SAP/회의 용어 복원).
//
// ★ 용어의 단일 출처는 config/stt-terms.json — 사용자가 코드 수정 없이 용어를 추가할 수 있다.
//   JSON 파일이 없거나 깨져 있으면 내장 기본값으로 동작(전사 파이프라인은 설정 파일 문제와 무관하게 항상 동작).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "stt-terms.json");

// 내장 기본값(설정 파일 로드 실패 시 폴백). config/stt-terms.json 과 동일 의미의 최소셋.
const DEFAULT_TERMS = [
  "SAP", "ERP", "ABAP", "BAPI", "IDoc", "BOM", "MRP", "QM", "PP", "MM", "SD",
  "FI", "CO", "WM", "EWM", "PM", "S/4HANA", "ECC", "CBO", "HU", "MIC",
  "Usage Decision", "모듈", "트랜잭션", "인터페이스", "배치", "컨버전",
  "마스터데이터", "자재마스터", "구매오더", "생산오더", "품질검사",
  "검사로트", "검사계획", "핸들링유닛", "입고", "출고", "재고",
  "고도화", "마이그레이션", "컷오버", "운영이관", "리허설",
];
const DEFAULT_CORRECTIONS = [
  [/에이\s?밥/g, "ABAP"],
  [/바\s?피/g, "BAPI"],
  [/에스\s?포\s?하나/g, "S/4HANA"],
  [/S4\s?HANA/gi, "S/4HANA"],
  [/검사\s+로트/g, "검사로트"],
  [/컷\s+오버/g, "컷오버"],
];

// config/stt-terms.json 로드. 실패 시 null(호출부가 기본값 사용).
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    const terms = Array.isArray(cfg.promptTerms) ? cfg.promptTerms.map(String).filter(Boolean) : null;
    const corrections = Array.isArray(cfg.corrections)
      ? cfg.corrections
          .map((c) => {
            try { return [new RegExp(String(c.pattern), String(c.flags || "g")), String(c.replace ?? "")]; }
            catch (e) { console.warn("[sttTerms] 잘못된 교정 정규식 무시:", c && c.pattern, e && e.message); return null; }
          })
          .filter(Boolean)
      : null;
    if (!terms || !terms.length) return null;
    return { terms, corrections: corrections || [] };
  } catch (e) {
    console.warn("[sttTerms] config/stt-terms.json 로드 실패 — 내장 기본값 사용:", e && e.message);
    return null;
  }
}

const _cfg = loadConfig();

// 핵심 SAP/ERP·회의 전문용어. 프롬프트로 주입돼 STT가 해당 표기를 선호하게 만든다.
export const SAP_TERMS = _cfg ? _cfg.terms : DEFAULT_TERMS;

// STT prompt 파라미터 문자열 (단일 출처: config/stt-terms.json).
export const SAP_PROMPT = SAP_TERMS.join(", ") + ".";

// 후처리 교정 사전: [틀린 표기(정규식), 올바른 표기]. (JSON 로드 실패 시 내장 최소셋)
export const CORRECTIONS = _cfg ? _cfg.corrections : DEFAULT_CORRECTIONS;

// 전사 텍스트에 교정 사전을 일괄 적용. 입력이 비거나 문자열이 아니면 안전 통과.
export function applyCorrections(text) {
  let s = String(text == null ? "" : text);
  if (!s) return s;
  for (const [re, to] of CORRECTIONS) s = s.replace(re, to);
  return s;
}

export default { SAP_TERMS, SAP_PROMPT, CORRECTIONS, applyCorrections };
