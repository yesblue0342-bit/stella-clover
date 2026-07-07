// api/audio.js - 저장된 음원을 스트리밍 (세그먼트 클릭 재생 + 보관 원본 재생).
//   · 로컬 청크(local: ref) → 디스크에서 직접(기본 경로).
//   · Drive id → 우리 데이터(transcribe_jobs.chunk_refs 레거시 청크, 또는 잡/회의록의 원본 보관
//     audio_drive_id)가 실제로 참조하는 id 만 허용한 뒤 Drive 에서 스트리밍.
//     (임의 id 를 그대로 Drive 로 넘기면 계정 권한으로 아무 파일이나 읽히는 confused-deputy → DB 화이트리스트로 차단.)
//   · 보관 원본(수십~수백 MB)은 버퍼에 통째로 올리지 않고 파이프 스트리밍.
import { getDrive } from "./_drive.js";
import { isLocalRef, readChunk } from "../lib/chunkStore.js";
import { getPool, sql, hasDbConfig } from "./_db.js";

const MIME = { ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".mpga": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".aac": "audio/aac", ".wav": "audio/wav" };
function mimeForRef(id) {
  const m = String(id).toLowerCase().match(/(\.[a-z0-9]{1,5})$/);
  return (m && MIME[m[1]]) || "audio/wav";
}

// Drive id 가 우리 데이터인지 검증(LIKE 인젝션 방지: id 는 [A-Za-z0-9_-] 만 허용 후 사용).
// 레거시 청크(chunk_refs) 또는 원본 보관(audio_drive_id, 잡/회의록) 중 하나에 있어야 허용.
async function isOwnedDriveId(id) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return false;
  if (!hasDbConfig()) return false;
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("pat", sql.NVarChar(220), `%"${id}"%`)
      .input("id", sql.NVarChar(200), id)
      .query(`
        SELECT 1 FROM transcribe_jobs WHERE chunk_refs LIKE @pat OR audio_drive_id=@id
        UNION ALL
        SELECT 1 FROM cl_meetings WHERE audio_drive_id=@id
        LIMIT 1`);
    return !!(r.recordset && r.recordset.length);
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  const id = String(req.query.id || "").trim();
  if (!id) { res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.status(400).json({ ok: false, message: "id 필요" }); }
  try {
    if (isLocalRef(id)) {
      const buf = await readChunk(id);
      res.setHeader("Content-Type", mimeForRef(id));
      res.setHeader("Accept-Ranges", "none");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Length", String(buf.length));
      return res.status(200).send(buf);
    }

    if (!(await isOwnedDriveId(id))) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(404).json({ ok: false, message: "오디오를 찾을 수 없습니다." });
    }
    // Drive 파일(레거시 청크 또는 보관 원본) — 메타로 타입/크기 확인 후 파이프 스트리밍(대용량 RAM 보호).
    const drive = getDrive();
    const meta = await drive.files.get({ fileId: id, fields: "mimeType,size,name", supportsAllDrives: true });
    const mime = (meta.data.mimeType && meta.data.mimeType.startsWith("audio/")) ? meta.data.mimeType : mimeForRef(meta.data.name || "");
    const dl = await drive.files.get({ fileId: id, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (meta.data.size) res.setHeader("Content-Length", String(meta.data.size));
    res.status(200);
    dl.data.on("error", () => { try { res.end(); } catch (e) {} });
    dl.data.pipe(res);
    return;
  } catch (e) {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json({ ok: false, message: "오디오 로드 실패: " + e.message });
    }
    try { res.end(); } catch (e2) {}
  }
}
