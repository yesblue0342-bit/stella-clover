// api/cleanup.js - 크론(OCI crontab 등이 주기 호출):
//   1) 10일 지난 오디오 파일 삭제(Google Drive)
//   2) 멈춘 전사 잡 재시동(워치독) — status가 processing/summarizing 인데 N분 갱신 없으면 worker 재트리거
//   OCI 예) 0 18 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<도메인>/api/cleanup
import { getDrive, ensurePath, deleteOlderThan } from "./_drive.js";
import { getPool, sql, hasDbConfig } from "./_db.js";

export const config = { maxDuration: 60 };

const RETENTION_DAYS = 10;
const STUCK_MINUTES = 10; // 이 시간 이상 갱신 없는 잡을 '멈춤'으로 보고 재시동

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// 멈춘 전사 잡을 골라 worker 를 비차단 재트리거 (best-effort)
async function rekickStuckJobs(req) {
  if (!hasDbConfig()) return { skipped: "no-db" };
  const pool = await getPool();
  const r = await pool.request().input("m", sql.Int, STUCK_MINUTES)
    .query(`SELECT job_id FROM transcribe_jobs
            WHERE status IN ('processing','summarizing')
              AND updated_at < now() - make_interval(0,0,0,0,0,@m)
            ORDER BY job_id ASC LIMIT 20`);
  const ids = (r.recordset || []).map(x => x.job_id);
  const base = baseUrl(req);
  for (const id of ids) {
    try { fetch(`${base}/api/worker?id=${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {}); }
    catch (e) { /* best-effort */ }
  }
  return { rekicked: ids.length };
}

export default async function handler(req, res) {
  // 크론 인증: CRON_SECRET 설정 시 Authorization 헤더 검증 (스케줄러 무관)
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
  }

  const result = { ok: true };

  // 1) 오디오 정리 (Google Drive 설정 시) — best-effort
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      const drive = getDrive();
      const audioFolderId = await ensurePath(drive, ["Audio"]);
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      result.deleted = await deleteOlderThan(drive, audioFolderId, cutoff);
      result.cutoff = cutoff;
      result.retentionDays = RETENTION_DAYS;
    } catch (e) { result.audioError = e.message; }
  } else {
    result.audioSkipped = "Google Drive 미설정";
  }

  // 2) 멈춘 전사 잡 워치독 (DB 설정 시) — best-effort
  try { result.watchdog = await rekickStuckJobs(req); }
  catch (e) { result.watchdogError = e.message; }

  return res.status(200).json(result);
}
