// api/audio.js - 저장된 음원(청크)을 스트리밍 (A3 세그먼트 클릭 재생).
//   · 로컬 청크(local: ref) → 디스크에서 직접(기본 경로).
//   · 레거시 Drive ref → 우리 잡(transcribe_jobs.chunk_refs)이 실제로 참조하는 id 만 허용한 뒤 Drive 에서.
//     (임의 id 를 그대로 Drive 로 넘기면 서비스 계정 권한으로 아무 파일이나 읽히는 confused-deputy → DB 화이트리스트로 차단.)
import { getDrive, downloadFileById } from "./_drive.js";
import { isLocalRef, readChunk } from "../lib/chunkStore.js";
import { getPool, sql, hasDbConfig } from "./_db.js";

const MIME = { ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".mpga": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".aac": "audio/aac", ".wav": "audio/wav" };
function mimeForRef(id) {
  const m = String(id).toLowerCase().match(/(\.[a-z0-9]{1,5})$/);
  return (m && MIME[m[1]]) || "audio/wav";
}

// 레거시 Drive id 가 우리 잡의 청크인지 검증(LIKE 인젝션 방지: id 는 [A-Za-z0-9_-] 만 허용 후 사용).
async function isOwnedDriveId(id) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return false;
  if (!hasDbConfig()) return false;
  try {
    const pool = await getPool();
    const r = await pool.request().input("pat", sql.NVarChar(220), `%"${id}"%`)
      .query(`SELECT 1 FROM transcribe_jobs WHERE chunk_refs LIKE @pat LIMIT 1`);
    return !!(r.recordset && r.recordset.length);
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  const id = String(req.query.id || "").trim();
  if (!id) { res.setHeader("Content-Type", "application/json; charset=utf-8"); return res.status(400).json({ ok: false, message: "id 필요" }); }
  try {
    let buf, mime;
    if (isLocalRef(id)) {
      buf = await readChunk(id); mime = mimeForRef(id);
    } else {
      if (!(await isOwnedDriveId(id))) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(404).json({ ok: false, message: "오디오를 찾을 수 없습니다." });
      }
      buf = await downloadFileById(getDrive(), id); mime = "audio/wav";
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: false, message: "오디오 로드 실패: " + e.message });
  }
}
