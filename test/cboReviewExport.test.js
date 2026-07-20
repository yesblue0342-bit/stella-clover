// lib/cbo-review/reviewExport.js — 코드 리뷰 결과 문서화(Markdown) 회귀 테스트.
// reviewToWorkbook 는 exceljs 동적 import라 여기선 순수 함수(flatten/markdown)만 검증한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewToMarkdown, flattenFindings } from "../lib/cbo-review/reviewExport.js";

const sample = {
  title: "260719_QM024_ZAQMR0140",
  summary: { fileCount: 2, findingCount: 3, severities: { High: 1, Mid: 1, Low: 1 }, failed: 0 },
  files: [
    {
      name: "ZAQMR0140.abap", language: "ABAP", summary: "요약 A",
      findings: [
        { line: 45, severity: "High", reason: "COMMIT 위치 오류", before: "COMMIT WORK.", after: "COMMIT WORK AND WAIT." },
        { line: 10, severity: "Low", reason: "주석 필요", before: "DATA x.", after: "DATA x. \" count" },
      ],
    },
    {
      name: "ZINCL.abap", language: "ABAP", summary: "",
      findings: [{ line: 3, severity: "Mid", reason: "SELECT *", before: "SELECT *", after: "SELECT matnr" }],
    },
  ],
};

test("flattenFindings: 파일별 지적을 1행씩 평탄화(파일명/언어 부착)", () => {
  const rows = flattenFindings(sample.files);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => `${r.file}:${r.line}:${r.severity}`), ["ZAQMR0140.abap:45:High", "ZAQMR0140.abap:10:Low", "ZINCL.abap:3:Mid"]);
});

test("reviewToMarkdown: 제목·요약·일괄반영 지시문 + 파일 헤더 + Before/After 코드펜스", () => {
  const md = reviewToMarkdown(sample);
  assert.match(md, /^# 코드 리뷰 결과 — 260719_QM024_ZAQMR0140/);
  assert.match(md, /> 파일 2 · 지적 3 · High 1 · Mid 1 · Low 1/);
  assert.match(md, /모두 반영해 소스를 수정해줘/);
  assert.match(md, /## ZAQMR0140\.abap \(ABAP\)/);
  assert.match(md, /_요약: 요약 A_/);
  assert.match(md, /### \[High\] Line 45/);
  assert.match(md, /```abap\nCOMMIT WORK\.\n```/);
  assert.match(md, /```abap\nCOMMIT WORK AND WAIT\.\n```/);
  // High가 Low보다 먼저(심각도 정렬)
  assert.ok(md.indexOf("Line 45") < md.indexOf("Line 10"), "High가 Low보다 먼저 나와야 함");
});

test("reviewToMarkdown: before에 백틱펜스 있으면 ~~~~ 로 감싼다", () => {
  const md = reviewToMarkdown({ title: "t", summary: {}, files: [{ name: "a.md", language: "", findings: [{ line: 1, severity: "Low", reason: "x", before: "```js\ncode\n```", after: "ok" }] }] });
  assert.match(md, /~~~~\n```js\ncode\n```\n~~~~/);
});

test("reviewToMarkdown: 지적 없음 → 안내 문구", () => {
  const md = reviewToMarkdown({ title: "t", summary: { fileCount: 1, findingCount: 0 }, files: [{ name: "a.abap", findings: [] }] });
  assert.match(md, /_지적사항이 없습니다\._/);
});

test("flattenFindings: 잘못된 입력도 안전(빈 배열)", () => {
  assert.deepEqual(flattenFindings(undefined), []);
  assert.deepEqual(flattenFindings([{ name: "x" }]), []); // findings 없음
});
