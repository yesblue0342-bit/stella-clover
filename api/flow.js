// api/flow.js - Stella Flow 백엔드 (플로우차트/피규어).
//   POST ?action=structure : {rows|text, direction} → AI(gpt-4o-mini)로 깔끔한 Mermaid 정의 생성
//                             (AI 실패/키없음 → 로컬 rowsToMermaid 폴백). 항상 JSON.
//   POST ?action=save      : {title, mermaid, svg?, pngBase64?, sourceType, nodeCount, edgeCount, userId}
//                            → Drive stellagpt/flow/<생성시각_제목> 폴더 생성 후 mmd/svg/png/json 업로드
//                            + OCI Postgres cl_flows 메타 INSERT. Drive 실패해도 메타는 저장(graceful).
//   GET  ?action=list      : 최근 플로우 목록.  GET ?action=detail&id= : 상세.
//
// ★ 신규 API 키 없음(OpenAI/Drive/Postgres 기존 인프라 재사용). 모든 경로 항상 JSON 반환(프런트 safeJson).
import OpenAI from "openai";
import { getPool, sql, hasDbConfig } from "./_db.js";
import { getDrive, ensurePathRooted, uploadText, uploadBuffer, folderLink, dateParts } from "./_drive.js";
import { rowsToMermaid, looksLikeMermaid } from "../lib/flowBuild.js";

const FLOW_ROOT = "stellagpt"; // 사용자 지정: 결과는 stellagpt/flow 하위에 저장(stellaclover 아님)
const FLOW_SUB = "flow";

let _openai;
function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

function safeName(s, fallback) {
  return String(s || "").replace(/[\\/:*?"<>|\n\r\t]/g, "").trim().slice(0, 60) || fallback;
}

// AI: 표(rows) 또는 자유 텍스트 → Mermaid flowchart. 실패 시 throw(호출부에서 로컬 폴백).
async function aiStructure({ rows, text, direction }) {
  const dir = /^(TB|TD|BT|LR|RL)$/.test(direction || "") ? direction : "TD";
  const tableText = Array.isArray(rows) && rows.length
    ? rows.slice(0, 200).map(r => (Array.isArray(r) ? r.join(" | ") : String(r))).join("\n")
    : String(text || "").slice(0, 6000);
  const resp = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 1500,
    messages: [
      {
        role: "system",
        content: `너는 업무 프로세스를 Mermaid 플로우차트로 정리하는 도우미다. 입력(표 또는 설명)을 분석해 JSON으로만 답하라.
형식: {"title":"간결한 제목","mermaid":"flowchart ${dir} ...","summary":"한 줄 설명"}
규칙:
- mermaid 는 반드시 "flowchart ${dir}" 로 시작. 노드 id 는 n0,n1... 영문, 라벨은 "큰따옴표"로 감싸고 한국어 허용.
- 판단/분기는 마름모 {"..."}, 시작/끝은 스타디움 (["..."]), 일반 단계는 ["..."].
- 분기 간선은 -->|"조건"| 으로 라벨링. 라벨에 큰따옴표/대괄호/파이프 문자는 쓰지 말 것.
- 입력의 모든 단계를 누락 없이 반영하되 중복 단계는 하나의 노드로 합쳐라.`
      },
      { role: "user", content: tableText || "(빈 입력)" }
    ]
  });
  let parsed = {};
  try { parsed = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }
  const mermaid = String(parsed.mermaid || "").trim();
  if (!looksLikeMermaid(mermaid)) throw new Error("AI 응답이 유효한 flowchart 가 아님");
  return { title: String(parsed.title || "").slice(0, 120), mermaid, summary: String(parsed.summary || "").slice(0, 300) };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const action = String(req.query.action || (req.method === "GET" ? "list" : "")) || "";

  try {
    // ── 구조화(표/텍스트 → Mermaid) — DB 불필요 ──
    if (req.method === "POST" && action === "structure") {
      const b = req.body || {};
      const rows = Array.isArray(b.rows) ? b.rows : null;
      const text = typeof b.text === "string" ? b.text : "";
      const direction = b.direction;
      // 로컬 변환은 항상 가능(즉시 결과/폴백)
      const local = rows ? rowsToMermaid(rows, { direction }) : rowsToMermaid([], { direction });
      // useAi 미지정(undefined)은 하위호환상 true 로 간주. 명시적 false 면 OpenAI 호출 생략(불필요한 유료호출 방지).
      const wantAi = b.useAi !== false;
      let ai = null, aiError = null;
      if (wantAi && process.env.OPENAI_API_KEY && (rows?.length || text.trim())) {
        try { ai = await aiStructure({ rows, text, direction }); }
        catch (e) { aiError = e.message; }
      }
      const chosen = ai || { title: "", mermaid: local.mermaid, summary: "" };
      return res.status(200).json({
        ok: true,
        title: chosen.title,
        mermaid: chosen.mermaid,
        summary: chosen.summary || "",
        local: { mermaid: local.mermaid, nodeCount: local.nodeCount, edgeCount: local.edgeCount, mode: local.mode },
        usedAi: !!ai,
        warnings: aiError ? { aiError } : undefined,
      });
    }

    // ── 저장(Drive 폴더 + 파일들 + OCI 메타) ──
    if (req.method === "POST" && action === "save") {
      const b = req.body || {};
      const title = safeName(b.title, "flow");
      const mermaid = String(b.mermaid || "").slice(0, 100000);
      const svg = typeof b.svg === "string" ? b.svg.slice(0, 2_000_000) : "";
      // 디코드 전 길이 상한(메모리 보호). 8MB base64 ≈ 6MB PNG. 초과 시 400 JSON.
      const rawPng = typeof b.pngBase64 === "string" ? b.pngBase64 : "";
      if (rawPng.length > 8_000_000) return res.status(400).json({ ok: false, message: "이미지가 너무 큽니다(8MB 초과)." });
      const pngBase64 = rawPng;
      const sourceType = safeName(b.sourceType, "flow");
      const nodeCount = parseInt(b.nodeCount, 10) || 0;
      const edgeCount = parseInt(b.edgeCount, 10) || 0;
      const userId = String(b.userId || "anon").slice(0, 128);

      if (!mermaid && !pngBase64) return res.status(400).json({ ok: false, message: "저장할 내용이 없습니다(mermaid/이미지)." });

      const { YMD, HM } = dateParts();
      const folderName = `${YMD}_${HM}_${title}`.slice(0, 80); // 생성 시마다 새 폴더(자동)
      const fileBase = safeName(title, "flow");

      // 1) Drive 저장(베스트에포트). 실패해도 메타는 DB 에 남긴다.
      let driveFolderId = null, driveFolderUrl = null, driveFileId = null, driveLink = null, driveError = null;
      if (process.env.GOOGLE_REFRESH_TOKEN) {
        try {
          const drive = getDrive();
          const folderId = await ensurePathRooted(drive, FLOW_ROOT, [FLOW_SUB, folderName]);
          driveFolderId = folderId;
          driveFolderUrl = folderLink(folderId);
          if (mermaid) {
            const up = await uploadText(drive, folderId, `${fileBase}.mmd`, mermaid);
            driveFileId = up.id; driveLink = up.webViewLink;
          }
          if (svg) { try { await uploadText(drive, folderId, `${fileBase}.svg`, svg); } catch (e) {} }
          if (pngBase64) {
            try {
              const buf = Buffer.from(pngBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
              const up2 = await uploadBuffer(drive, folderId, `${fileBase}.png`, "image/png", buf);
              if (!driveFileId) { driveFileId = up2.id; driveLink = up2.webViewLink; }
            } catch (e) {}
          }
          // 메타 JSON 미러
          try {
            const meta = { title, sourceType, nodeCount, edgeCount, created_at: new Date().toISOString(), folder: driveFolderUrl };
            await uploadText(drive, folderId, `${fileBase}.json`, JSON.stringify(meta, null, 2));
          } catch (e) {}
        } catch (e) { driveError = e.message; }
      } else {
        driveError = "Google Drive 미설정";
      }

      // 2) OCI Postgres 메타 INSERT (cl_flows). DB 미설정이면 스킵하고 경고.
      let dbError = null, flowId = null;
      if (hasDbConfig()) {
        try {
          const pool = await getPool();
          const r = await pool.request()
            .input("title", sql.NVarChar(300), title)
            .input("st", sql.NVarChar(40), sourceType)
            .input("mm", sql.NVarChar(sql.MAX), mermaid || "")
            .input("nc", sql.Int, nodeCount)
            .input("ec", sql.Int, edgeCount)
            .input("dfid", sql.NVarChar(200), driveFolderId || "")
            .input("dfl", sql.NVarChar(500), driveFolderUrl || "")
            .input("fid", sql.NVarChar(200), driveFileId || "")
            .input("link", sql.NVarChar(500), driveLink || "")
            .input("uid", sql.NVarChar(128), userId)
            .query(`
              INSERT INTO cl_flows (title,source_type,mermaid,node_count,edge_count,drive_folder_id,drive_folder_link,drive_file_id,drive_link,user_id)
              VALUES (@title,@st,@mm,@nc,@ec,@dfid,@dfl,@fid,@link,@uid)
              RETURNING id`);
          flowId = r.recordset?.[0]?.id ?? null;
        } catch (e) { dbError = e.message; }
      } else {
        dbError = "DB 환경변수 미설정";
      }

      // 실제로 어딘가에 저장됐는지로 ok 판정 — Drive·DB 둘 다 실패면 ok:false(거짓 "저장 완료" 방지).
      const persisted = !!flowId || !!driveFolderId;
      return res.status(200).json({
        ok: persisted, id: flowId, driveFolderId, driveFolderLink: driveFolderUrl, driveFileId, driveLink,
        message: persisted ? undefined : "저장 실패: Drive·DB 모두 사용 불가",
        warnings: (driveError || dbError) ? { driveError, dbError } : undefined,
      });
    }

    // ── 목록 ──
    if (req.method === "GET" && action === "list") {
      if (!hasDbConfig()) return res.status(200).json({ ok: false, items: [], message: "DB 환경변수 미설정" });
      const pool = await getPool();
      const userId = req.query.userId ? String(req.query.userId).slice(0, 128) : null;
      const r = userId
        ? await pool.request().input("uid", sql.NVarChar(128), userId)
            .query(`SELECT id,title,source_type,node_count,edge_count,drive_folder_link,drive_link,created_at FROM cl_flows WHERE user_id=@uid ORDER BY id DESC LIMIT 50`)
        : await pool.request()
            .query(`SELECT id,title,source_type,node_count,edge_count,drive_folder_link,drive_link,created_at FROM cl_flows ORDER BY id DESC LIMIT 50`);
      return res.status(200).json({ ok: true, items: r.recordset || [] });
    }

    // ── 상세 ── (소유 범위 제한: 클라이언트 식별자로 스코핑 — 앱 전역 인증부재 모델 하의 best-effort)
    if (req.method === "GET" && action === "detail") {
      if (!hasDbConfig()) return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });
      const uid = String(req.query.userId || "anon").slice(0, 128);
      const pool = await getPool();
      const r = await pool.request().input("id", sql.BigInt, id).input("uid", sql.NVarChar(128), uid)
        .query(`SELECT * FROM cl_flows WHERE id=@id AND user_id=@uid`);
      return res.status(200).json({ ok: true, item: r.recordset?.[0] || null });
    }

    // ── 삭제 ── (id + 소유자(userId) 일치 시에만 삭제 — 타 사용자 행 무단 삭제 방지)
    if ((req.method === "POST" || req.method === "GET") && action === "delete") {
      if (!hasDbConfig()) return res.status(200).json({ ok: false, message: "DB 환경변수 미설정" });
      const id = parseInt((req.body && req.body.id) ?? req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "id 필요" });
      const uid = String((req.body && req.body.userId) ?? req.query.userId ?? "anon").slice(0, 128);
      const pool = await getPool();
      const r = await pool.request().input("id", sql.BigInt, id).input("uid", sql.NVarChar(128), uid)
        .query(`DELETE FROM cl_flows WHERE id=@id AND user_id=@uid`);
      return res.status(200).json({ ok: true, deleted: r.rowsAffected?.[0] || 0 });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, message: "지원하지 않는 요청입니다." });
  } catch (e) {
    return res.status(200).json({ ok: false, message: "Flow 처리 오류: " + e.message });
  }
}
