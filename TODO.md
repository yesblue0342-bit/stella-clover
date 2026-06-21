# Stella Clover 개선 — TODO (autopilot)

- [x] CV1. 음성 파일 "다시 업로드"해도 회의록이 생성되지 않던 문제 수정 — (a) onFileSelect에서 input.value 비워 같은 파일 재선택도 onchange 재발화(재업로드 가능), (b) applyFile에서 이전 결과/단계 초기화(resetSteps)+결과변수 클리어+genBtn 활성으로 새 파일마다 깨끗한 상태에서 변환. (jsdom 검증)
- [x] CV2. 회의록 요약 분량 확대(반 페이지 추가) — summarize.js: "회의 내용 요약" 5~8줄→10~16줄, "## 상세 논의 내용"(주제별 단락, 약 반 페이지) 섹션 신설, max_tokens 2500→4000.
- [x] CV3. 회의 내용 정확도 개선 — summarize.js temperature 0.3→0.2 + 사실충실/anti-fabrication 지침(없는 사실 창작 금지, 불확실='(불확실)' 표기, STT 오인식만 신중 교정), Whisper(_stt.js) temperature:0 결정적 디코딩 명시. (모델 업그레이드는 비용 증가로 보류 — 프롬프트·디코딩으로 향상)
