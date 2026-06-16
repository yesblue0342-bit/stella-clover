// api/meetings.js - 회의 목록 조회
import sql from "mssql";

export const config = { maxDuration: 15 };

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

export default async function handler(req, res) {
  try {
    const pool = await sql.connect(getDbConfig());
    const result = await pool.request().query(`
      SELECT TOP 50 id, title, transcript_chars, summary_chars,
             drive_file_id, drive_link, audio_file, created_at
      FROM cl_meetings
      ORDER BY id DESC
    `);
    return res.status(200).json({ ok: true, items: result.recordset });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
