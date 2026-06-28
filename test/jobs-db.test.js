// transcribe_jobs 통합 테스트 — 실제 Postgres 필요(DATABASE_URL). 미설정 시 전체 skip.
//   검증: 스키마 자동생성 / INSERT…RETURNING(CRUD) / chunks_done CAS 상태전이 /
//         재시작 복구 선택(processing·summarizing 만, done 제외) / DELETE 정리.
//   (실제 파이프라인(Drive·OpenAI)은 호출하지 않고 DB 계층만 검증한다.)
import { test, after } from "node:test";
import assert from "node:assert/strict";

const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL 미설정 — 통합 테스트 skip";

// getPool 은 프로세스당 단일 풀을 캐시하므로, 개별 테스트가 아닌 전체 종료 시 한 번만 닫는다.
after(async () => {
  if (SKIP) return;
  const { getPool } = await import("../api/_db.js");
  try { const pool = await getPool(); if (typeof pool.end === "function") await pool.end(); } catch { /* ignore */ }
});

test("transcribe_jobs: CRUD·CAS 상태전이·복구 선택", { skip: SKIP }, async () => {
  const { getPool, sql } = await import("../api/_db.js");
  const pool = await getPool();

  // CREATE — INSERT … RETURNING job_id (mssql OUTPUT INSERTED 대체)
  const refs = [{ id: "drive-x", ext: ".wav", durationSec: 120 }];
  const ins = await pool.request()
    .input("uid", sql.NVarChar(128), "itest-user")
    .input("lang", sql.NVarChar(16), "ko")
    .input("model", sql.NVarChar(64), "whisper-1")
    .input("refs", sql.NVarChar(sql.MAX), JSON.stringify(refs))
    .query(`INSERT INTO transcribe_jobs (user_id,language,model,status,chunks_total,chunks_done,chunk_refs,segments_json)
            VALUES (@uid,@lang,@model,'processing',1,0,@refs,'[]') RETURNING job_id`);
  const id = ins.recordset[0].job_id;
  assert.ok(Number.isInteger(id), "job_id 는 정수(BIGINT→Number 파서)");

  try {
    // READ
    const got = await pool.request().input("id", sql.BigInt, id)
      .query("SELECT * FROM transcribe_jobs WHERE job_id=@id");
    assert.equal(got.recordset.length, 1);
    assert.equal(got.recordset[0].status, "processing");
    assert.equal(got.recordset[0].chunks_total, 1);

    // CAS 전진 성공: chunks_done 이 기대값(0)일 때만
    const cas = await pool.request().input("id", sql.BigInt, id).input("cur", sql.Int, 0).input("next", sql.Int, 1)
      .query("UPDATE transcribe_jobs SET chunks_done=@next, updated_at=now() WHERE job_id=@id AND chunks_done=@cur");
    assert.equal(cas.rowsAffected[0], 1, "CAS 성공 → 1행");

    // CAS 재시도(이미 전진) → 0행 (동시 워커 중복 방지)
    const casDup = await pool.request().input("id", sql.BigInt, id).input("cur", sql.Int, 0).input("next", sql.Int, 9)
      .query("UPDATE transcribe_jobs SET chunks_done=@next WHERE job_id=@id AND chunks_done=@cur");
    assert.equal(casDup.rowsAffected[0], 0, "CAS 중복 → 0행");

    // 복구 선택: processing/summarizing 만 대상
    await pool.request().input("id", sql.BigInt, id)
      .query("UPDATE transcribe_jobs SET status='summarizing', updated_at=now() WHERE job_id=@id");
    const rec = await pool.request()
      .query("SELECT job_id FROM transcribe_jobs WHERE status IN ('processing','summarizing')");
    assert.ok(rec.recordset.some(r => Number(r.job_id) === Number(id)), "summarizing 은 복구 대상");

    await pool.request().input("id", sql.BigInt, id)
      .query("UPDATE transcribe_jobs SET status='done', updated_at=now() WHERE job_id=@id");
    const rec2 = await pool.request()
      .query("SELECT job_id FROM transcribe_jobs WHERE status IN ('processing','summarizing')");
    assert.ok(!rec2.recordset.some(r => Number(r.job_id) === Number(id)), "done 은 복구 대상 제외");
  } finally {
    // DELETE 정리
    await pool.request().input("id", sql.BigInt, id)
      .query("DELETE FROM transcribe_jobs WHERE job_id=@id");
  }
});

test("cl_meetings: 멱등 INSERT(같은 audio_session 중복 방지)", { skip: SKIP }, async () => {
  const { getPool, sql } = await import("../api/_db.js");
  const pool = await getPool();
  const sess = "itest-sess-001";
  const doInsert = () => pool.request()
    .input("title", sql.NVarChar(300), "통합 테스트 회의록")
    .input("keywords", sql.NVarChar(500), "kw")
    .input("summary", sql.NVarChar(sql.MAX), "요약")
    .input("transcript", sql.NVarChar(sql.MAX), "전사")
    .input("tc", sql.Int, 2).input("sc", sql.Int, 2)
    .input("fid", sql.NVarChar(200), "").input("link", sql.NVarChar(500), "")
    .input("audio", sql.NVarChar(300), "a.wav").input("asession", sql.NVarChar(100), sess)
    .query(`INSERT INTO cl_meetings (title,keywords,summary,transcript,transcript_chars,summary_chars,drive_file_id,drive_link,audio_file,audio_session)
            SELECT @title,@keywords,@summary,@transcript,@tc,@sc,@fid,@link,@audio,@asession
            WHERE @asession = '' OR NOT EXISTS (SELECT 1 FROM cl_meetings WHERE audio_session=@asession)`);
  try {
    await pool.request().input("s", sql.NVarChar(100), sess).query("DELETE FROM cl_meetings WHERE audio_session=@s");
    const r1 = await doInsert();
    assert.equal(r1.rowsAffected[0], 1, "첫 INSERT 성공");
    const r2 = await doInsert();
    assert.equal(r2.rowsAffected[0], 0, "같은 session 재삽입은 0행(멱등)");
    const cnt = await pool.request().input("s", sql.NVarChar(100), sess)
      .query("SELECT COUNT(*)::int AS n FROM cl_meetings WHERE audio_session=@s");
    assert.equal(cnt.recordset[0].n, 1);
  } finally {
    await pool.request().input("s", sql.NVarChar(100), sess).query("DELETE FROM cl_meetings WHERE audio_session=@s");
  }
});
