// api/meetings.js - 회의록 목록 + 키워드 검색 + 상세
import { getPool, sql, hasDbConfig } from "./_db.js";

// (Vercel maxDuration 제거 — OCI 서버는 시간 제한 없음)

export default async function handler(req, res) {
  // 어떤 경로로 응답하든 JSON 헤더를 명시 (프런트 방어 파싱과 함께 평문 노출 방지)
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 목록/상세가 브라우저·CDN 캐시로 오래된 채 보이는 것(최신화 안 됨) 방지.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (!hasDbConfig()) {
    return res.status(200).json({ ok: false, items: [], message: "DB 환경변수 미설정 (DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD 또는 CL_DB_* 확인)" });
  }

  const action = req.query.action || "list";

  try {
    const pool = await getPool();

    // 상세 조회
    if (action === "detail") {
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "잘못된 id" });
      const r = await pool.request().input("id", sql.Int, id)
        .query(`SELECT * FROM cl_meetings WHERE id=@id`);
      return res.status(200).json({ ok: true, item: r.recordset[0] || null });
    }

    // 제목 변경 (✏️ 연필) — id + title. POST 권장(쿼리로도 허용).
    if (action === "rename") {
      const id = parseInt((req.body && req.body.id) ?? req.query.id, 10);
      const raw = (req.body && req.body.title) ?? req.query.title ?? "";
      const title = String(raw).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 300);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "잘못된 id" });
      if (!title) return res.status(400).json({ ok: false, message: "제목을 입력하세요" });
      const r = await pool.request().input("id", sql.Int, id).input("title", sql.NVarChar(300), title)
        .query(`UPDATE cl_meetings SET title=@title WHERE id=@id`);
      if (!r.rowsAffected || !r.rowsAffected[0]) return res.status(200).json({ ok: false, message: "대상 회의록을 찾을 수 없습니다" });
      return res.status(200).json({ ok: true, id, title });
    }

    // 삭제
    if (action === "delete") {
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "잘못된 id" });
      await pool.request().input("id", sql.Int, id)
        .query(`DELETE FROM cl_meetings WHERE id=@id`);
      return res.status(200).json({ ok: true });
    }

    // 키워드 검색
    if (action === "search") {
      const q = (req.query.q || "").trim().slice(0, 100); // 길이 제한
      if (!q) { return res.status(200).json({ ok: true, items: [] }); }
      // ILIKE 와일드카드(%, _) 와 이스케이프 문자(\)를 백슬래시로 이스케이프해 의도치 않은 매칭 방지
      const like = "%" + q.replace(/[\\%_]/g, m => "\\" + m) + "%";
      const r = await pool.request().input("q", sql.NVarChar(200), like)
        .query(`
          SELECT id, title, keywords, transcript_chars, summary_chars,
                 drive_file_id, drive_link, audio_file, created_at
          FROM cl_meetings
          WHERE title ILIKE @q OR keywords ILIKE @q OR summary ILIKE @q OR transcript ILIKE @q
          ORDER BY id DESC LIMIT 200`);
      return res.status(200).json({ ok: true, items: r.recordset || [] });
    }

    // 기본: 목록 (이전 파일도 모두 보이도록 상한 상향 + offset 페이지네이션)
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const r = await pool.request().query(`
      SELECT id, title, keywords, transcript_chars, summary_chars,
             drive_file_id, drive_link, audio_file, created_at
      FROM cl_meetings ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);
    const items = r.recordset || [];
    return res.status(200).json({ ok: true, items, offset, limit, hasMore: items.length === limit });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "DB 오류: " + e.message });
  }
}
