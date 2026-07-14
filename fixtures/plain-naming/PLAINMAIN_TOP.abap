*&---------------------------------------------------------------------*
*& Include      : PLAINMAIN_TOP
*&---------------------------------------------------------------------*
TYPES: BEGIN OF ty_out,
         prueflos TYPE qals-prueflos,
         matnr    TYPE qals-matnr,
       END OF ty_out.

DATA: gt_out   TYPE STANDARD TABLE OF ty_out,
      gv_matnr TYPE qals-matnr.

SELECT-OPTIONS s_pruef FOR qals-prueflos.
PARAMETERS p_werks TYPE qals-werks OBLIGATORY.      " check_ddic: WERKS는 없음(정답 WERK)
