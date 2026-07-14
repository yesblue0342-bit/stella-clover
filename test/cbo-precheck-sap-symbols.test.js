// Phase 1(재작업): SAP 표준 심볼(TYPE-POOLS icon 등) 오탐 제거 — WORK_REPORT.md 2026-07-14 "실패
// 재작업" 세션 참고. 직전 세션(mission 8)은 sapStandardSymbols.js 자체가 없어 icon_* 5건이 그대로
// 오탐이었다. abaplint 공식 확장점 `syntax.globalConstants`(scan.js 2-pass 스캔)로 해결한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scanFiles } from "../lib/cbo-precheck/scan.js";
import { isKnownSapStandardSymbol, extractNotFoundSymbol } from "../lib/cbo-precheck/sapStandardSymbols.js";

const iconFixture = fs.readFileSync("fixtures/zaqmr_icon_symbol.prog.abap", "utf8");

test("GATE 1 (a): icon_* 표준 심볼 참조는 check_syntax 오탐을 내지 않는다", () => {
  const { issues } = scanFiles({ files: [{ name: "zaqmr_icon_symbol.prog.abap", content: iconFixture }] });
  const iconIssue = issues.find((i) => i.rule === "check_syntax" && /icon_create/.test(i.message));
  assert.equal(iconIssue, undefined, "icon_create는 더 이상 check_syntax 오탐이 아니어야 함");
});

test("GATE 1 (c): 같은 파일의 진짜 미선언 변수는 계속 검출된다(회귀 가드 — 룰을 통째로 끈 게 아님)", () => {
  const { issues } = scanFiles({ files: [{ name: "zaqmr_icon_symbol.prog.abap", content: iconFixture }] });
  const realBug = issues.find((i) => i.rule === "check_syntax" && /gv_really_not_declared/.test(i.message));
  assert.ok(realBug, "gv_really_not_declared는 진짜 미선언 변수이므로 계속 잡혀야 함");
});

test("GATE 1: 기존 fixture(zaqmr0130_bad)의 의도적 미선언 변수 오류는 회귀 없이 그대로 검출된다", () => {
  const bad = fs.readFileSync("fixtures/zaqmr0130_bad.prog.abap", "utf8");
  const { issues } = scanFiles({ files: [{ name: "zaqmr0130_bad.prog.abap", content: bad }] });
  const realBug = issues.find((i) => i.rule === "check_syntax" && /gv_matnr/.test(i.message));
  assert.ok(realBug, "gv_matnr 미선언 오류는 icon 오탐 제거 로직과 무관하게 그대로 검출되어야 함");
});

test("isKnownSapStandardSymbol: icon_ 접두사만 매치, gc_/gv_ 등 Z 프로그램 변수 명명 규칙은 매치하지 않는다", () => {
  assert.equal(isKnownSapStandardSymbol("icon_create"), true);
  assert.equal(isKnownSapStandardSymbol("ICON_LED_RED"), true, "대소문자 무관");
  assert.equal(isKnownSapStandardSymbol("gc_x"), false);
  assert.equal(isKnownSapStandardSymbol("gv_mode"), false);
  assert.equal(isKnownSapStandardSymbol("gt_stage"), false);
});

test("extractNotFoundSymbol: abaplint check_syntax 메시지 포맷에서 식별자를 뽑는다", () => {
  assert.equal(extractNotFoundSymbol('"icon_create" not found, findTop'), "icon_create");
  assert.equal(extractNotFoundSymbol('"gv_modified" not found, Target'), "gv_modified");
  assert.equal(extractNotFoundSymbol("Escape SQL host variables"), null);
});
