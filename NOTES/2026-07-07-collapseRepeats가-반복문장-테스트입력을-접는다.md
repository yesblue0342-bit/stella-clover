# 테스트 입력으로 동일 문장 반복을 쓰면 collapseRepeats(환각 축소)가 접어버린다

- splitTranscript/prepareTranscript 경로는 3토큰 이상 구·문장이 연속 반복되면
  환각으로 보고 1개로 축소한다(NGRAM_MAX=20). "문장 A" × 400 같은 테스트 입력은
  한 문장으로 접혀 창 분할·길이 검증이 무의미해진다.
- 장문 테스트 데이터는 인덱스 등으로 문장을 서로 다르게 만들어야 한다
  (test/transcriptFix.test.js 참고). 실제 회의 전사는 자연히 다양해 문제 없음.
