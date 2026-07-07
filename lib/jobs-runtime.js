// lib/jobs-runtime.js — 백그라운드 전사 워커 (OCI 인프로세스 런타임)
//
// ※ Vercel 함수모델(응답 후 종료) 의존 제거. OCI 우분투 서버는 장수 프로세스이므로
//   "한 청크 처리→HTTP 자기재호출" 대신 인프로세스 루프로 남은 단계를 끝까지 처리한다.
//   - DB(transcribe_jobs)에 진행률 영속 → 상태조회/재시작 복구 가능.
//   - chunks_done CAS 가드로 동시 워커(워치독·복구) 중복 처리 방지(멱등).
//   - 동시 실행 잡 수 상한(JOBS_CONCURRENCY, 기본 2) + 대기 큐 → OOM/과부하 방지.
//   - 한 청크 실패해도 전체 중단 안 함([구간 N 변환 실패] 표시 후 계속).
//
// ★ 전체 파이프라인이 서버에서 완결된다(창 닫힘과 무관):
//   preparing(ffmpeg 전처리·무음 분할) → processing(청크 STT) → correcting(LLM 교정)
//   → summarizing(화자/구조화 요약 + 회의록 생성 + cl_meetings 저장 + Drive 텍스트 백업)
//   → uploading(원본 오디오 Drive 보관, 지수 백오프 3회) → done. 각 단계는 산출물 컬럼으로
//   체크포인트 되어 서버 재시작 시 완료된 단계를 건너뛰고 이어서 진행한다(recover()).
import { getPool, sql, parseJson } from "../api/_db.js";
import { getDrive, downloadFileById, uploadFileStream } from "../api/_drive.js";
import { isLocalRef, readChunk, deleteSession, sessionOfRefs, findSource } from "./chunkStore.js";
import { prepareAudio } from "./audioPrep.js";
import { transcribeBuffer } from "../api/_stt.js";
import { labelSpeakers, structuredSummary } from "../api/_analyze.js";
import { correctTranscript } from "./transcriptFix.js";
import { generateMinutes, backupMinutesToDrive, saveMeetingRecord } from "./minutes.js";
import { dedupOverlapTokens } from "./sttMerge.js";
import fs from "fs";
import path from "path";

const MAX_CONCURRENT = Math.max(1, Number(process.env.JOBS_CONCURRENCY || 2));
const active = new Set();   // 현재 실행 중인 job_id
const queued = new Set();   // 대기 큐에 든 job_id (중복 enqueue 방지)
const waiting = [];         // 순서 보장용 배열

// ★ 원본 오디오 보관 Drive 폴더(사용자 지정). env 로 오버라이드 가능.
export const AUDIO_DRIVE_FOLDER_ID = process.env.DRIVE_AUDIO_FOLDER_ID || "1ap3oDMkYlTnK5YXI2yR0-ZiHlrgp-1r8";

// 종료되지 않은(=재개 대상) 상태 목록. jobs.js 목록/recover() 와 일치 유지.
export const ACTIVE_STATUSES = ["preparing", "processing", "correcting", "summarizing", "uploading"];

const AUDIO_MIME = { ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".mpga": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".aac": "audio/aac", ".wav": "audio/wav" };

// 앞 청크들의 누적 실제 길이 → 글로벌 타임라인 offset (A1). 순수 함수(단위 테스트 가능).
// (신규 ffmpeg 분할 refs 는 startSec 가 명시돼 있어 그것을 우선 사용 — 오버랩 반영 정확 타임라인.)
export function computeOffsetSec(refs, cur) {
  if (!Array.isArray(refs)) return 0;
  const r = refs[cur];
  if (r && Number.isFinite(Number(r.startSec))) return Number(r.startSec);
  return refs.slice(0, cur).reduce((a, x) => a + (Number(x && x.durationSec) || 0), 0);
}

// 큐에 넣고 펌프. 이미 실행/대기 중이면 무시(멱등). 외부(jobs.js POST·worker.js 워치독·복구)에서 호출.
export function kick(id) {
  const jid = Number(id);
  if (!Number.isInteger(jid)) return;
  if (active.has(jid) || queued.has(jid)) return;
  queued.add(jid);
  waiting.push(jid);
  pump();
}

function pump() {
  while (active.size < MAX_CONCURRENT && waiting.length) {
    const jid = waiting.shift();
    queued.delete(jid);
    active.add(jid);
    runJob(jid)
      .catch(() => { /* runJob 내부에서 이미 error 기록 */ })
      .finally(() => { active.delete(jid); pump(); });
  }
}

// 잡 상태/필드 부분 업데이트 헬퍼.
async function setJob(pool, id, fields) {
  const req = pool.request().input("id", sql.BigInt, id);
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields)) {
    const p = "p" + (i++);
    req.input(p, sql.NVarChar(sql.MAX), v);
    sets.push(`${k}=@${p}`);
  }
  await req.query(`UPDATE transcribe_jobs SET ${sets.join(", ")}, updated_at=now() WHERE job_id=@id`);
}

// 한 잡을 끝까지(전처리→전사→교정→회의록→원본 보관) 처리. 멱등/재진입 안전.
async function runJob(id) {
  let pool;
  try { pool = await getPool(); }
  catch (e) { console.warn("[jobs] DB 연결 실패 job", id, e && e.message); return; }

  try {
  // ── 0) preparing: 원본 → ffmpeg 전처리(loudnorm+16k mono+무음 분할) → chunk_refs ──
  {
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`SELECT status, session_id FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return;
    if (j.status === "preparing") {
      const sess = String(j.session_id || "");
      const src = sess ? await findSource(sess) : null;
      if (!src) {
        await setJob(pool, id, { status: "error", error_msg: "원본 파일을 찾을 수 없습니다(업로드 조립 실패 또는 정리됨). 다시 업로드해주세요." });
        return;
      }
      let prep;
      try {
        prep = await prepareAudio({ sessionId: sess, sourcePath: src });
      } catch (e) {
        await setJob(pool, id, { status: "error", error_msg: "오디오 전처리 실패: " + String(e.message || e).slice(0, 300) });
        return;
      }
      // CAS: 여전히 preparing 일 때만 전진(동시 워커 방어).
      const upd = await pool.request()
        .input("id", sql.BigInt, id)
        .input("refs", sql.NVarChar(sql.MAX), JSON.stringify(prep.refs))
        .input("ct", sql.Int, prep.refs.length)
        .query(`UPDATE transcribe_jobs SET status='processing', chunk_refs=@refs, chunks_total=@ct, updated_at=now()
                WHERE job_id=@id AND status='preparing'`);
      if (!upd.rowsAffected[0]) return; // 다른 워커가 이미 진행
    }
  }

  // ── 1) processing: 청크 STT 루프 ──
  // 매 반복마다 DB에서 cur를 다시 읽어 어디서 끊겨도 resume. CAS 실패 시 다른 워커가 잡았으므로 종료.
  let guard = 0;
  while (true) {
    if (guard++ > 100000) { console.warn("[jobs] guard 초과 job", id); return; }
    const r = await pool.request().input("id", sql.BigInt, id)
      .query(`SELECT * FROM transcribe_jobs WHERE job_id=@id`);
    const j = r.recordset[0];
    if (!j) return;
    if (j.status === "done" || j.status === "error") return;

    const refs = parseJson(j.chunk_refs, []);
    const total = j.chunks_total || refs.length;
    const cur = j.chunks_done || 0;

    if (cur >= total) break; // 모든 청크 완료 → 마무리로

    const ref = refs[cur];
    if (!ref || !ref.id) {
      await setJob(pool, id, { status: "error", error_msg: `청크 ref 누락(index ${cur})` });
      return;
    }

    const offsetSec = computeOffsetSec(refs, cur);
    const segs = parseJson(j.segments_json, []);
    const prevText = segs.length ? String(segs[segs.length - 1].text || "").slice(-200) : "";

    let result;
    try {
      // 로컬 청크(신규 기본)는 디스크에서 직접 읽고, 레거시 Drive ref(in-flight 잡)만 Drive 에서 내려받는다.
      const buffer = isLocalRef(ref.id)
        ? await readChunk(ref.id)
        : await downloadFileById(getDrive(), ref.id);
      result = await transcribeBuffer({ buffer, ext: ref.ext || ".wav", lang: j.language || "ko", model: j.model || "whisper-1", prevText, offsetSec });
    } catch (e) {
      // 이 청크만 실패 → 표시 세그먼트 넣고 계속(전체 중단 금지)
      result = { text: "", segments: [{ start: offsetSec, end: offsetSec, text: `[구간 ${cur + 1} 변환 실패: ${String(e.message || e).slice(0, 80)}]` }], duration: 0, hasTimestamps: false };
    }
    // 타임스탬프 미지원 모델(gpt-4o-*-transcribe)은 segments=[]·text만 반환 → text를 세그먼트로 합성(누락 방지).
    let rs = (result.segments && result.segments.length)
      ? result.segments
      : (result.text ? [{ start: offsetSec, end: offsetSec, text: result.text }] : []);
    // 오버랩 분할(ffmpeg 6초 겹침)의 경계 중복 텍스트 제거: 이전 누적 꼬리 vs 새 청크 머리(보수적 — 일치 시만 제거).
    if (rs.length && prevText) {
      const deduped = dedupOverlapTokens(prevText, String(rs[0].text || ""));
      if (deduped !== rs[0].text) {
        rs = deduped ? [{ ...rs[0], text: deduped }, ...rs.slice(1)] : rs.slice(1);
      }
    }
    const newSegs = segs.concat(rs);
    const next = cur + 1;
    // CAS 가드: chunks_done이 여전히 cur일 때만 전진 → 동시 워커 중복 방지(idempotent)
    const upd = await pool.request()
      .input("id", sql.BigInt, id)
      .input("cur", sql.Int, cur)
      .input("next", sql.Int, next)
      .input("seg", sql.NVarChar(sql.MAX), JSON.stringify(newSegs))
      .query("UPDATE transcribe_jobs SET chunks_done=@next, segments_json=@seg, updated_at=now() WHERE job_id=@id AND chunks_done=@cur");
    if (!upd.rowsAffected[0]) return; // 다른 워커가 이미 진행 → 양보
    // 다음 청크 계속(루프)
  }

  // ── 2) 마무리(교정→회의록→저장→원본 보관). 산출물 컬럼 체크포인트로 재시작 시 이어서. ──
  await finalizeJob(pool, id);
  } catch (e) {
    // 처리/마무리 중 예외 → 잡을 error로 마킹(요약 단계에서 멈춰 'summarizing'에 갇히는 회귀 방지).
    try {
      await pool.request().input("id", sql.BigInt, id).input("e", sql.NVarChar(sql.MAX), String((e && e.message) || e).slice(0, 1000))
        .query("UPDATE transcribe_jobs SET status='error', error_msg=@e, updated_at=now() WHERE job_id=@id AND status<>'done'");
    } catch (e2) { /* 에러 기록 실패는 무시 */ }
    console.warn("[jobs] 처리 오류 job", id, e && e.message);
  }
}

// 전사 완료 후 마무리 단계 전체. 각 단계는 산출물 존재 여부로 스킵(재시작 멱등).
async function finalizeJob(pool, id) {
  const read = async () => (await pool.request().input("id", sql.BigInt, id)
    .query(`SELECT * FROM transcribe_jobs WHERE job_id=@id`)).recordset[0];

  let j = await read();
  if (!j || j.status === "done" || j.status === "error") return;

  const lang = j.language || "ko";
  const segs = parseJson(j.segments_json, []);
  const raw = segs.map(s => s.text).join(" ").trim();
  const sess = String(j.session_id || "") || sessionOfRefs(parseJson(j.chunk_refs, [])) || "";

  // 전 구간 실패/무음이면 회의록을 만들 수 없다 — 명확한 실패로 마킹(임시 파일은 보존해 원인 확인 가능).
  if (!raw.replace(/\[구간 \d+ 변환 실패[^\]]*\]/g, "").trim()) {
    await setJob(pool, id, { status: "error", error_msg: "음성에서 텍스트를 추출하지 못했습니다(무음 또는 전 구간 변환 실패)." });
    return;
  }

  // 2-1) correcting: LLM 교정 1패스(용어 사전 참조, 교정만). 원문(raw)과 교정본을 둘 다 저장.
  if (!j.corrected_text) {
    await setJob(pool, id, { status: "correcting" });
    let corrected = raw, failedWindows = 0;
    try {
      const fix = await correctTranscript(raw);
      corrected = fix.corrected || raw;
      failedWindows = fix.failedWindows;
      if (failedWindows) console.warn(`[jobs] 교정 창 ${failedWindows}개 실패(원문 유지) job`, id);
    } catch (e) {
      console.warn("[jobs] LLM 교정 실패(원문으로 진행) job", id, e && e.message);
    }
    await setJob(pool, id, { transcript_raw: raw, corrected_text: corrected });
    j = await read();
  }
  const transcript = String(j.corrected_text || raw);

  // 2-2) summarizing: 화자/구조화 요약 + 회의록 생성(서버에서 — 창 닫힘과 무관).
  await pool.request().input("id", sql.BigInt, id)
    .query(`UPDATE transcribe_jobs SET status='summarizing', updated_at=now() WHERE job_id=@id AND status<>'done'`);
  if (!parseJson(j.summary_json, null)) {
    let speakers = [], summary = null;
    try { speakers = await labelSpeakers(segs); } catch (e) { speakers = []; }
    try { summary = await structuredSummary(transcript, lang); } catch (e) { summary = null; }
    await setJob(pool, id, { speakers_json: JSON.stringify(speakers), summary_json: summary ? JSON.stringify(summary) : null });
  }
  if (!j.minutes_md) {
    const minutes = await generateMinutes({
      transcript,
      lang,
      audioFileName: j.source_name || "",
      fileDate: j.file_date || "",
      userInstruction: j.user_instruction || "",
    }); // 실패 시 throw → runJob 이 error 마킹(다음 kick 에서 재시도 가능)
    await setJob(pool, id, { minutes_md: minutes.summary, meeting_title: minutes.title, keywords: minutes.keywords });
    j = await read();
  }

  // 2-3) 이력 저장(cl_meetings) + Drive 텍스트 백업(베스트에포트). audio_session 멱등 가드.
  if (!j.meeting_id) {
    const bk = await backupMinutesToDrive({
      summary: j.minutes_md, transcript, title: j.meeting_title || j.title,
      keywords: j.keywords || "", audioFileName: j.source_name || "", audioSession: sess,
    });
    if (bk.driveError) console.warn("[jobs] 회의록 Drive 백업 실패(계속 진행) job", id, bk.driveError);
    const sv = await saveMeetingRecord({
      title: j.meeting_title || j.title, keywords: j.keywords || "", summary: j.minutes_md,
      transcript, transcriptRaw: j.transcript_raw || raw,
      driveFileId: bk.driveFileId || "", driveLink: bk.driveLink || "",
      audioFileName: j.source_name || "", audioSession: sess,
    });
    if (!sv.meetingId) {
      // 이력(cl_meetings)은 결과의 주 저장소 — 저장 실패를 통과시키면 잡이 done 이 되면서
      // 회의록이 이력에서 영영 사라진다(회의록 본문은 잡 레코드에만 잔존). Drive 보관 실패와
      // 동일하게 잡을 error 로 남겨 '다시 시도'(retry=1)가 이 단계부터 재실행되게 한다
      // (minutes_md 체크포인트가 있어 회의록 재생성 없이 저장만 재시도).
      await setJob(pool, id, {
        status: "error",
        error_msg: "회의록 이력 저장 실패(다시 시도 가능): " + String(sv.dbError || "원인 미상").slice(0, 300),
      });
      return;
    }
    await setJob(pool, id, { meeting_id: String(sv.meetingId) });
    j = await read();
  }

  // 2-4) uploading: 원본 오디오를 Drive 보관 폴더로(지수 백오프 3회). 성공 시에만 로컬 삭제.
  const srcPath = sess ? await findSource(sess) : null;
  // 신규 잡(session_id 보유=원본 업로드 잡)인데 원본이 없고 보관도 안 됐다면(예: 보관 실패 error 로
  // 방치돼 10일 정리가 원본을 삭제한 뒤 재시도) — done 으로 은폐하지 말고 유실을 명시적으로 남긴다.
  if (!srcPath && !j.audio_drive_id && String(j.session_id || "")) {
    await setJob(pool, id, {
      status: "error",
      error_msg: "원본 오디오가 보존기간(10일) 경과로 삭제되어 Drive 보관이 불가합니다(회의록/이력은 저장됨).",
    });
    return;
  }
  if (srcPath && !j.audio_drive_id) {
    await setJob(pool, id, { status: "uploading" });
    let uploaded = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !uploaded; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1))); // 2s, 4s
      try {
        const drive = getDrive();
        const ext = path.extname(srcPath).toLowerCase();
        const base = (j.source_name && String(j.source_name).replace(/[\\/:*?"<>|]/g, "").trim()) || `recording${ext}`;
        const stamp = new Date(new Date(j.created_at || Date.now()).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1_$2");
        uploaded = await uploadFileStream(drive, AUDIO_DRIVE_FOLDER_ID, `${stamp}_${base}`, AUDIO_MIME[ext] || "application/octet-stream", fs.createReadStream(srcPath));
      } catch (e) { lastErr = e; }
    }
    if (!uploaded) {
      // 태스크 규칙: 재시도 후에도 실패하면 잡을 실패 처리, 임시 파일 보존 + 사유 기록.
      // (회의록/이력은 위에서 이미 저장됨 — 데이터 유실 없음. 다음 kick/워치독이 이 단계부터 재시도.)
      await setJob(pool, id, {
        status: "error",
        error_msg: "원본 오디오 Drive 보관 실패(회의록은 저장됨): " + String((lastErr && lastErr.message) || lastErr).slice(0, 300),
      });
      return;
    }
    const link = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;
    await setJob(pool, id, { audio_drive_id: uploaded.id, audio_drive_link: link });
    // cl_meetings 레코드에도 원본 링크 반영(나중에 이력에서 원본 재생/열기).
    try {
      if (j.meeting_id) {
        await pool.request().input("mid", sql.BigInt, j.meeting_id)
          .input("adid", sql.NVarChar(200), uploaded.id)
          .input("adlink", sql.NVarChar(500), link)
          .query(`UPDATE cl_meetings SET audio_drive_id=@adid, audio_drive_link=@adlink WHERE id=@mid`);
      }
    } catch (e) { console.warn("[jobs] cl_meetings 원본 링크 반영 실패(무시) job", id, e && e.message); }
  }

  // 2-5) done + 로컬 임시(청크/원본) 즉시 삭제 — OCI 디스크 용량 관리.
  //  · 신규 잡: 원본 Drive 보관 성공이 확인된 뒤에만 여기 도달(위에서 실패 시 return).
  //  · 레거시 잡(원본 없음): 기존 정책 그대로 청크만 삭제.
  await pool.request().input("id", sql.BigInt, id)
    .query(`UPDATE transcribe_jobs SET status='done', updated_at=now() WHERE job_id=@id AND status<>'done'`);
  try {
    if (sess) { const n = await deleteSession(sess); if (n) console.log(`[jobs] 완료 후 로컬 정리 job ${id}: ${n}개 삭제(sess ${sess})`); }
  } catch (e) { /* 정리 실패는 무시(일일 cleanup 이 백업으로 회수) */ }
}

// 워치독: 외부에서 한 잡을 강제로 다시 펌프(멱등). worker.js 엔드포인트가 사용.
export function watchdog(id) { kick(id); }

// 서버 부팅 시: DB에서 미완료 잡을 모두 다시 큐에 넣어 자동 재개(탭/서버 재시작 무관).
export async function recover() {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .query(`SELECT job_id FROM transcribe_jobs WHERE status IN ('${ACTIVE_STATUSES.join("','")}') ORDER BY job_id ASC`);
    const ids = (r.recordset || []).map(x => Number(x.job_id)).filter(Number.isInteger);
    ids.forEach(kick);
    if (ids.length) console.log(`[jobs] 부팅 복구: 미완료 잡 ${ids.length}건 재개`, ids.slice(0, 20));
    return ids.length;
  } catch (e) {
    console.warn("[jobs] 부팅 복구 실패(무시):", e && e.message);
    return 0;
  }
}

// 진단용 현재 상태(시크릿 없음).
export function runtimeStats() {
  return { maxConcurrent: MAX_CONCURRENT, active: active.size, queued: waiting.length };
}
