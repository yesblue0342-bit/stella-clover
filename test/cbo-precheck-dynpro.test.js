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
  extractSalvFactoryTable, resolveItabStructureType, extractTypesFields, extractSalvColumnTexts,
  extractSalvListHeader, buildSalvScreenInfo,
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

// SALV 전체화면 ALV(재작업 260714-1-RETRY): CALL SCREEN 없이 CL_SALV_TABLE=>FACTORY로 바로 리스트를
// 띄우는 ZAQMR0131 패턴. 재현: 이 스위트가 추가되기 전에는 buildScreenInfo 계열 함수가 전혀 없어
// screens/flow가 통째로 빈 배열이었다(위 GATE 3와 별개 경로 — screenNumbers가 0건이라 buildScreenInfo가
// 한 번도 호출되지 않음).
const SALV_SRC = `
TYPES:
  BEGIN OF ty_disp,
    werks     TYPE zaqmt0132-werks,     " Plant
    matnr     TYPE zaqmt0132-matnr,     " Material
    maktx     TYPE makt-maktx,          " Material Description
    art       TYPE zaqmt0132-art,       " Inspection Type
    action_tx TYPE c LENGTH 10,         " Action Type
    zseqno    TYPE zaqmt0132-zseqno,    " (정렬용, 화면 숨김)
  END OF ty_disp.

DATA:
  gt_disp TYPE STANDARD TABLE OF ty_disp,
  go_alv  TYPE REF TO cl_salv_table.

FORM f_display.
  DATA: lr_columns TYPE REF TO cl_salv_columns_table,
        lr_disp    TYPE REF TO cl_salv_display_settings.

  cl_salv_table=>factory(
    IMPORTING r_salv_table = go_alv
    CHANGING  t_table      = gt_disp ).

  lr_columns = go_alv->get_columns( ).
  PERFORM f_col_text USING lr_columns 'MAKTX'
                           'Mat.Desc.' 'Material Desc.' 'Material Description'.
  PERFORM f_col_text USING lr_columns 'ART'
                           'Insp.Type' 'Inspection Type' 'Inspection Type'.
  PERFORM f_col_hide USING lr_columns 'ZSEQNO'.

  lr_disp = go_alv->get_display_settings( ).
  lr_disp->set_list_header( 'QM View Inspection Type - Change History' ).
  go_alv->display( ).
ENDFORM.

FORM f_col_text USING ir_columns TYPE REF TO cl_salv_columns_table
                      iv_col     TYPE lvc_fname
                      iv_short   TYPE scrtext_s
                      iv_medium  TYPE scrtext_m
                      iv_long    TYPE scrtext_l.
  DATA lr_col TYPE REF TO cl_salv_column.
  lr_col = ir_columns->get_column( iv_col ).
  lr_col->set_short_text( iv_short ).
  lr_col->set_medium_text( iv_medium ).
  lr_col->set_long_text( iv_long ).
ENDFORM.

FORM f_col_hide USING ir_columns TYPE REF TO cl_salv_columns_table
                      iv_col     TYPE lvc_fname.
  DATA lr_col TYPE REF TO cl_salv_column.
  lr_col = ir_columns->get_column( iv_col ).
  lr_col->set_technical( abap_true ).
ENDFORM.
`;

test("extractSalvFactoryTable: cl_salv_table=>factory( ... CHANGING t_table = <itab> )에서 내부테이블 변수명을 뽑는다", () => {
  assert.equal(extractSalvFactoryTable(SALV_SRC), "gt_disp");
  assert.equal(extractSalvFactoryTable("DATA go_alv TYPE REF TO cl_salv_table."), null);
});

test("resolveItabStructureType: DATA 선언에서 STANDARD TABLE OF 뒤 구조 타입명을 역추적한다", () => {
  assert.equal(resolveItabStructureType(SALV_SRC, "gt_disp"), "ty_disp");
  assert.equal(resolveItabStructureType(SALV_SRC, "no_such_var"), null);
});

test("extractTypesFields: TYPES BEGIN OF ~ END OF 필드 선언 순서를 그대로 뽑고, 인라인 주석의 '…Type' 오탐을 걸러낸다", () => {
  assert.deepEqual(extractTypesFields(SALV_SRC, "ty_disp"), ["WERKS", "MATNR", "MAKTX", "ART", "ACTION_TX", "ZSEQNO"]);
});

test("extractSalvColumnTexts: FORM 경유 PERFORM 호출(2줄에 걸친 리터럴 포함)에서 medium 텍스트와 숨김 컬럼을 뽑는다", () => {
  const { textMap, hidden } = extractSalvColumnTexts(SALV_SRC);
  assert.equal(textMap.get("MAKTX").medium, "Material Desc.");
  assert.equal(textMap.get("ART").medium, "Inspection Type");
  assert.equal(textMap.has("WERKS"), false); // f_col_text 호출이 없는 컬럼 — 매핑 없음
  assert.ok(hidden.has("ZSEQNO"));
});

test("extractSalvListHeader: set_list_header('...') 리터럴을 뽑는다", () => {
  assert.equal(extractSalvListHeader(SALV_SRC), "QM View Inspection Type - Change History");
  assert.equal(extractSalvListHeader("go_alv->display( )."), null);
});

test("buildSalvScreenInfo: SALV 전체화면 ALV 하나를 통째로 조립한다(필드 순서·헤더 텍스트·숨김·타이틀)", () => {
  const info = buildSalvScreenInfo(SALV_SRC);
  assert.equal(info.table, "gt_disp");
  assert.equal(info.title.text, "QM View Inspection Type - Change History");
  // ZSEQNO는 set_technical(abap_true)로 숨겨져 컬럼 목록에서 빠지고, WERKS/MATNR은 헤더 텍스트 호출이
  // 없어 필드명 대문자로 폴백한다(요구사항 "헤더 텍스트 없는 컬럼은 필드명 대문자로 표시").
  assert.deepEqual(info.columns, [
    { fieldname: "WERKS", coltext: "WERKS", outputlen: null },
    { fieldname: "MATNR", coltext: "MATNR", outputlen: null },
    { fieldname: "MAKTX", coltext: "Material Desc.", outputlen: null },
    { fieldname: "ART", coltext: "Inspection Type", outputlen: null },
    { fieldname: "ACTION_TX", coltext: "ACTION_TX", outputlen: null },
  ]);
});

test("buildSalvScreenInfo: CL_SALV_TABLE=>FACTORY가 없으면 null(Dynpro Screen 경로와 충돌하지 않음)", () => {
  assert.equal(buildSalvScreenInfo("CALL SCREEN 0100."), null);
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

test(
  "GATE 4 (260714-1-RETRY): 실제 0Program 저장소 — ZAQMR0131(CL_SALV_TABLE 전체화면 ALV, CALL SCREEN 없음)이 " +
    "SALV 결과화면으로 렌더링된다(재작업 전에는 screens/flow가 통째로 빈 배열이었음)",
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
    const salv = res._body.previews.find((p) => p.file === "_abap/ZAQMR0131.abap");
    assert.ok(salv, "ZAQMR0131.abap 미리보기가 있어야 함");

    // 화면 흐름: Selection Screen(1000) → SALV Fullscreen ALV.
    assert.deepEqual(salv.flow, ["Selection Screen(1000)", "SALV Fullscreen ALV"]);

    assert.equal(salv.screens.length, 1);
    const screen = salv.screens[0];
    assert.equal(screen.salv, true);
    assert.equal(screen.hasAlvGrid, true);

    // set_list_header( '...' ) 타이틀.
    assert.equal(screen.title.text, "QM View Inspection Type - Change History");

    // ZSEQNO는 set_technical(abap_true)로 숨겨져 컬럼 목록에서 빠진다(16개 필드 중 15개만 표시).
    assert.equal(screen.alvColumns.length, 15);
    assert.ok(!screen.alvColumns.some((c) => c.fieldname === "ZSEQNO"));

    // 필드 선언 순서(TYPES ty_disp) = 컬럼 표시 순서.
    assert.deepEqual(screen.alvColumns.map((c) => c.fieldname), [
      "WERKS", "MATNR", "MAKTX", "ART", "ACTION_TX", "FNAME", "OLD_VALUE", "NEW_VALUE",
      "ERNAM", "ERDAT", "ERZET", "AENAM", "AEDAT", "AEZET", "ZRUNID",
    ]);

    // set_short_text/medium_text/long_text 를 FORM(f_col_text) 경유로 추적해 medium 텍스트를 헤더로 씀.
    const byField = Object.fromEntries(screen.alvColumns.map((c) => [c.fieldname, c.coltext]));
    assert.equal(byField.MAKTX, "Material Desc.");
    assert.equal(byField.ART, "Inspection Type");
    assert.equal(byField.ERNAM, "Created By");

    // f_col_text 호출이 없는 컬럼(WERKS/MATNR)은 헤더 텍스트 없이 필드명 대문자로 폴백한다.
    assert.equal(byField.WERKS, "WERKS");
    assert.equal(byField.MATNR, "MATNR");
  }
);
