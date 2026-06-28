// _db.js 호스트 자동판별 TLS + hasDbConfig 회귀 (OCI 이관 검증)
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTlsOptions, hasDbConfig } from "../api/_db.js";

test("OCI 동거 컨테이너(stella-mssql)는 자체서명 허용", () => {
  const o = resolveTlsOptions("stella-mssql");
  assert.equal(o.encrypt, true);
  assert.equal(o.trustServerCertificate, true);
});

test("Azure SQL(*.database.windows.net)은 인증서 검증 유지", () => {
  const o = resolveTlsOptions("foo.database.windows.net");
  assert.equal(o.encrypt, true);
  assert.equal(o.trustServerCertificate, false);
});

test("사설 IP(10.x / 192.168.x / 172.16-31.x)는 자체서명 허용", () => {
  assert.equal(resolveTlsOptions("10.0.0.5").trustServerCertificate, true);
  assert.equal(resolveTlsOptions("192.168.1.10").trustServerCertificate, true);
  assert.equal(resolveTlsOptions("172.20.0.2").trustServerCertificate, true);
});

test("공개 호스트는 검증 유지(보수적)", () => {
  assert.equal(resolveTlsOptions("db.example.com").trustServerCertificate, false);
});

test("hasDbConfig: DATABASE_URL 단독 / DB_* / CL_DB_* 가 다 있으면 true, 없으면 false", () => {
  const keys = ["DATABASE_URL","POSTGRES_URL","PG_URL","DB_SERVER","DB_HOST","PGHOST","DB_NAME","DB_USER","DB_PASSWORD","DB_DATABASE","PGDATABASE","PGUSER","PGPASSWORD","SQL_SERVER","SQL_DATABASE","SQL_USER","SQL_PASSWORD","CL_DB_SV","CL_DB_NM","CL_DB_USR","CL_DB_PW"];
  const saved = {}; keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  try {
    assert.equal(hasDbConfig(), false, "env 없으면 false");
    process.env.DATABASE_URL = "postgresql://u:p@stella-postgres:5432/stella_clover";
    assert.equal(hasDbConfig(), true, "DATABASE_URL 단독으로 true");
    delete process.env.DATABASE_URL;
    process.env.DB_SERVER = "stella-postgres"; process.env.DB_NAME = "clover"; process.env.DB_USER = "stella"; process.env.DB_PASSWORD = "x";
    assert.equal(hasDbConfig(), true, "DB_* 다 있으면 true");
    delete process.env.DB_SERVER; delete process.env.DB_NAME; delete process.env.DB_USER; delete process.env.DB_PASSWORD;
    process.env.CL_DB_SV = "x.database.windows.net"; process.env.CL_DB_NM = "clover"; process.env.CL_DB_USR = "u"; process.env.CL_DB_PW = "p";
    assert.equal(hasDbConfig(), true, "CL_DB_* 별칭도 인식");
  } finally {
    keys.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
});
