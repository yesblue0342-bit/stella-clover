// api/meetings.js - 회의록 목록 + 키워드 검색 + 상세
import { getPool, sql, CREATE_TABLE } from "./_db.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // 어떤 경우에도 valid JSON 으로 응답함을 보장 (프론트 r.json() 크래시 방지)
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!process.env.CL_DB_SV || !process.env.CL_DB_USR || !process.env.CL_DB_PW) {
    return res.status(200).json({ ok: false, items: [], message: "DB 환경변수 미설정 (CL_DB_USR/CL_DB_PW 확인)" });
  }

  const action = req.query.action || "list";

  try {
    const pool = await getPool();

    // 상세 조회
    if (action === "detail") {
      const id = parseInt(req.query.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "잘못된 id" });
      const r = await pool.request().input("id", sql.Int, id)
        .query(`${CREATE_TABLE} SELECT * FROM cl_meetings WHERE id=@id`);
      return res.status(200).json({ ok: true, item: r.recordset[0] || null });
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
      // LIKE 와일드카드(%, _, [) 를 리터럴로 이스케이프해 의도치 않은 매칭 방지
      const like = "%" + q.replace(/[%_\[]/g, m => "[" + m + "]") + "%";
      const r = await pool.request().input("q", sql.NVarChar(200), like)
        .query(`${CREATE_TABLE}
          SELECT TOP 50 id, title, keywords, transcript_chars, summary_chars,
                 drive_file_id, drive_link, audio_file, created_at
          FROM cl_meetings
          WHERE title LIKE @q OR keywords LIKE @q OR summary LIKE @q OR transcript LIKE @q
          ORDER BY id DESC`);
      return res.status(200).json({ ok: true, items: r.recordset || [] });
    }

    // 기본: 목록
    const r = await pool.request().query(`${CREATE_TABLE}
      SELECT TOP 50 id, title, keywords, transcript_chars, summary_chars,
             drive_file_id, drive_link, audio_file, created_at
      FROM cl_meetings ORDER BY id DESC`);
    return res.status(200).json({ ok: true, items: r.recordset || [] });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "DB 오류: " + e.message });
  }
}
