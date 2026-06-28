// api/_db.js - SQL Server 공유 연결 풀 + 테이블 정의 (ESM)
//
// ※ Vercel/Azure 서버리스 의존 제거 — OCI 우분투 서버(Docker)에서 구동.
//   DB는 OCI 동거 MSSQL 컨테이너(stella-mssql, 자체서명 TLS) 또는 기존 Azure SQL 모두 지원.
//   TLS는 호스트로 자동 판별: 컨테이너/사설망=자체서명 허용, Azure(*.database.windows.net)=검증 유지.
//   환경변수: DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD (별칭으로 기존 CL_DB_* 도 그대로 인식).
import sql from "mssql";

let poolPromise;

function firstEnv(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

// env 불리언: 미설정이면 undefined, 설정되면 true/false.
function envBool(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== "") return /^(1|true|yes|on)$/i.test(String(v).trim());
  }
  return undefined;
}

// Azure SQL 호스트(*.database.windows.net)인가
function isAzureServer(server) {
  return /\.database\.windows\.net$/i.test(String(server || "").trim());
}

// 로컬/사설/컨테이너 호스트인가 — OCI 동거 MSSQL(자체서명)은 여기로 분류.
//  localhost·127.0.0.1·점 없는 컨테이너명(stella-mssql 등)·사설/CGNAT IPv4 대역.
function isLocalOrPrivateServer(server) {
  const s = String(server || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "localhost" || s === "127.0.0.1" || s === "::1") return true;
  if (!s.includes(".")) return true;                         // 컨테이너/내부 호스트명
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true; // Tailscale/CGNAT
  return false;
}

// TLS 옵션 — 호스트 자동 판별, 환경변수(DB_ENCRYPT / DB_TRUST_SERVER_CERT)로 오버라이드 가능.
export function resolveTlsOptions(server) {
  const azure = isAzureServer(server);
  const local = isLocalOrPrivateServer(server);

  let encrypt = true;
  let trustServerCertificate = azure ? false : local ? true : false;

  const encOverride = envBool("DB_ENCRYPT", "SQL_ENCRYPT");
  if (encOverride !== undefined) encrypt = encOverride;
  const trustOverride = envBool("DB_TRUST_SERVER_CERT", "DB_TRUST_CERT", "SQL_TRUST_SERVER_CERTIFICATE");
  if (trustOverride !== undefined) trustServerCertificate = trustOverride;

  return { encrypt, trustServerCertificate, enableArithAbort: true };
}

function getServer() {
  return firstEnv("DB_SERVER", "SQL_SERVER", "CL_DB_SV").replace(/^tcp:/i, "").split(",")[0];
}

function getConfig() {
  const server = getServer();
  const database = firstEnv("DB_NAME", "DB_DATABASE", "SQL_DATABASE", "CL_DB_NM");
  const user = firstEnv("DB_USER", "SQL_USER", "CL_DB_USR");
  const password = firstEnv("DB_PASSWORD", "SQL_PASSWORD", "CL_DB_PW");
  const port = Number(firstEnv("DB_PORT", "SQL_PORT") || 1433);

  const missing = [];
  if (!server) missing.push("DB_SERVER(CL_DB_SV)");
  if (!database) missing.push("DB_NAME(CL_DB_NM)");
  if (!user) missing.push("DB_USER(CL_DB_USR)");
  if (!password) missing.push("DB_PASSWORD(CL_DB_PW)");
  if (missing.length) throw new Error("DB 환경변수 누락: " + missing.join(", "));

  return {
    server, database, user, password, port,
    options: resolveTlsOptions(server),
    // 콜드 스타트/컨테이너 기동 대기 흡수: 30초.
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };
}

// DB 환경변수가 충분히 설정됐는지(라우트 가드용). 시크릿 값은 노출하지 않음.
export function hasDbConfig() {
  return !!(getServer() && firstEnv("DB_NAME", "DB_DATABASE", "SQL_DATABASE", "CL_DB_NM") &&
            firstEnv("DB_USER", "SQL_USER", "CL_DB_USR") && firstEnv("DB_PASSWORD", "SQL_PASSWORD", "CL_DB_PW"));
}

// 인증 오류(로그인 실패)는 재시도해도 소용없으므로 즉시 중단.
// 타임아웃/연결 오류(컨테이너 기동·콜드스타트 대기)만 재시도 대상.
function isRetryable(err) {
  const code = (err && (err.code || (err.originalError && err.originalError.code))) || "";
  const num = (err && (err.number || (err.originalError && err.originalError.number))) || 0;
  if (code === "ELOGIN" || num === 18456) return false; // 로그인 실패 재시도 금지
  const retryCodes = ["ETIMEOUT", "ETIMEDOUT", "ESOCKET", "ECONNCLOSED", "ECONNREFUSED", "EHOSTUNREACH", "ENOTOPEN", "ENOTFOUND"];
  if (retryCodes.includes(code)) return true;
  const msg = String((err && err.message) || "");
  return /timeout|failed to connect|socket hang up|getaddrinfo|connection is closed/i.test(msg);
}

// 기동 대기 확보: 최대 3회, 시도 간 3초. 인증 오류는 즉시, 마지막 실패도 throw.
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

// 프로세스당 단일 풀 재사용. 풀이 죽으면(error/close) 캐시를 비워 자가 치유.
export function getPool() {
  if (!poolPromise) {
    poolPromise = connectWithRetry()
      .then(pool => {
        if (pool && typeof pool.on === "function") {
          pool.on("error", () => { poolPromise = undefined; });
          pool.on("close", () => { poolPromise = undefined; });
        }
        return pool;
      })
      .catch(err => { poolPromise = undefined; throw err; });
  }
  return poolPromise;
}

// cl_meetings 테이블 보장 (멱등). ALTER ADD 가드로 스키마 드리프트에도 SELECT가 깨지지 않게 한다.
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
