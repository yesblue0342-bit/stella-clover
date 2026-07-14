# DDIC Table: ZDEMOT001 — Demo Header (fixture)

**Type:** Transparent Table (CBO) · **Package:** ZCDEMO · **Delivery Class:** A
합성 fixture — 실제 회사 테이블이 아니라 markdown DDIC 문서 파서 테스트 전용 구조.

| # | Field | Key | Data Element | Type | Len | Description (EN / KO) |
|---|-------|-----|--------------|------|-----|-----------------------|
| 1 | MANDT | X | MANDT | CLNT | 3 | Client |
| 2 | RUNID | X | ZDE_DEMO_RUNID | NUMC | 10 | Run ID |
| 3 | WERKS | | WERKS_D | CHAR | 4 | Plant |
| 4 | STATUS | | ZDE_DEMO_FLAG(XFELD) | CHAR | 1 | Status flag |

Key: MANDT+RUNID · Data class APPL1.
