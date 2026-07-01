// api/_analyze.js - 화자 라벨(A4) + 구조화 요약(A5). gpt-4.1-mini, JSON 출력 + 파싱 방어.
import { getOpenAI } from "./_stt.js";

const MODEL = "gpt-4.1-mini";

function safeParse(s, fallback) {
  try { const o = JSON.parse(String(s || "")); return o && typeof o === "object" ? o : fallback; }
  catch (e) { return fallback; }
}

// 긴 전사(1~2시간 회의)에서 구조화 요약이 컨텍스트 초과로 통째 실패(=summary null)하지 않도록,
// 아주 긴 경우에만 앞·뒤를 넉넉히 표본화한다(중간 생략 표기). 최종 회의록은 summarize.js 가 map-reduce 로 전체 반영.
const STRUCT_INPUT_LIMIT = Number(process.env.STRUCT_INPUT_LIMIT || 90000); // 문자
function clampForStruct(t) {
  const s = String(t || "").replace(/\r\n/g, "\n").trim();
  if (s.length <= STRUCT_INPUT_LIMIT) return s;
  const head = Math.floor(STRUCT_INPUT_LIMIT * 0.6);
  const tail = STRUCT_INPUT_LIMIT - head;
  return s.slice(0, head) + "\n\n…(중략)…\n\n" + s.slice(s.length - tail);
}

// A5: 구조화 요약(JSON) — 한 줄 요약 / 핵심 주제 / 결정사항 / 액션 아이템 / 키워드
export async function structuredSummary(transcript, lang = "ko") {
  const outLang = lang === "en" ? "English" : (lang === "ja" ? "日本語" : "한국어");
  const resp = await getOpenAI().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 1600,
    messages: [
      {
        role: "system",
        content: `당신은 SAP/ERP 프로젝트 회의록 분석 AI입니다. 아래 전사 내용을 분석해 JSON으로만 답하세요. 모든 값은 ${outLang}로 작성합니다.
형식(키 고정):
{"oneLine":"한 줄 요약","topics":["핵심 주제"],"decisions":["결정사항"],"actionItems":[{"who":"담당자 또는 미상","what":"할 일","due":"기한 또는 빈 문자열"}],"keywords":["키워드 5~10"]}
SAP 전문용어(ABAP, BAPI, IDoc, BOM, MRP, QM, PP, MM, SD, FI, CO, S/4HANA, 검사로트, 자재마스터, 생산오더, 고도화, 인터페이스, 마이그레이션 등)를 정확히 반영하고, 음성 인식 오류로 보이는 용어는 SAP 맥락에 맞게 교정하세요.`
      },
      { role: "user", content: clampForStruct(transcript) } /* 기본은 전사 전체, 초장문만 앞·뒤 표본화(컨텍스트 초과 실패 방지) */
    ]
  });
  const d = safeParse(resp.choices?.[0]?.message?.content, {});
  return {
    oneLine: String(d.oneLine || ""),
    topics: Array.isArray(d.topics) ? d.topics.map(String) : [],
    decisions: Array.isArray(d.decisions) ? d.decisions.map(String) : [],
    actionItems: Array.isArray(d.actionItems) ? d.actionItems.map(a => ({
      who: String(a?.who || "미상"), what: String(a?.what || ""), due: String(a?.due || "")
    })) : [],
    keywords: Array.isArray(d.keywords) ? d.keywords.map(String) : [],
  };
}

// A4: 화자 라벨(근사치) — voiceprint 불가 → LLM이 내용·맥락·턴 전환으로 추정. "참석자 N".
// 반환: segments와 같은 길이의 speaker 문자열 배열.
export async function labelSpeakers(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!segs.length) return [];
  const compact = segs.map((s, i) => `${i}: ${String(s.text || "").slice(0, 200)}`).join("\n").slice(0, 20000);
  let map = {};
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: `발화 세그먼트의 화자를 추정합니다. voiceprint(성문)가 없으므로 내용·맥락·말투·턴 전환으로 근사 추정하는 것이며 정확하지 않을 수 있습니다. 참석자를 "참석자 1","참석자 2"... 로 라벨링하세요.
JSON으로만 답하세요: {"speakers":[{"i":세그먼트번호,"speaker":"참석자 1"}]} — 입력의 모든 i를 포함하세요.`
        },
        { role: "user", content: compact }
      ]
    });
    const d = safeParse(resp.choices?.[0]?.message?.content, { speakers: [] });
    (d.speakers || []).forEach(x => { if (x && Number.isInteger(x.i)) map[x.i] = String(x.speaker || "참석자 1"); });
  } catch (e) { map = {}; }
  return segs.map((s, i) => map[i] || "참석자 1");
}
