// 공통 DB 헬퍼 (ESM). 파일명이 _로 시작하므로 Vercel 라우트로 노출되지 않음.
import sql from 'mssql';

let poolPromise;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getConfig() {
  return {
    server: required('CL_DB_SV'),
    database: required('CL_DB_NM'),
    user: required('CL_DB_USR'),
    password: required('CL_DB_PW'),
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true
    },
    pool: {
      max: 3,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(getConfig());
  return poolPromise;
}

async function initDb() {
  const pool = await getPool();
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'cl_meetings')
    CREATE TABLE cl_meetings (
      id INT IDENTITY(1,1) PRIMARY KEY,
      project_name NVARCHAR(200) NULL,
      title NVARCHAR(300) NULL,
      participants NVARCHAR(500) NULL,
      transcript_chars INT NULL,
      summary_chars INT NULL,
      drive_folder_id NVARCHAR(200) NULL,
      transcript_file_id NVARCHAR(200) NULL,
      summary_file_id NVARCHAR(200) NULL,
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
  return pool;
}

export { sql, getPool, initDb };
export default { sql, getPool, initDb };
