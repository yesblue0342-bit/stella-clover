// api/_db.js - PostgreSQL(자체 호스팅, Ubuntu VM on OCI) 공유 풀 + mssql 호환 셰임 + 스키마 (ESM)
//
// ▣ 이전: Azure SQL (mssql). ▣ 현재: PostgreSQL (node-postgres `pg`).
// 소비자 코드는 mssql 스타일을 그대로 쓴다:
//     const pool = await getPool();
//     const r = await pool.request().input("id", sql.Int, id).query("SELECT * FROM t WHERE id=@id");
//     r.recordset / r.rowsAffected[0]
// 이 모듈의 셰임이 `@name` → `$1` 위치 파라미터로 변환하고, 결과를
// { recordset, rowsAffected, rowCount } 형태로 돌려준다. (mssql 타입(`sql.Int` 등)은 무시)
//
// 스키마 생성은 getPool() 안에서 콜드스타트당 1회(ensureSchema) 실행한다.
// → pg는 파라미터가 있는 쿼리에 여러 문장을 넣을 수 없으므로, 더 이상
//   각 쿼리 앞에 CREATE_TABLE 을 붙이지 않는다(붙이면 깨진다).

import pg from "pg";
import { toPositional, sql } from "./_sqlshim.js";
const { Pool } = pg;

// int8(bigint, type OID 20)을 JS Number로 파싱. node-postgres 기본은 문자열 반환이라
// job_id(BIGSERIAL)가 RETURNING/SELECT 경로에서 string ↔ number 불일치를 일으킨다.
// transcribe_jobs.job_id 는 2^53 을 넘을 일이 없어 안전. (SQL NULL 은 파서를 거치지 않음)
pg.types.setTypeParser(20, v => (v == null ? v : parseInt(v, 10)));

// mssql 호환 타입 토큰 재노출 (예: sql.NVarChar(sql.MAX))
export { sql };

let rawPoolSingleton;     // 원본 pg.Pool (인스턴스당 1개)
let poolPromise;          // Promise<ShimPool> (스키마 보장 후 resolve)

// ── 연결 설정: DATABASE_URL 우선, 없으면 표준 PG* 변수 ──
export function hasDbConfig() {
  return !!(process.env.DATABASE_URL || process.env.PG_URL ||
            process.env.PGHOST || process.env.DB_HOST);
}

function buildConfig() {
  const url = process.env.DATABASE_URL || process.env.PG_URL;

  // SSL: 원격(OCI) Postgres는 보통 필요. PGSSL=disable 면 끈다. 미지정이면 드라이버 기본.
  const sslEnv = String(process.env.PGSSL || process.env.DB_SSL || "").toLowerCase();
  let ssl;
  if (["disable", "false", "off", "0"].includes(sslEnv)) ssl = false;
  else if (["require", "true", "on", "1"].includes(sslEnv)) ssl = { rejectUnauthorized: false };
  else ssl = undefined; // URL 의 sslmode 등 드라이버 기본에 위임

  const common = {
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 30000,
    // 콜드스타트/원격 지연 흡수. 호출 함수 maxDuration ≥ 60 권장.
    connectionTimeoutMillis: 30000,
  };

  if (url) {
    const cfg = { connectionString: url, ...common };
    if (ssl !== undefined) cfg.ssl = ssl;
    return cfg;
  }
  const cfg = {
    host: process.env.PGHOST || process.env.DB_HOST,
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    database: process.env.PGDATABASE || process.env.DB_NAME,
    user: process.env.PGUSER || process.env.DB_USER,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
    ...common,
  };
  if (ssl !== undefined) cfg.ssl = ssl;
  return cfg;
}

function rawPool() {
  if (!rawPoolSingleton) {
    rawPoolSingleton = new Pool(buildConfig());
    // idle 클라이언트 오류로 서버리스 프로세스가 죽지 않게 흡수
    rawPoolSingleton.on("error", () => {});
  }
  return rawPoolSingleton;
}

// 인증/DB부재 오류는 재시도 무의미 → 즉시 중단. 연결/타임아웃만 재시도.
function isRetryable(err) {
  const code = err && err.code;
  // 28P01 invalid_password, 28000 invalid_authorization, 3D000 invalid_catalog(db없음)
  if (code === "28P01" || code === "28000" || code === "3D000") return false;
  const retry = ["ETIMEDOUT", "ETIMEOUT", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "EPIPE"];
  if (retry.includes(code)) return true;
  const msg = String((err && err.message) || "");
  return /timeout|connect|terminat|socket|ECONN|getaddrinfo/i.test(msg);
}

// ── mssql 호환 셰임 ──
class ShimRequest {
  constructor(pool) { this._pool = pool; this._params = {}; }
  // mssql: .input(name, type, value) | .input(name, value) 모두 허용. 타입은 무시.
  input(name, typeOrVal, maybeVal) {
    this._params[name] = (maybeVal === undefined) ? typeOrVal : maybeVal;
    return this;
  }
  async query(text) {
    const { text: sqlText, values } = toPositional(text, this._params);
    const r = await this._pool.query(sqlText, values);
    return { recordset: r.rows || [], rowsAffected: [r.rowCount || 0], rowCount: r.rowCount || 0 };
  }
}

function shimPool(pool) {
  return {
    request: () => new ShimRequest(pool),
    query: (text, params) => pool.query(text, params),
    _pg: pool,
  };
}

// ── 스키마 (PostgreSQL). 멱등: CREATE/ALTER ... IF NOT EXISTS. ──
// 파라미터 없는 다중 문장이므로 pg simple-query 로 안전하게 실행된다.

// 회의록 (전문 검색 인덱스)
export const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS cl_meetings (
    id SERIAL PRIMARY KEY,
    title VARCHAR(300),
    keywords VARCHAR(500),
    summary TEXT,
    transcript TEXT,
    transcript_chars INT,
    summary_chars INT,
    drive_file_id VARCHAR(200),
    drive_link VARCHAR(500),
    audio_file VARCHAR(300),
    audio_session VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS keywords VARCHAR(500);
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS summary TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS transcript TEXT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS transcript_chars INT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS summary_chars INT;
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS drive_file_id VARCHAR(200);
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS drive_link VARCHAR(500);
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_file VARCHAR(300);
  ALTER TABLE cl_meetings ADD COLUMN IF NOT EXISTS audio_session VARCHAR(100);
`;

// 백그라운드 전사 작업
export const CREATE_JOBS = `
  CREATE TABLE IF NOT EXISTS transcribe_jobs (
    job_id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(128),
    language VARCHAR(16),
    model VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'processing',
    chunks_total INT NOT NULL DEFAULT 0,
    chunks_done INT NOT NULL DEFAULT 0,
    chunk_refs TEXT,
    segments_json TEXT,
    speakers_json TEXT,
    summary_json TEXT,
    audio_ref TEXT,
    title VARCHAR(300),
    error_msg TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS segments_json TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS speakers_json TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS summary_json TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS audio_ref TEXT;
  ALTER TABLE transcribe_jobs ADD COLUMN IF NOT EXISTS title VARCHAR(300);
`;

// 워크스페이스(채팅/노트/프로젝트) — 기기 간 동기화의 단일 진실원천
export const CREATE_WORKSPACE = `
  CREATE TABLE IF NOT EXISTS ws_projects (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(200) NOT NULL,
    name VARCHAR(200) NOT NULL,
    color VARCHAR(20) DEFAULT '#1a4731',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ws_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(200) NOT NULL,
    project_id VARCHAR(36),
    title VARCHAR(500) DEFAULT '새 채팅',
    messages TEXT DEFAULT '[]',
    msg_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE ws_sessions ADD COLUMN IF NOT EXISTS project_id VARCHAR(36);
  ALTER TABLE ws_sessions ADD COLUMN IF NOT EXISTS msg_count INT DEFAULT 0;
  CREATE TABLE IF NOT EXISTS ws_notes (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(200) NOT NULL,
    title VARCHAR(500) DEFAULT '새 노트',
    content TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ix_ws_sessions_user ON ws_sessions(user_id);
  CREATE INDEX IF NOT EXISTS ix_ws_notes_user ON ws_notes(user_id);
  CREATE INDEX IF NOT EXISTS ix_ws_projects_user ON ws_projects(user_id);
`;

let schemaReady = false;
async function ensureSchema(pool, retries = 3, delay = 3000) {
  if (schemaReady) return;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(CREATE_TABLE);
      await pool.query(CREATE_JOBS);
      await pool.query(CREATE_WORKSPACE);
      schemaReady = true;
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 서버리스 인스턴스당 단일 풀 재사용 + 스키마 1회 보장.
export function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const pool = rawPool();
      await ensureSchema(pool);
      return shimPool(pool);
    })().catch(err => {
      poolPromise = undefined; // 실패 시 다음 요청에서 재시도
      throw err;
    });
  }
  return poolPromise;
}

// JSON 컬럼 안전 파싱
export function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v; // 혹시 드라이버가 이미 파싱한 경우
  try { const o = JSON.parse(v); return o == null ? fallback : o; } catch (e) { return fallback; }
}
