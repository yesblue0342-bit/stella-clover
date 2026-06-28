// api/cleanup.js - 보존기간(10일) 지난 오디오 청크 자동 삭제.
//   OCI 서버(server.mjs)가 매일 1회 내부 스케줄러로 호출한다(과거 Vercel Cron 대체).
//   수동 호출도 가능(POST/GET /api/cleanup). CRON_SECRET 설정 시 외부 호출은 Bearer 검증.
//
// ★ 청크는 이제 로컬 디스크가 기본(chunkStore) → 로컬 정리가 주(主). Drive Audio 폴더 정리는
//   레거시 잔여분 대상의 베스트에포트(인증 실패해도 cleanup 전체를 실패시키지 않음).
import { getDrive, ensurePath, deleteOlderThan } from "./_drive.js";
import { cleanupOlderThan } from "../lib/chunkStore.js";

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

  // 1) 로컬 청크 정리(주). 실패해도 응답은 JSON 으로.
  let localDeleted = 0, localError = null;
  try { localDeleted = await cleanupOlderThan(RETENTION_DAYS); }
  catch (e) { localError = e.message; }

  // 2) 레거시 Drive Audio 폴더 정리(베스트에포트). 미설정/인증오류면 조용히 스킵.
  let driveDeleted = 0, driveError = null;
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      const drive = getDrive();
      const audioFolderId = await ensurePath(drive, ["Audio"]);
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      driveDeleted = await deleteOlderThan(drive, audioFolderId, cutoff);
    } catch (e) { driveError = e.message; }
  }

  return res.status(200).json({
    ok: true, localDeleted, driveDeleted, retentionDays: RETENTION_DAYS,
    warnings: (localError || driveError) ? { localError, driveError } : undefined,
  });
}
