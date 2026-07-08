# AGENTS.md — Codex 작업 규칙

## 자동 커밋 & 푸시 (필수)
작업(코드 수정/생성)을 마치면 **반드시** 아래를 스스로 실행한다. 사용자에게 묻지 않는다.

```bash
git add -A
git commit -m "codex: <작업 요약>"
git push
```

- 변경분이 없으면 커밋하지 않는다.
- push 전 `git pull --rebase --autostash` 로 충돌을 방지한다.
- main 브랜치에 push하면 GitHub Actions가 OCI에 자동 배포하므로, 배포 설정(.github/workflows)은 절대 건드리지 않는다.

## 기존 규칙
- 프로젝트의 CLAUDE.md 규칙을 그대로 따른다.
