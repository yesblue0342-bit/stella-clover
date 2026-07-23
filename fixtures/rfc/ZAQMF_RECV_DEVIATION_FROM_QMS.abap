FUNCTION zaqmf_recv_deviation_from_qms.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(EAI_IF_ID) TYPE CHAR16
*"     VALUE(EAI_USER) TYPE CHAR20 OPTIONAL
*"     VALUE(EAI_MODE) TYPE CHAR1 DEFAULT 'N'
*"  EXPORTING
*"     VALUE(EV_CD) TYPE CHAR1
*"     VALUE(EV_MSG) TYPE CHAR220
*"  TABLES
*"      T_TABLE STRUCTURE ZAQMS0002
*"      ET_RETURN STRUCTURE ZAQMS0003 OPTIONAL
*"  EXCEPTIONS
*"      SYSTEM_FAILURE
*"----------------------------------------------------------------------
* 1. Header validation
* 2. Run header creation
* 3. Normalize input and build lookup keys
  DATA lv_dummy TYPE char1.

  CALL FUNCTION 'CONVERSION_EXIT_ALPHA_INPUT'
    EXPORTING
      input = eai_if_id
    IMPORTING
      output = eai_if_id.

  SELECT SINGLE * FROM zaqmt0150 INTO @DATA(ls_header)
    WHERE if_id = @eai_if_id.

  MODIFY zaqmt0151 FROM @ls_header.
  INSERT zaqmt0152 FROM @ls_header.

  PERFORM validate_header.
  PERFORM save_result.

  IF lv_dummy = 'E'.
    ROLLBACK WORK.
  ELSE.
    COMMIT WORK.
  ENDIF.
ENDFUNCTION.

FORM validate_header.
ENDFORM.

FORM save_result.
ENDFORM.
