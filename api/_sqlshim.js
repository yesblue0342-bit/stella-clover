// api/_sqlshim.js - mssql 스타일 @name 파라미터를 PostgreSQL 위치 파라미터($n)로 변환.
// pg 런타임에 의존하지 않으므로 단위 테스트 가능. _db.js 의 호환 셰임이 이걸 사용한다.

// `@ident` → `$n`. 같은 이름이 여러 번 나오면 같은 $n 으로 매핑(pg 위치 파라미터 재사용).
// 반환: { text: 변환된 SQL, values: 순서대로의 값 배열 }
export function toPositional(text, params) {
  const values = [];
  // null 프로토타입 맵: `name in idx` 가 Object.prototype 멤버(toString/constructor 등)를
  // 잘못 잡지 않게 한다 — @toString 같은 파라미터명도 안전.
  const idx = Object.create(null);
  const out = String(text).replace(/@([A-Za-z_]\w*)/g, (_m, name) => {
    if (!(name in idx)) {
      values.push(params ? params[name] : undefined);
      idx[name] = values.length;
    }
    return "$" + idx[name];
  });
  return { text: out, values };
}

// mssql 타입 토큰 대체(예: sql.NVarChar(sql.MAX), sql.Int, sql.BigInt).
// 어떤 속성 접근/호출도 자기 자신을 반환 → 셰임이 타입을 무시해도 안전.
const _typeToken = function typeToken() { return _typeToken; };
export const sql = new Proxy(function () {}, {
  get() { return _typeToken; },
  apply() { return _typeToken; },
});
