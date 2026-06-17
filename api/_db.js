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
    // Azure SQL 서버리스는 일시중지 상태에서 깨어나는 데 시간이 걸린다.
    // 함수 maxDuration(30s) 이내에 실패하도록 타임아웃을 잡아, 플랫폼이 함수를
    // 강제 종료(=Vercel 평문 "An error occurred…" 반환)하기 전에 catch가 JSON을 내려보내게 한다.
    connectionTimeout: 20000,
    requestTimeout: 20000,
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
  );`;

export { sql };
