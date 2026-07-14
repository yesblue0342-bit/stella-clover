REPORT zaqmr_icon_symbol.

DATA: ls_btn TYPE smp_dyntxt,
      gv_undeclared_ref TYPE c LENGTH 1.

START-OF-SELECTION.
  ls_btn-icon = icon_create.                " SAP 표준 type-pool icon 상수 — 오탐 없이 통과해야 함
  ls_btn-text = 'Create'.
  gv_undeclared_ref = gv_really_not_declared.  " 진짜 미선언 변수 — 계속 check_syntax로 잡혀야 함(회귀 가드)
