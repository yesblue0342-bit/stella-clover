// Stella Clover — 독립 실행 서버(server.js) 부팅 스모크 테스트.
// node_modules 없이도 동작: server.js 는 node 빌트인만 import하고, api 핸들러는 요청 시 동적 import.
// 핵심 회귀 가드: /api/* 는 핸들러 로드/throw 어떤 경우에도 **항상 JSON** 으로 응답한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../server.js";

function req(port, pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", body }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function withServer(fn) {
  const server = createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  try { await fn(port); }
  finally { await new Promise((res) => server.close(res)); }
}

test("healthz: 200 JSON ok", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/healthz");
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    assert.equal(JSON.parse(r.body).ok, true);
  });
});

test("정적: GET / → index.html(text/html)", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/");
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.body, /Stella|<html|<!doctype/i);
  });
});

test("정적: workspace.html 서빙", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/workspace.html");
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
  });
});

test("알 수 없는 API → 404 JSON(평문 아님)", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/api/nope");
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
    assert.equal(JSON.parse(r.body).ok, false);
  });
});

test("공유 모듈/언더스코어 경로는 라우트 아님 → 404 JSON", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/api/_db");
    assert.equal(r.status, 404);
    assert.match(r.type, /application\/json/);
  });
});

test("★ 회귀: 실 핸들러(meetings)가 의존성 없어 로드 실패해도 /api 는 평문 아닌 JSON", async () => {
  await withServer(async (port) => {
    // node_modules(pg 등) 미설치 → import 실패 경로. 어댑터가 JSON 으로 감싸야 함.
    const r = await req(port, "/api/meetings", "GET");
    assert.match(r.type, /application\/json/, "Content-Type 은 항상 JSON");
    const j = JSON.parse(r.body); // 평문이면 여기서 throw → "Unexpected token" 재발 의미
    assert.equal(typeof j.ok, "boolean");
  });
});

test("SPA 폴백: 임의 경로 GET → index.html", async () => {
  await withServer(async (port) => {
    const r = await req(port, "/some/spa/route");
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
  });
});
