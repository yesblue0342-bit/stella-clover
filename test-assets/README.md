# test-assets

전사(transcribe) 파이프라인 최소 검증용 오디오.

- `node test-assets/make-wav.mjs` 실행 → `silence-2s.wav`(무음), `tone-2s.wav`(440Hz) 생성.
- 실제 음성으로 종단 테스트하려면 짧은 **m4a/wav 파일을 이 폴더에 직접 넣어** 앱(녹음 대신 파일 업로드)으로 테스트하세요.
- 파이프라인: 브라우저 Web Audio → 16kHz mono WAV → 120초 청크 → `/api/transcribe` 순차 POST(3회 재시도 + prevText).
