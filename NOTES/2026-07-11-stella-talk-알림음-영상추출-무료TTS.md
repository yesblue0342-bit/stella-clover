# Stella Talk 알림 벨소리: 영상 실제 목소리 추출 + 무료 TTS(espeak-ng) 프리셋

- "내 목소리로 벨소리" 녹음이 저장 안 되던 근본 원인: 오디오 blob을 localStorage에 넣으려 하면
  용량/직렬화 한계로 실패한다. → **IndexedDB**(`stella_talk_audio`/`ring`/key='custom')에 blob 저장하면
  reload 후에도 유지된다. 재생은 IndexedDB blob → `URL.createObjectURL` → `<audio>`.
- "벨소리 안 울림" 원인: `primeAudio()`가 자동재생 정책 해제를 위해 공유 `<audio>`를 muted로 play 하는데,
  실제 재생이 그 직후 실행되면 아직 muted 상태라 소리가 안 났다. → 실제 재생 함수에서 항상
  `a.muted=false`를 강제(playwright 계측으로 재현·수정, muted:true→false 확인).
- 프리셋 음성 에셋(`talk-sounds/*.mp3`, mono 48kbps, 총 ~36KB):
  · `stella-tok.mp3` = 업로드 영상에서 딸 실제 목소리 구간(1.79~3.06s) ffmpeg 추출·정제(highpass/denoise/dynaudnorm/fade).
  · 나머지 4종 = **espeak-ng**(무료, 오프라인) ko 여성 보이스 + `asetrate` 포먼트/피치 업(≈1.34x)으로 8세 여아 톤 근사.
- 샌드박스에선 오디오를 청취 검증할 수 없어 espeak 발음 품질은 미청취(로그/디코드/길이만 확인). 사용자가
  들어보고 부족하면 앱의 "내 목소리로 벨소리" 녹음으로 대체하거나 더 좋은 TTS로 mp3만 교체하면 된다.
- espeak-ng는 배포 런타임에 불필요(빌드/개발 시 mp3 생성용). 컨테이너에 추가 설치 안 함.
