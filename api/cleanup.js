// api/cleanup.js - 10일 지난 오디오 파일 자동 삭제.
//   OCI 서버(server.mjs)가 매일 1회 내부 스케줄러로 호출한다(과거 Vercel Cron 대체).
//   수동 호출도 가능(POST/GET /api/cleanup). CRON_SECRET 설정 시 외부 호출은 Bearer 검증.
import { getDrive, ensurePath, deleteOlderThan } from "./_drive.js";

const RETENTION_DAYS = 10;

export default async function handler(req, res) {
  // 외부에서 직접 호출하는 경우 CRON_SECRET 설정 시 Authorization 헤더 검증.
  // (server.mjs 내부 스케줄러는 req.headers.authorization 에 CRON_SECRET 을 넣어 호출.)
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
  }
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(200).json({ ok: false, message: "Google Drive 미설정" });
  }

  try {
    const drive = getDrive();
    const audioFolderId = await ensurePath(drive, ["Audio"]);
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await deleteOlderThan(drive, audioFolderId, cutoff);
    return res.status(200).json({ ok: true, deleted, cutoff, retentionDays: RETENTION_DAYS });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
