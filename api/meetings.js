// api/meetings.js - 회의록 목록 + 키워드 검색 + 상세
import sql from "mssql";

export const config = { maxDuration: 15 };

function getDbConfig() {
  return {
    server: process.env.CL_DB_SV, database: process.env.CL_DB_NM,
    user: process.env.CL_DB_USR, password: process.env.CL_DB_PW,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 }
  };
}

const CREATE_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
  CREATE TABLE cl_meetings (
    id INT IDENTITY PRIMARY KEY,
    title NVARCHAR(300), keywords NVARCHAR(500),
    summary NVARCHAR(MAX), transcript NVARCHAR(MAX),
    transcript_chars INT, summary_chars INT,
    drive_file_id NVARCHAR(200), drive_link NVARCHAR(500),
    audio_file NVARCHAR(300), created_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );`;

export default async function handler(req, res) {
  if (!process.env.CL_DB_SV || !process.env.CL_DB_USR || !process.env.CL_DB_PW) {
    return res.status(200).json({ ok: false, items: [], message: "DB 환경변수 미설정 (CL_DB_USR/CL_DB_PW 확인)" });
  }

  const action = req.query.action || "list";

  try {
    const pool = await sql.connect(getDbConfig());

    // 상세 조회
    if (action === "detail") {
      const id = parseInt(req.query.id);
      const r = await pool.request().input("id", sql.Int, id)
        .query(`${CREATE_TABLE} SELECT * FROM cl_meetings WHERE id=@id`);
      await pool.close();
      return res.status(200).json({ ok: true, item: r.recordset[0] || null });
    }

    // 삭제
    if (action === "delete") {
      const id = parseInt(req.query.id);
      await pool.request().input("id", sql.Int, id)
        .query(`DELETE FROM cl_meetings WHERE id=@id`);
      await pool.close();
      return res.status(200).json({ ok: true });
    }

    // 키워드 검색
    if (action === "search") {
      const q = (req.query.q || "").trim();
      if (!q) { await pool.close(); return res.status(200).json({ ok: true, items: [] }); }
      const r = await pool.request().input("q", sql.NVarChar(200), `%${q}%`)
        .query(`${CREATE_TABLE}
          SELECT TOP 50 id, title, keywords, transcript_chars, summary_chars,
                 drive_file_id, drive_link, audio_file, created_at
          FROM cl_meetings
          WHERE title LIKE @q OR keywords LIKE @q OR summary LIKE @q OR transcript LIKE @q
          ORDER BY id DESC`);
      await pool.close();
      return res.status(200).json({ ok: true, items: r.recordset || [] });
    }

    // 기본: 목록
    const r = await pool.request().query(`${CREATE_TABLE}
      SELECT TOP 50 id, title, keywords, transcript_chars, summary_chars,
             drive_file_id, drive_link, audio_file, created_at
      FROM cl_meetings ORDER BY id DESC`);
    await pool.close();
    return res.status(200).json({ ok: true, items: r.recordset || [] });

  } catch (e) {
    return res.status(200).json({ ok: false, items: [], message: "DB 오류: " + e.message });
  }
}
