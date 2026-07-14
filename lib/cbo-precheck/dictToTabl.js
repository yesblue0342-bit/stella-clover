// lib/cbo-precheck/dictToTabl.js — dictParser.js 의 통일 구조 → abapGit TABL XML 합성.
//
// fixtures/ddic/qals.tabl.xml 과 동일한 스키마(DD02V/DD09L/DD03P_TABLE)로 생성한다. ROLLNAME이 실제
// SAP 데이터 엘리먼트로 해석되는지는 무관하다 — DD03P가 DATATYPE/LENG을 직접 들고 있어 abaplint의
// unknown_types 룰은 이 값만으로 필드 존재/타입을 판단한다(lib/cbo-precheck/dictParser.js 헤더 주석의
// 실측 검증 참고: 합성 XML만으로 `TYPE zaqmt0132-werks` 같은 참조가 정상 해석됨을 확인했다).
function pad4(n) {
  return String(n).padStart(4, "0");
}

function pad6(n) {
  return String(n).padStart(6, "0");
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// DD03P.MASK는 abapGit TABL XML 관례상 "  <타입>"(공백 2칸 + 타입, 6칸 우측정렬 필드) — 기존
// fixtures/ddic/qals.tabl.xml 그대로의 포맷을 재사용한다.
function maskFor(datatype) {
  return `  ${datatype}`.slice(-6);
}

// dict: dictParser.parseDictDoc()의 반환값({tableName, ddtext, deliveryClass, tabClass, fields}).
// 반환값: abapGit TABL XML 문자열(파일명은 호출부가 `<tableName>.tabl.xml`로 결정).
export function dictToTablXml(dict) {
  if (!dict || !dict.tableName || !Array.isArray(dict.fields) || !dict.fields.length) {
    throw new Error("유효한 DDIC 테이블 구조가 아닙니다(tableName/fields 필요).");
  }
  const rows = dict.fields.map((f, i) => {
    const datatype = f.type || "CHAR";
    const leng = f.len || 0;
    return [
      "    <DD03P>",
      `     <FIELDNAME>${esc(f.name)}</FIELDNAME>`,
      `     <POSITION>${pad4(i + 1)}</POSITION>`,
      f.key ? "     <KEYFLAG>X</KEYFLAG>" : null,
      `     <ROLLNAME>${esc(f.rollname || f.name)}</ROLLNAME>`,
      `     <DATATYPE>${esc(datatype)}</DATATYPE>`,
      `     <LENG>${pad6(leng)}</LENG>`,
      `     <MASK>${esc(maskFor(datatype))}</MASK>`,
      "    </DD03P>",
    ].filter(Boolean).join("\n");
  }).join("\n");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">',
    ' <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">',
    "  <asx:values>",
    "   <DD02V>",
    `    <TABNAME>${esc(dict.tableName)}</TABNAME>`,
    "    <DDLANGUAGE>E</DDLANGUAGE>",
    "    <TABCLASS>TRANSP</TABCLASS>",
    `    <DDTEXT>${esc(dict.ddtext || dict.tableName)}</DDTEXT>`,
    `    <CONTFLAG>${esc(dict.deliveryClass || "A")}</CONTFLAG>`,
    "   </DD02V>",
    "   <DD09L>",
    `    <TABNAME>${esc(dict.tableName)}</TABNAME>`,
    "    <AS4LOCAL>A</AS4LOCAL>",
    "    <TABKAT>0</TABKAT>",
    "    <TABART>APPL0</TABART>",
    "    <BUFALLOW>N</BUFALLOW>",
    "   </DD09L>",
    "   <DD03P_TABLE>",
    rows,
    "   </DD03P_TABLE>",
    "  </asx:values>",
    " </asx:abap>",
    "</abapGit>",
  ].join("\n");
}
