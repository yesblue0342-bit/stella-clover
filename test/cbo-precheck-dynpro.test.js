// Phase 3(재작업): Dynpro Screen(실행 후 화면) 전체 렌더링. WORK_REPORT.md 2026-07-14 "실패 재작업"
// 세션 Phase 0 참고 — 직전 세션(mission 8)은 이 기능 자체가 없어(preview.js가 Selection Screen만 파싱)
// Screen 0100이 미리보기에 전혀 나오지 않았다. GATE 3는 mock이 아니라 실제 260707_QM023_ZAQMR0130
// clone으로 검증한다(SSH 불가 환경은 skip).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractScreenNumbers, findAllModules, matchScreenModules, extractSetDirective,
  resolveTitlebarText, extractWhenCodes, extractToolbarButtons, extractFormFieldcat, buildScreenInfo,
} from "../lib/cbo-precheck/dynproPreview.js";

const exec = promisify(execFile);

test("extractScreenNumbers: CALL SCREEN/SET SCREEN을 찾고, LEAVE TO SCREEN 0(관용구)은 제외한다", () => {
  const src = "CALL SCREEN 0100.\nLEAVE TO SCREEN 0.\nSET SCREEN 200.\nCALL SCREEN 0100.";
  assert.deepEqual(extractScreenNumbers(src), ["0100", "0200"]);
});

test("findAllModules + matchScreenModules: 화면번호가 이름에 포함된 모듈을 우선 매칭한다", () => {
  const src = "MODULE status_0100 OUTPUT.\nENDMODULE.\nMODULE user_command_0100 INPUT.\nENDMODULE.";
  const modules = findAllModules(src);
  assert.deepEqual(modules, [{ name: "status_0100", kind: "OUTPUT" }, { name: "user_command_0100", kind: "INPUT" }]);
  const matched = matchScreenModules("0100", modules);
  assert.equal(matched.fallback, false);
  assert.equal(matched.output.length, 1);
  assert.equal(matched.input.length, 1);
});

test("matchScreenModules: 매칭 실패 시 fallback으로 전체 OUTPUT/INPUT 모듈을 반환한다", () => {
  const modules = [{ name: "status_main", kind: "OUTPUT" }, { name: "user_command_main", kind: "INPUT" }];
  const matched = matchScreenModules("0100", modules);
  assert.equal(matched.fallback, true);
  assert.equal(matched.output.length, 1);
  assert.equal(matched.input.length, 1);
});

test("extractSetDirective: SET TITLEBAR/PF-STATUS 이름과 WITH 변수를 추출한다", () => {
  const body = "SET PF-STATUS 'STATUS_0100'.\nSET TITLEBAR 'TITLE_0100' WITH gv_mode_text gv_tcode.";
  assert.deepEqual(extractSetDirective(body, "PF-STATUS"), { name: "STATUS_0100", withVars: [] });
  assert.deepEqual(extractSetDirective(body, "TITLEBAR"), { name: "TITLE_0100", withVars: ["gv_mode_text", "gv_tcode"] });
});

// architect 리뷰로 발견: WITH 그룹을 필수 위치로 강제하던 이전 버전은 WITH가 없는 EXCLUDING 형태에서
// 정규식 전체가 매치 실패해 pfStatus가 통째로 null이 되었다(다른 프로그램에서 PF-STATUS 자체가 사라지는
// 회귀 위험). EXCLUDING 등 WITH 없는 후행 절이 있어도 이름은 그대로 뽑혀야 한다.
test("extractSetDirective: SET PF-STATUS 'x' EXCLUDING <table>. 처럼 WITH 없는 후행 절도 이름을 놓치지 않는다", () => {
  const body = "SET PF-STATUS 'STATUS_0100' EXCLUDING lt_excl.";
  assert.deepEqual(extractSetDirective(body, "PF-STATUS"), { name: "STATUS_0100", withVars: [] });
});

test("resolveTitlebarText: &1/&2 자리표시자를 실제 변수명으로 치환한다(런타임 값은 알 수 없어 변수명 표시)", () => {
  const text = resolveTitlebarText("[QM] Assign — &1 (&2)", ["gv_mode_text", "gv_tcode"]);
  assert.equal(text, "[QM] Assign — «gv_mode_text» («gv_tcode»)");
});

test("extractWhenCodes: CASE sy-ucomm의 WHEN 절에서 기능코드를 뽑는다(OR 다중값 포함)", () => {
  const body = "CASE sy-ucomm.\nWHEN 'BACK' OR 'EXIT' OR 'CANCEL'.\nLEAVE TO SCREEN 0.\nENDCASE.";
  assert.deepEqual(extractWhenCodes(body), ["BACK", "EXIT", "CANCEL"]);
});

test("extractToolbarButtons: on_toolbar 메서드에서 버튼(function/icon/text/quickinfo)과 구분선을 순서대로 추출한다", () => {
  const src = `
METHOD on_toolbar.
  DATA ls_btn TYPE stb_button.
  CLEAR ls_btn. ls_btn-butn_type = 3.
  APPEND ls_btn TO e_object->mt_toolbar.
  CLEAR ls_btn.
  ls_btn-function  = 'ASSIGN'.
  ls_btn-icon      = icon_create.
  ls_btn-text      = 'Assign'.
  ls_btn-quickinfo = 'Assign inspection type'.
  APPEND ls_btn TO e_object->mt_toolbar.
ENDMETHOD.`;
  const buttons = extractToolbarButtons(src);
  assert.deepEqual(buttons, [
    { separator: true },
    { function: "ASSIGN", icon: "icon_create", text: "Assign", quickinfo: "Assign inspection type" },
  ]);
});

test("extractFormFieldcat: PERFORM <form> USING '필드' '텍스트' 길이 ... 패턴의 필드카탈로그를 재구성한다", () => {
  const src = `
FORM f_fc_add USING iv_field TYPE lvc_fname
                    iv_text  TYPE c
                    iv_out   TYPE i.
  CLEAR gs_fieldcat.
  gs_fieldcat-fieldname = iv_field.
  gs_fieldcat-coltext   = iv_text.
  IF iv_out > 0.
    gs_fieldcat-outputlen = iv_out.
  ENDIF.
  APPEND gs_fieldcat TO gt_fieldcat.
ENDFORM.

FORM f_set_fieldcat.
  PERFORM f_fc_add USING 'WERKS' 'Plant' 6.
  PERFORM f_fc_add USING 'MATNR' 'Material' 18.
ENDFORM.`;
  const byTable = extractFormFieldcat(src);
  assert.deepEqual(byTable.get("gt_fieldcat"), [
    { fieldname: "WERKS", coltext: "Plant", outputlen: 6 },
    { fieldname: "MATNR", coltext: "Material", outputlen: 18 },
  ]);
});

test("buildScreenInfo: 위 조각을 전부 조립해 하나의 화면 정보를 만든다", () => {
  const src = `
MODULE status_0100 OUTPUT.
  SET PF-STATUS 'STATUS_0100'.
  SET TITLEBAR 'TITLE_0100' WITH gv_mode_text.
ENDMODULE.
MODULE user_command_0100 INPUT.
  CASE sy-ucomm.
    WHEN 'BACK' OR 'EXIT'.
      LEAVE TO SCREEN 0.
  ENDCASE.
ENDMODULE.
DATA go_grid TYPE REF TO cl_gui_alv_grid.
METHOD on_toolbar.
  ls_btn-function = 'ASSIGN'.
  ls_btn-icon = icon_create.
  ls_btn-text = 'Assign'.
  APPEND ls_btn TO e_object->mt_toolbar.
ENDMETHOD.`;
  const textsMap = { titles: { TITLE_0100: "Demo — &1" } };
  const modules = findAllModules(src);
  const info = buildScreenInfo({ screenNo: "0100", source: src, textsMap, modules, alvColumnsByTable: new Map() });
  assert.equal(info.title.text, "Demo — «gv_mode_text»");
  assert.equal(info.pfStatus, "STATUS_0100");
  assert.deepEqual(info.functionCodes, ["BACK", "EXIT"]);
  assert.equal(info.hasAlvGrid, true);
  assert.equal(info.toolbarButtons.length, 1);
  assert.equal(info.modules.fallback, false);
});

const LIVE_REPO = "git@github.com:yesblue0342-bit/0Program.git";
const sshEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5",
};
let sshOk = false;
try {
  await exec("git", ["ls-remote", LIVE_REPO, "HEAD"], { timeout: 8000, windowsHide: true, env: sshEnv });
  sshOk = true;
} catch { sshOk = false; }

test(
  "GATE 3: 실제 0Program 저장소 — 폴더 경로 미리보기에서 Screen 0100이 검출·렌더링된다(ALV 툴바/컬럼/PF-STATUS/PBO-PAI 전부 실제 값)",
  { skip: sshOk ? false : "SSH(배포키) 접근 불가 — 네트워크 제약으로 skip" },
  async () => {
    const handler = (await import("../api/cbo-precheck.js")).default;
    const res = {
      _status: 200, _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this._status = c; return this; },
      json(o) { this._body = o; return this; },
    };
    await handler({
      method: "POST",
      query: { action: "preview-direct" },
      body: { repoUrl: LIVE_REPO, branch: "main", path: "260707_QM023_ZAQMR0130" },
    }, res);
    assert.equal(res._status, 200, JSON.stringify(res._body));
    const main = res._body.previews.find((p) => p.file === "_abap/ZAQMR0130.abap");
    assert.ok(main, "ZAQMR0130.abap 미리보기가 있어야 함");

    // GATE 3 (e): Selection Screen 회귀 없음(기존 18개 요소·INCLUDE 6개 병합).
    assert.equal(main.elements.length, 18);
    assert.equal(main.mergedFiles.length, 6);

    // GATE 3 (f): 화면 흐름(1000 → 0100).
    assert.deepEqual(main.flow, ["Selection Screen(1000)", "Screen 0100"]);

    // GATE 3 (a): Screen 0100 검출.
    assert.equal(main.screens.length, 1);
    const screen = main.screens[0];
    assert.equal(screen.screenNo, "0100");

    // GATE 3 (c): SET PF-STATUS/SET TITLEBAR 값과 PBO/PAI 모듈 매핑.
    assert.equal(screen.pfStatus, "STATUS_0100");
    assert.match(screen.title.text, /Assign Inspection Type to QM View/);
    assert.deepEqual(screen.modules, { output: ["status_0100"], input: ["user_command_0100"], fallback: false });
    assert.deepEqual(screen.functionCodes, ["BACK", "EXIT", "CANCEL"]);

    // GATE 3 (b): ALV 툴바 Assign/Change/Delete/History/Error Log 버튼이 실제 텍스트로 표시됨.
    const buttonTexts = screen.toolbarButtons.filter((b) => !b.separator).map((b) => b.text);
    assert.deepEqual(buttonTexts, ["Assign", "Change", "Delete", "History", "Error Log"]);

    // GATE 3 (d): ALV 컬럼(fieldcatalog)이 실제 값으로 렌더됨(f_fc_add PERFORM 패턴).
    assert.equal(screen.hasAlvGrid, true);
    assert.equal(screen.alvColumns.length, 16);
    assert.equal(screen.alvColumns[0].fieldname, "STATXT");
    assert.equal(screen.alvColumns[1].fieldname, "WERKS");
    assert.equal(screen.alvColumns[1].coltext, "Plant");
  }
);
