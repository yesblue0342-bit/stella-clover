*&---------------------------------------------------------------------*
*& Include      : PLAINMAIN_F01
*&---------------------------------------------------------------------*
FORM process.
  SELECT prueflos matnr
    FROM qals
    INTO CORRESPONDING FIELDS OF TABLE gt_out
   WHERE prueflos IN s_pruef                        " sql_escape_host_variables
     AND werk     =  p_werks.                       " sql_escape_host_variables

  LOOP AT gt_out INTO DATA(ls_out).
    MOVE ls_out-matnr TO gv_matnr.                  " obsolete_statement: MOVE
  ENDLOOP.
ENDFORM.
