// api/cleanup.js - 10일 지난 오디오 파일 자동 삭제 (Vercel Cron)
import { getDrive, ensurePath, deleteOlderThan } from "./_drive.js";

export const config = { maxDuration: 60 };

const RETENTION_DAYS = 10;

export default async function handler(req, res) {
  // Vercel Cron 인증: CRON_SECRET 설정 시 Authorization 헤더 검증
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
