// lib/flowBuild.js — 표→Mermaid 변환 순수 함수 회귀 (Stella Flow)
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsToMermaid, parseDelimited, escapeLabel, looksLikeMermaid } from "../lib/flowBuild.js";

test("스텝 모드: 단일 열 → 선형 연결 + start/end stadium", () => {
  const r = rowsToMermaid([["요구사항 분석"], ["설계"], ["개발"], ["배포"]]);
  assert.equal(r.mode, "step");
  assert.equal(r.nodeCount, 4);
  assert.equal(r.edgeCount, 3);
  assert.match(r.mermaid, /^flowchart TD/);
  assert.match(r.mermaid, /n0\(\["요구사항 분석"\]\)/); // 시작 stadium
  assert.match(r.mermaid, /n3\(\["배포"\]\)/);          // 끝 stadium
  assert.match(r.mermaid, /n0 --> n1/);
});

test("엣지 모드(헤더 from/to/label): 간선 + 라벨", () => {
  const rows = [
    ["from", "to", "label"],
    ["시작", "검토", ""],
    ["검토", "배포", "승인"],
    ["검토", "반려", "거절"],
  ];
  const r = rowsToMermaid(rows);
  assert.equal(r.mode, "edge");
  assert.equal(r.nodeCount, 4); // 시작, 검토, 배포, 반려
  assert.equal(r.edgeCount, 3);
  assert.match(r.mermaid, /n1 -->\|"승인"\| n2/); // 검토→배포 라벨
  assert.match(r.mermaid, /n0 --> n1/);            // 라벨 없는 간선
});

test("엣지 모드(헤더 없는 2열): col0→col1", () => {
  const r = rowsToMermaid([["A", "B"], ["B", "C"]]);
  assert.equal(r.mode, "edge");
  assert.equal(r.nodeCount, 3);
  assert.equal(r.edgeCount, 2);
});

test("decision 노드: '?'/판단/확인 → 마름모", () => {
  const r = rowsToMermaid([["조건"], ["승인 여부"], ["완료"]]);
  assert.match(r.mermaid, /n1\{"승인 여부"\}/);
});

test("라벨 dedupe: 같은 라벨은 같은 노드 재사용(그래프 합류)", () => {
  const rows = [["from", "to"], ["A", "C"], ["B", "C"]];
  const r = rowsToMermaid(rows);
  assert.equal(r.nodeCount, 3); // A, C, B — C는 1개
});

test("escapeLabel: 따옴표/대괄호/파이프 등 파서 충돌 문자 정리", () => {
  assert.equal(escapeLabel('a"b'), "a&quot;b");
  assert.equal(escapeLabel("a[b]c|d"), "a b c d");
  assert.equal(escapeLabel("  여러   공백  "), "여러 공백");
});

test("빈 입력 → 유효한 placeholder mermaid", () => {
  const r = rowsToMermaid([]);
  assert.equal(r.nodeCount, 0);
  assert.match(r.mermaid, /flowchart TD/);
  assert.ok(looksLikeMermaid(r.mermaid));
});

test("parseDelimited: CSV 따옴표 필드 + 콤마 이스케이프", () => {
  const rows = parseDelimited('a,b,c\n"x,y",z,"he said ""hi"""');
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["x,y", "z", 'he said "hi"']);
});

test("parseDelimited: 탭 구분(엑셀 복사 붙여넣기) 자동 감지", () => {
  const rows = parseDelimited("A\tB\nC\tD");
  assert.deepEqual(rows, [["A", "B"], ["C", "D"]]);
});

test("looksLikeMermaid: graph/flowchart 헤더 판별", () => {
  assert.ok(looksLikeMermaid("flowchart LR\n a-->b"));
  assert.ok(looksLikeMermaid("graph TD\n a-->b"));
  assert.ok(!looksLikeMermaid("이건 그냥 텍스트"));
});

test("direction 옵션: LR 등 허용, 비정상값은 TD 폴백", () => {
  assert.match(rowsToMermaid([["a"], ["b"]], { direction: "LR" }).mermaid, /^flowchart LR/);
  assert.match(rowsToMermaid([["a"], ["b"]], { direction: "haxor" }).mermaid, /^flowchart TD/);
});
