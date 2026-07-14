REPORT zaqmr0130.

TYPES: BEGIN OF ty_out,
         prueflos TYPE qals-prueflos,
         matnr    TYPE qals-matnr,
         werk     TYPE qals-werk,
       END OF ty_out.

DATA: gt_out   TYPE STANDARD TABLE OF ty_out,
      gv_count TYPE i.                              " (1) unused_variables

SELECT-OPTIONS s_pruef FOR qals-prueflos.
PARAMETERS p_werks TYPE qals-werks OBLIGATORY.      " (2) check_ddic: WERKS는 없음(정답 WERK)

START-OF-SELECTION.
  SELECT prueflos matnr werk
    FROM qals
    INTO CORRESPONDING FIELDS OF TABLE gt_out
   WHERE prueflos IN s_pruef                        " (3) sql_escape_host_variables
     AND werk     =  p_werks.                       " (4) sql_escape_host_variables

  LOOP AT gt_out INTO DATA(ls_out).
    MOVE ls_out-matnr TO gv_matnr.                  " (5) check_variables: 미선언  (6) obsolete_statement: MOVE
  ENDLOOP.
