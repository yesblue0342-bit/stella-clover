// api/meetings.js - 회의 이력: 목록 / 검색 / 상세 / 삭제
// 어떤 경우에도(연결 실패·테이블 없음·예외) HTML이 아닌 JSON만 반환한다.
import sql from "mssql";

export const config = { maxDuration: 15 };

const COLS =
  "id, title, transcript_chars, summary_chars, drive_file_id, drive_link, audio_file, created_at";

function getDbConfig() {
  return {
    server: process.env.CL_DB_SV,
    database: process.env.CL_DB_NM,
    user: process.env.CL_DB_USR,
    password: process.env.CL_DB_PW,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 }
  };
}

// cl_meetings 테이블이 아직 없을 때(첫 사용) 던지는 에러
function isMissingTable(e) {
  return /Invalid object name/i.test(e?.message || "");
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const action = String(req.query.action || "").toLowerCase();
  const idNum = parseInt(req.query.id, 10);
  const id = Number.isFinite(idNum) ? idNum : null;
  const q = String(req.query.q || "").trim();
  const isDelete = action === "delete" || req.method === "DELETE";

  let pool;
  try {
    pool = await sql.connect(getDbConfig());
  } catch (e) {
    // 연결 실패에도 항상 JSON (목록 화면이 깨지지 않도록 빈 배열 동봉)
    return res.status(200).json({
      ok: false, items: [], item: null,
      message: "DB 연결 실패: " + e.message, dbError: true
    });
  }

  try {
    // ── 삭제 ──
    if (isDelete) {
      if (!id) return res.status(400).json({ ok: false, message: "삭제할 id가 필요합니다." });
      const r = await pool.request()
        .input("id", sql.Int, id)
        .query("DELETE FROM cl_meetings WHERE id=@id");
      return res.status(200).json({ ok: true, deleted: id, affected: r.rowsAffected?.[0] ?? 0 });
    }

    // ── 상세 ──
    if (id) {
      const r = await pool.request()
        .input("id", sql.Int, id)
        .query(`SELECT ${COLS} FROM cl_meetings WHERE id=@id`);
      return res.status(200).json({ ok: true, item: r.recordset[0] || null });
    }

    // ── 검색 / 목록 ──
    let result;
    if (q) {
      result = await pool.request()
        .input("q", sql.NVarChar(300), `%${q}%`)
        .query(`SELECT TOP 50 ${COLS} FROM cl_meetings WHERE title LIKE @q ORDER BY id DESC`);
    } else {
      result = await pool.request()
        .query(`SELECT TOP 50 ${COLS} FROM cl_meetings ORDER BY id DESC`);
    }
    return res.status(200).json({ ok: true, items: result.recordset });
  } catch (e) {
    // 테이블이 아직 없으면 "기록 없음"으로 정상 처리
    if (isMissingTable(e)) {
      return res.status(200).json({ ok: true, items: [], item: null, note: "아직 저장된 회의록이 없습니다." });
    }
    return res.status(500).json({ ok: false, items: [], message: e.message });
  } finally {
    try { await pool.close(); } catch { /* noop */ }
  }
}
