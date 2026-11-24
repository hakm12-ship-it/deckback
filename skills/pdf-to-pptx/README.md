# pdf-to-pptx (Claude Code skill)

한국어: PDF를 편집 가능한 PowerPoint로 바꾸는 [deckback](../../packages/cli/README.md) 명령어를 Claude Code가 대신 돌리고, 변환 보고서를 한국어로 풀어 주는 스킬입니다. 변환은 내 컴퓨터에서만 이루어지고 파일은 어디로도 올라가지 않습니다. Claude는 PDF와 PPTX를 열어 보지 않고, 파일 이름·크기·날짜와 변환 보고서의 개수·글꼴 이름만 봅니다.

English: A Claude Code skill that runs the `deckback` CLI for you, converts a PDF into an editable PPTX on your own computer, and explains the conversion report. Nothing is uploaded. Claude does not open the PDF or the PPTX; it sees only file names, sizes and dates, plus the counts and font names in the report.

## 설치 / Install

Node.js 22.13 이상이 필요합니다 / Node.js 22.13 or newer is required.

- 프로젝트 하나에서만 / one project: copy this folder to `<project>/.claude/skills/pdf-to-pptx/`
- 모든 프로젝트에서 / every project: copy it to `~/.claude/skills/pdf-to-pptx/` (Windows: `%USERPROFILE%\.claude\skills\pdf-to-pptx\`)

그다음 Claude Code에서 "report.pdf를 PowerPoint로 바꿔 줘"처럼 말하면 됩니다 / then ask Claude Code, for example "turn report.pdf into PowerPoint".

## npm 공개 전에는 꼭 필요합니다 / Required until the npm release

**지금은 npm에 없으므로 `DECKBACK_NPX_SPEC`을 로컬 꾸러미로 지정해야 스킬이 동작합니다.** 고정된 `npx --yes deckback@1.0.0`은 npm에 올린 뒤의 경로입니다.
**deckback is not on npm yet, so the skill works only if `DECKBACK_NPX_SPEC` points at a local tarball.** The pinned `npx --yes deckback@1.0.0` is the path for after the npm release.

```
npm ci
npm run build:cli
npm pack -w packages/cli          # makes deckback-1.0.0.tgz
export DECKBACK_NPX_SPEC=/abs/path/deckback-1.0.0.tgz        # PowerShell: $env:DECKBACK_NPX_SPEC = "C:\abs\path\deckback-1.0.0.tgz"
```

`DECKBACK_NPX_SPEC`이 있으면 스킬은 `npx --yes --package "$DECKBACK_NPX_SPEC" -- deckback ...`를 씁니다. (npm 11에서는 `npx <파일>.tgz`가 동작하지 않아 `--package` 형태를 씁니다.)
When it is set the skill runs `npx --yes --package "$DECKBACK_NPX_SPEC" -- deckback ...` (on npm 11 `npx <file>.tgz` does not work, hence `--package`).

## 한계 / Not included

명세의 선택 항목인 "PowerPoint로 열어 확인하는 스크립트"는 아직 없습니다. 나중 일입니다.
The spec's optional "open it in PowerPoint and verify" script is not included yet; it is for later.

스킬이 고정한 버전(`1.0.0`)은 새 버전을 낼 때마다 `SKILL.md`에서 올려야 합니다 / the pinned version in `SKILL.md` must be bumped with each release.
