REPORT zaqmr0130_good.

TYPES: BEGIN OF ty_out,
         prueflos TYPE qals-prueflos,
         matnr    TYPE qals-matnr,
         werk     TYPE qals-werk,
       END OF ty_out.

DATA: gt_out TYPE STANDARD TABLE OF ty_out,
      go_alv TYPE REF TO cl_gui_alv_grid,
      gt_fcat TYPE lvc_t_fcat,
      gs_fcat TYPE lvc_s_fcat.

SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-b01.
  SELECT-OPTIONS s_pruef FOR qals-prueflos.
  PARAMETERS p_werk TYPE qals-werk OBLIGATORY DEFAULT 'US11'.
  PARAMETERS p_all AS CHECKBOX.
  SELECTION-SCREEN COMMENT /1(40) TEXT-c01.
  SELECTION-SCREEN PUSHBUTTON 2(20) TEXT-p01 USER-COMMAND fltr.
SELECTION-SCREEN END OF BLOCK b1.

START-OF-SELECTION.
  IF p_all = abap_true.
    CLEAR s_pruef[].
  ENDIF.

  SELECT prueflos matnr werk
    FROM qals
    INTO CORRESPONDING FIELDS OF TABLE @gt_out
   WHERE prueflos IN @s_pruef
     AND werk     =  @p_werk.

  gs_fcat-fieldname = 'PRUEFLOS'.
  gs_fcat-coltext   = '검사로트'.
  gs_fcat-outputlen = 12.
  APPEND gs_fcat TO gt_fcat.

  gs_fcat-fieldname = 'MATNR'.
  gs_fcat-coltext   = '자재'.
  gs_fcat-outputlen = 18.
  APPEND gs_fcat TO gt_fcat.

  gs_fcat-fieldname = 'WERK'.
  gs_fcat-coltext   = '플랜트'.
  gs_fcat-outputlen = 4.
  APPEND gs_fcat TO gt_fcat.

  CREATE OBJECT go_alv
    EXPORTING
      i_parent = cl_gui_container=>screen0.
