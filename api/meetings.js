// api/meetings.js - 회의록 목록 + 키워드 검색 + 상세
import { getPool, sql, CREATE_TABLE } from "./_db.js";

// connectionTimeout 30s + auto-pause 재개 재시도를 함수 한도 안에 수용하려면 여유 필요.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // 어떤 경로로 응답하든 JSON 헤더를 명시 (프런트 방어 파싱과 함께 평문 노출 방지)
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 목록/상세가 브라우저·CDN 캐시로 오래된 채 보이는 것(최신화 안 됨) 방지.
  res.setHeader("Cache-Control", "no-store, max-age=0");

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

    // 제목 변경 (✏️ 연필) — id + title. POST 권장(쿼리로도 허용).
    if (action === "rename") {
      const id = parseInt((req.body && req.body.id) ?? req.query.id, 10);
      const raw = (req.body && req.body.title) ?? req.query.title ?? "";
      const title = String(raw).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 300);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "잘못된 id" });
      if (!title) return res.status(400).json({ ok: false, message: "제목을 입력하세요" });
      const r = await pool.request().input("id", sql.Int, id).input("title", sql.NVarChar(300), title)
        .query(`${CREATE_TABLE} UPDATE cl_meetings SET title=@title WHERE id=@id`);
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
