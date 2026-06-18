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
    // mssql 기본 타임아웃(15s)이 Vercel 함수 한도를 넘기면 평문 에러가 반환된다.
    // 빠르게 실패하도록 줄여서 핸들러 try/catch가 항상 JSON을 돌려주게 한다.
    connectionTimeout: 10000,
    requestTimeout: 12000,
    pool: {
      max: 3,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

// 서버리스 인스턴스당 단일 풀을 재사용한다.
// (요청마다 connect/close 하면 동시 요청 시 풀이 닫혀 오류가 난다.)
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(getConfig())
      .connect()
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

export { sql };
