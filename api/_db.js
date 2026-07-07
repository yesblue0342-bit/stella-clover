// api/_db.js - OCI Postgres 공유 연결 풀 + 스키마 자동생성 (ESM)
//
// ※ Azure SQL / MSSQL 의존 제거 — OCI 우분투 서버(Docker)의 Postgres로 이관.
//   연결은 DATABASE_URL 우선(없으면 DB_SERVER/DB_NAME/DB_USER/DB_PASSWORD 조합으로 구성).
//   기존 호출부(워커/상태조회/watchdog)의 시그니처를 보존하기 위해 mssql 호환 셰임을 둔다:
//     getPool().request().input(name, type, value).query(tsql)  →  pg.Pool.query
//     r.recordset / r.rowsAffected[0] 그대로. 타입 인자(sql.Int 등)는 무시(마커).
//   쿼리 텍스트는 Postgres로 포팅됨(@name→$n 변환만 셰임이 담당; LIMIT/RETURNING/now() 등은 호출부에서 포팅).
import pg from "pg";

const { Pool, types } = pg;

// BIGINT(int8, OID 20) → Number 로 파싱(기존 mssql BigInt 동작 보존: Number(job_id) 비교/직렬화 무회귀).
//  안전 정수 범위를 넘으면 문자열 유지(데이터 손실 방지).
types.setTypeParser(20, v => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

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

function getUrl() {
  return firstEnv("DATABASE_URL", "POSTGRES_URL", "PG_URL");
}

// Azure SQL 호스트(*.database.windows.net)인가
function isAzureServer(server) {
  return /\.database\.windows\.net$/i.test(String(server || "").trim());
}

// 로컬/사설/컨테이너 호스트인가 — OCI 동거 Postgres(자체서명/평문 내부망)는 여기로 분류.
//  localhost·127.0.0.1·점 없는 컨테이너명(stella-postgres 등)·사설/CGNAT IPv4 대역.
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

// TLS 옵션 — 호스트 자동 판별. (mssql 시절 호환 시그니처 유지; db-config 테스트가 이 함수를 검증.)
//  공개 호스트=검증 유지, 로컬/사설/컨테이너=자체서명 허용. 환경변수로 오버라이드 가능.
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
  return firstEnv("DB_SERVER", "DB_HOST", "PGHOST", "SQL_SERVER", "CL_DB_SV").replace(/^tcp:/i, "").split(",")[0];
}

// pg SSL 옵션 결정. 기본 off(도커 내부망 평문). DATABASE_URL 에 sslmode=require 또는 DB_SSL 설정 시 on.
//  자체서명 허용이 기본(rejectUnauthorized:false); DB_SSL_VERIFY=true 면 검증 강제.
function resolveSsl(url, host) {
  const urlWantsSsl = /[?&]sslmode=(require|verify-ca|verify-full)/i.test(url || "");
  const explicit = envBool("DB_SSL", "PGSSL", "SQL_ENCRYPT");
  let on;
  if (explicit !== undefined) on = explicit;
  else if (urlWantsSsl) on = true;
  else on = false; // 내부망 기본 평문
  if (!on) return false;
  const verify = envBool("DB_SSL_VERIFY") === true
    || /[?&]sslmode=verify-(ca|full)/i.test(url || "");
  return { rejectUnauthorized: verify };
}

// pg.Pool 설정 구성. DATABASE_URL 우선, 없으면 개별 변수.
function getPoolConfig() {
  const url = getUrl();
  const base = {
    // 콜드 스타트/컨테이너 기동 대기 흡수.
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    query_timeout: 30000,
    statement_timeout: 30000,
    max: 5,
  };
  if (url) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
    return { ...base, connectionString: url, ssl: resolveSsl(url, host) };
  }
  const host = getServer();
  const database = firstEnv("DB_NAME", "DB_DATABASE", "PGDATABASE", "SQL_DATABASE", "CL_DB_NM");
  const user = firstEnv("DB_USER", "PGUSER", "SQL_USER", "CL_DB_USR");
  const password = firstEnv("DB_PASSWORD", "PGPASSWORD", "SQL_PASSWORD", "CL_DB_PW");
  const port = Number(firstEnv("DB_PORT", "PGPORT", "SQL_PORT") || 5432);

  const missing = [];
  if (!host) missing.push("DB_SERVER(또는 DATABASE_URL)");
  if (!database) missing.push("DB_NAME");
  if (!user) missing.push("DB_USER");
  if (!password) missing.push("DB_PASSWORD");
  if (missing.length) throw new Error("DB 환경변수 누락: " + missing.join(", ") + " (또는 DATABASE_URL 설정)");

  return { ...base, host, database, user, password, port, ssl: resolveSsl("", host) };
}

// DB 환경변수가 충분히 설정됐는지(라우트 가드용). 시크릿 값은 노출하지 않음.
//  DATABASE_URL 단독, 또는 DB_*/CL_DB_* 4종이 모두 있으면 true.
export function hasDbConfig() {
  if (getUrl()) return true;
  return !!(getServer() &&
    firstEnv("DB_NAME", "DB_DATABASE", "PGDATABASE", "SQL_DATABASE", "CL_DB_NM") &&
    firstEnv("DB_USER", "PGUSER", "SQL_USER", "CL_DB_USR") &&
    firstEnv("DB_PASSWORD", "PGPASSWORD", "SQL_PASSWORD", "CL_DB_PW"));
}

// 인증 오류(로그인 실패)는 재시도해도 소용없으므로 즉시 중단.
// 타임아웃/연결 오류(컨테이너 기동·콜드스타트 대기)만 재시도 대상.
function isRetryable(err) {
  const code = String((err && err.code) || "");
  // Postgres 인증/권한 실패(28xxx, 3D000 등)는 재시도 무의미.
  if (/^28/.test(code) || code === "3D000" || code === "ELOGIN") return false;
  const retryCodes = ["ETIMEDOUT", "ETIMEOUT", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "EPIPE", "57P03"];
  if (retryCodes.includes(code)) return true;
  const msg = String((err && err.message) || "");
  return /timeout|failed to connect|connection terminated|socket hang up|getaddrinfo|the database system is starting up|econn/i.test(msg);
}

// ── mssql 호환 셰임 ──────────────────────────────────────────────
// request().input(name,[type],value).query(tsql) → @name 을 $n 으로 변환 후 pg 실행.
//  타입 인자(sql.Int 등)는 마커이므로 무시. 동일 이름 반복은 동일 $n 재사용.
class ShimRequest {
  constructor(pgPool) { this._pg = pgPool; this._params = Object.create(null); }
  // .input(name, type, value)  또는  .input(name, value)
  input(name, typeOrValue, maybeValue) {
    const value = (arguments.length >= 3) ? maybeValue : typeOrValue;
    this._params[name] = value;
    return this;
  }
  async query(text) {
    const map = new Map();   // name → $n
    const values = [];
    const converted = String(text).replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
      if (!map.has(name)) map.set(name, values.push(this._params[name]));
      return "$" + map.get(name);
    });
    const res = await this._pg.query(converted, values);
    // mssql 호환: recordset(=rows), rowsAffected[0](=rowCount).
    return { recordset: res.rows || [], rowsAffected: [res.rowCount || 0], rowCount: res.rowCount || 0 };
  }
}

// (export: 단위 테스트에서 가짜 pg 풀을 주입해 @name→$n 변환을 검증.)
export function makeShimPool(pgPool) {
  return {
    _pg: pgPool,
    request() { return new ShimRequest(pgPool); },
    // 풀 수준 직접 쿼리(파라미터 없이 멀티스테이트먼트 DDL 등).
    query(text, params) { return pgPool.query(text, params); },
    on(...a) { pgPool.on(...a); return this; },
    end() { return pgPool.end(); },
  };
}

// 기동 대기 확보: 스키마 보장 쿼리로 실제 커넥션을 강제. 최대 3회, 시도 간 3초.
async function connectWithRetry(retries = 3, delay = 3000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const pgPool = new Pool(getPoolConfig());
    try {
      await ensureSchema(pgPool);
      return makeShimPool(pgPool);
    } catch (err) {
      lastErr = err;
      try { await pgPool.end(); } catch { /* ignore */ }
      if (!isRetryable(err) || i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 프로세스당 단일 풀 재사용. 풀이 죽으면(error) 캐시를 비워 자가 치유.
export function getPool() {
  if (!poolPromise) {
    poolPromise = connectWithRetry()
      .then(pool => {
        pool.on("error", () => { poolPromise = undefined; });
        return pool;
      })
      .catch(err => { poolPromise = undefined; throw err; });
  }
  return poolPromise;
}

// ── 스키마 자동생성 (Postgres, 멱등) ─────────────────────────────
//  pg 단순 쿼리(파라미터 없음)는 멀티스테이트먼트 허용 → CREATE/INDEX를 한 번에.
//  (mssql 시절 매 쿼리에 ${CREATE_*} 프리픽스로 self-heal 하던 것을, getPool 보장으로 대체.)

// 회의록 메타+전문 검색 테이블.
export const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS cl_meetings (
    id BIGSERIAL PRIMARY KEY,
    title TEXT,
    keywords TEXT,
    summary TEXT,
    transcript TEXT,
    transcript_chars INTEGER,
    summary_chars INTEGER,
    drive_file_id TEXT,
    drive_link TEXT,
    audio_file TEXT,
    audio_session TEXT,
    transcript_raw TEXT,
    audio_drive_id TEXT,
    audio_drive_link TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_cl_meetings_created_at ON cl_meetings (created_at);`;

// 백그라운드 전사 작업 테이블. JSON 컬럼은 항상 JSON.stringify로 쓰고 read 시 parseJson.
export const CREATE_JOBS = `
  CREATE TABLE IF NOT EXISTS transcribe_jobs (
    job_id BIGSERIAL PRIMARY KEY,
    user_id TEXT,
    language TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    chunks_total INTEGER NOT NULL DEFAULT 0,
    chunks_done INTEGER NOT NULL DEFAULT 0,
    chunk_refs TEXT,
    segments_json TEXT,
    speakers_json TEXT,
    summary_json TEXT,
    audio_ref TEXT,
    title TEXT,
    error_msg TEXT,
    session_id TEXT,
    source_name TEXT,
    file_date TEXT,
    user_instruction TEXT,
    transcript_raw TEXT,
    corrected_text TEXT,
    minutes_md TEXT,
    meeting_title TEXT,
    keywords TEXT,
    meeting_id BIGINT,
    audio_drive_id TEXT,
    audio_drive_link TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_transcribe_jobs_status ON transcribe_jobs (status);
  CREATE INDEX IF NOT EXISTS idx_transcribe_jobs_created_at ON transcribe_jobs (created_at);`;

// Stella Flow 메타데이터 테이블 (플로우차트/피규어). 실데이터는 Drive(stellagpt/flow), 여기는 메타+검색.
export const CREATE_FLOWS = `
  CREATE TABLE IF NOT EXISTS cl_flows (
    id BIGSERIAL PRIMARY KEY,
    title TEXT,
    source_type TEXT,
    mermaid TEXT,
    node_count INTEGER DEFAULT 0,
    edge_count INTEGER DEFAULT 0,
    drive_folder_id TEXT,
    drive_folder_link TEXT,
    drive_file_id TEXT,
    drive_link TEXT,
    user_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_cl_flows_created_at ON cl_flows (created_at);`;

// ★ 마이그레이션 가드: 프로그램이 개정되어 컬럼이 추가돼도 기존 테이블에 자동 반영되도록
//   idempotent 한 ADD COLUMN IF NOT EXISTS 를 매 기동 시 실행한다(옛 배포로 만든 테이블에 신규 컬럼 backfill).
//   → "프로그램 개정 후 이전 파일 안 보임 / SELECT 컬럼 없음" 회귀를 원천 차단. (데이터는 보존, 컬럼만 보강)
export const MIGRATE = `
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS title TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS keywords TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS summary TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS transcript TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS transcript_chars INTEGER;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS summary_chars INTEGER;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS drive_link TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_file TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_session TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS transcript_raw TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_drive_id TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_drive_link TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS title TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS audio_ref TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS error_msg TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS speakers_json TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS summary_json TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS session_id TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS source_name TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS file_date TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS user_instruction TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS transcript_raw TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS corrected_text TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS minutes_md TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS meeting_title TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS keywords TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS meeting_id BIGINT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS audio_drive_id TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS audio_drive_link TEXT;
  ALTER TABLE cl_flows ADD COLUMN IF NOT EXISTS user_id TEXT;`;

let schemaReady = false;
async function ensureSchema(pgPool) {
  if (schemaReady) return;
  await pgPool.query(CREATE_TABLE);
  await pgPool.query(CREATE_JOBS);
  await pgPool.query(CREATE_FLOWS);
  // 마이그레이션은 실패해도(권한/구버전 PG 등) 기동을 막지 않도록 개별 try — 신규 배포에선 no-op.
  try { await pgPool.query(MIGRATE); } catch (e) { console.warn("[db] 마이그레이션 스킵:", e && e.message); }
  schemaReady = true;
}

// JSON 컬럼 안전 파싱
export function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v; // 이미 파싱됨(방어)
  try { const o = JSON.parse(v); return o == null ? fallback : o; } catch (e) { return fallback; }
}

// mssql 호환 타입 마커. 모든 속성 접근은 호출 가능한 no-op 마커를 반환(값으로도, 함수로도 사용 가능).
//  예: sql.Int / sql.BigInt(값), sql.NVarChar(128) / sql.NVarChar(sql.MAX)(호출).
const _typeMarker = function typeMarker() { return _typeMarker; };
export const sql = new Proxy({}, { get() { return _typeMarker; } });
