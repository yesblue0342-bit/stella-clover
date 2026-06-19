// api/_db.js - Azure SQL 공유 연결 풀 + 테이블 정의 (ESM)
import sql from "mssql";

let poolPromise;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getConfig() {
  return {
    server: required("CL_DB_SV"),
    database: required("CL_DB_NM"),
    user: required("CL_DB_USR"),
    password: required("CL_DB_PW"),
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true
    },
    // Azure SQL 서버리스(auto-pause) 티어는 비활성 후 첫 연결 시 DB 재개(resume)에
    // 수십 초가 걸린다. 짧은 타임아웃이면 재개 전에 끊겨 실패하므로 30초로 상향.
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: {
      max: 3,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

// 인증 오류(로그인 실패)는 재시도해도 소용없으므로 즉시 중단.
// 타임아웃/연결 오류(특히 auto-pause DB 재개 대기)만 재시도 대상.
function isRetryable(err) {
  const code = (err && (err.code || (err.originalError && err.originalError.code))) || "";
  const num = (err && (err.number || (err.originalError && err.originalError.number))) || 0;
  // 로그인 실패(ELOGIN / SQL error 18456)는 재시도 금지
  if (code === "ELOGIN" || num === 18456) return false;
  const retryCodes = ["ETIMEOUT", "ETIMEDOUT", "ESOCKET", "ECONNCLOSED", "ECONNREFUSED", "EHOSTUNREACH", "ENOTOPEN"];
  if (retryCodes.includes(code)) return true;
  // 메시지 기반 폴백 (예: "Failed to connect ... in 30000ms")
  const msg = String((err && err.message) || "");
  return /timeout|failed to connect|socket hang up|getaddrinfo|connection is closed/i.test(msg);
}

// 일시정지된 DB가 깨어날 시간을 확보: 최대 3회, 시도 간 3초 대기.
// 재시도 불가(인증) 오류는 즉시, 마지막 시도 실패도 throw.
async function connectWithRetry(retries = 3, delay = 3000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await new sql.ConnectionPool(getConfig()).connect();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 서버리스 인스턴스당 단일 풀을 재사용한다.
// (요청마다 connect/close 하면 동시 요청 시 풀이 닫혀 오류가 난다.)
export function getPool() {
  if (!poolPromise) {
    poolPromise = connectWithRetry()
      .catch(err => {
        poolPromise = undefined; // 실패 시 다음 요청에서 재시도
        throw err;
      });
  }
  return poolPromise;
}

// cl_meetings 테이블 보장 (멱등). 실제 사용 스키마와 일치.
// ALTER ADD 가드로 스키마 드리프트(컬럼 누락)에도 SELECT가 깨지지 않게 한다.
export const CREATE_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='cl_meetings')
  CREATE TABLE cl_meetings (
    id INT IDENTITY PRIMARY KEY,
    title NVARCHAR(300), keywords NVARCHAR(500),
    summary NVARCHAR(MAX), transcript NVARCHAR(MAX),
    transcript_chars INT, summary_chars INT,
    drive_file_id NVARCHAR(200), drive_link NVARCHAR(500),
    audio_file NVARCHAR(300), audio_session NVARCHAR(100),
    created_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
  IF COL_LENGTH('cl_meetings','keywords') IS NULL ALTER TABLE cl_meetings ADD keywords NVARCHAR(500);
  IF COL_LENGTH('cl_meetings','summary') IS NULL ALTER TABLE cl_meetings ADD summary NVARCHAR(MAX);
  IF COL_LENGTH('cl_meetings','transcript') IS NULL ALTER TABLE cl_meetings ADD transcript NVARCHAR(MAX);
  IF COL_LENGTH('cl_meetings','transcript_chars') IS NULL ALTER TABLE cl_meetings ADD transcript_chars INT;
  IF COL_LENGTH('cl_meetings','summary_chars') IS NULL ALTER TABLE cl_meetings ADD summary_chars INT;
  IF COL_LENGTH('cl_meetings','drive_file_id') IS NULL ALTER TABLE cl_meetings ADD drive_file_id NVARCHAR(200);
  IF COL_LENGTH('cl_meetings','drive_link') IS NULL ALTER TABLE cl_meetings ADD drive_link NVARCHAR(500);
  IF COL_LENGTH('cl_meetings','audio_file') IS NULL ALTER TABLE cl_meetings ADD audio_file NVARCHAR(300);
  IF COL_LENGTH('cl_meetings','audio_session') IS NULL ALTER TABLE cl_meetings ADD audio_session NVARCHAR(100);`;

// 백그라운드 전사 작업 테이블 (B1). JSON 컬럼은 항상 JSON.stringify로 쓰고 read 시 try/catch 파싱.
export const CREATE_JOBS = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name='transcribe_jobs')
  CREATE TABLE transcribe_jobs (
    job_id BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id NVARCHAR(128),
    language NVARCHAR(16),
    model NVARCHAR(64),
    status NVARCHAR(32) NOT NULL DEFAULT 'processing',
    chunks_total INT NOT NULL DEFAULT 0,
    chunks_done INT NOT NULL DEFAULT 0,
    chunk_refs NVARCHAR(MAX),
    segments_json NVARCHAR(MAX),
    speakers_json NVARCHAR(MAX),
    summary_json NVARCHAR(MAX),
    audio_ref NVARCHAR(MAX),
    title NVARCHAR(300),
    error_msg NVARCHAR(MAX),
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 DEFAULT SYSUTCDATETIME()
  );
  IF COL_LENGTH('transcribe_jobs','segments_json') IS NULL ALTER TABLE transcribe_jobs ADD segments_json NVARCHAR(MAX);
  IF COL_LENGTH('transcribe_jobs','speakers_json') IS NULL ALTER TABLE transcribe_jobs ADD speakers_json NVARCHAR(MAX);
  IF COL_LENGTH('transcribe_jobs','summary_json') IS NULL ALTER TABLE transcribe_jobs ADD summary_json NVARCHAR(MAX);
  IF COL_LENGTH('transcribe_jobs','audio_ref') IS NULL ALTER TABLE transcribe_jobs ADD audio_ref NVARCHAR(MAX);
  IF COL_LENGTH('transcribe_jobs','title') IS NULL ALTER TABLE transcribe_jobs ADD title NVARCHAR(300);`;

// JSON 컬럼 안전 파싱 (B1: 파싱 버그 방지)
export function parseJson(v, fallback) {
  if (v == null) return fallback;
  try { const o = JSON.parse(v); return o == null ? fallback : o; } catch (e) { return fallback; }
}

export { sql };
