# Dogfood — Cashflow Renewal (2026-05-28)

PreFlowAI 의 budget 모듈 캐시플로 탭 리뉴얼 작업. 두 단계로 나눠
`tedit multiedit` 로 진행. **`--summary` 옵션이 추가된 새 빌드 기준**.

## Session summary

| Phase | Spec | Edits | Files | First-try? | Notes |
|---|---|---|---|---|---|
| Step 1 (cashflow PageHead actions) | `cashflow-step1-headactions.json` | 11 | 8 | ✓ | DepthSegment / 엑셀 export / ⚙ / Cash Flow 확정 + Lock 아이콘 컨벤션 정렬 + cfExportTemplateError i18n × 5 locales |
| Step 2 (BudgetTotalStrip) | `cashflow-step2-totalstrip.json` | 7 | 6 | ✓ | ContentView.header wiring + cfExecuted i18n × 5 locales |

총 **18 edits / 14 file writes** — 모두 dry-run → write 2-스텝 진행, **fuzzy 없이 첫 시도 매치**.

## `--summary` 검증 — 메인 이슈 해결됨

Before (filed issue):
- dry-run 출력이 245KB JSON 덤프 (전체 diff + 파일 내용 + git status)
- agent 가 `grep '"success"' ...` 해킹으로 우회

After (이 dogfood run):
```
$ tedit multiedit cashflow-step2-totalstrip.json --dry-run --summary
spec: cashflow-step2-totalstrip.json (7 edits, 6 files)
  apps/web/src/app/(app)/projects/[id]/budget/page.tsx  ok  2/2
  apps/web/messages/ko.json                             ok  1/1
  apps/web/messages/en.json                             ok  1/1
  apps/web/messages/id.json                             ok  1/1
  apps/web/messages/zh-CN.json                          ok  1/1
  apps/web/messages/zh-TW.json                          ok  1/1
result: success - 7/7 edits matched, no files written (dry-run)
```

**정확히 의도한 모양으로 나옴.** 한 줄에 path + ok/fail + match count.
원래 명세대로 diff/내용/git status 모두 생략됨. agent 가 그대로 읽고 바로
write 결정 가능.

`tail -15` 로 자르면 9줄 안에 모든 정보. 245KB → ~500 bytes. **>99% 감축.**

## 잘 동작한 케이스들

1. **다중 파일 + 다중 edit 한 spec** — Step 1 의 8 files / 11 edits 가 한
   commit-가능한 단위로 묶임. atomic 적용 (모든 edit 매치 안 되면 write
   안 함) 확인.
2. **긴 multiline find/replace** — Step 1 의 `budget/page.tsx` 캐시플로 case
   추가는 ~50줄 JSX 블록. anchor 로 saveStatus 주석 단일 라인 사용해서
   `insert-before` 효과를 `find` + `replace` (with original) 패턴으로 구현.
   1-shot 매치.
3. **5-locale i18n 키 추가** — locale 마다 value 가 다르므로 5 개 edit 명시.
   key + 직전 값 anchor 로 깔끔하게 처리.
4. **Step 1 → Step 2 의 anchor 연쇄** — Step 1 에서 추가한
   `cfExportTemplateError` 라인을 Step 2 의 anchor 로 활용해 `cfExecuted`
   를 그 다음 줄에 삽입. 새 키도 같은 패턴으로 계속 누적 가능.

## 사소한 follow-up

이미 ISSUE 의 "dogfood notes" 에 적었지만 한 번 더:

- `--version` 여전히 `Unknown command: --version`. P3 정도지만 표준 CLI 관례.
- `--help` 가 길어서 agent 가 한 번에 읽기 부담. `tedit help <subcommand>`
  같은 subcommand-scoped help 가 있으면 토큰 절약. (예: `tedit help multiedit`)

## 새로 떠오른 enhancement 아이디어 (별도 이슈 거리)

### JSON-aware key insertion mode

i18n 작업처럼 **"같은 key 가 여러 파일에 다른 value 로 들어있고, 그 다음에
새 key 를 추가"** 패턴이 흔함. 현재는 locale 마다 value 까지 정확히 적어
edit 5개를 만들어야 함.

상상:
```bash
tedit json insert-after-key apps/web/messages/*.json \
  --after-key "cfExportTemplateError" \
  --insert '"cfExecuted": <value-per-locale>' \
  --values 'ko=집행,en=Executed,id=Eksekusi,zh-CN=执行,zh-TW=執行'
```

또는 spec JSON 으로:
```json
{
  "jsonEdits": [
    {
      "files": "apps/web/messages/*.json",
      "afterKey": "cfExportTemplateError",
      "key": "cfExecuted",
      "values": {
        "ko.json": "집행",
        "en.json": "Executed",
        "id.json": "Eksekusi",
        "zh-CN.json": "执行",
        "zh-TW.json": "執行"
      }
    }
  ]
}
```

5 edit 이 1 spec entry 로. AST-기반이라 value 가 어떻든 정확하게 동작.

이건 큰 추가라 본 multiedit 의 scope 밖일 수 있음 — 별도 `tedit i18n`
subcommand 가 더 깔끔할지도. 일단 메모만.

### Auto-anchor verification

같은 spec 안에서 Step 1 의 edit 결과를 Step 2 의 anchor 로 쓰는 경우
(같은 multiedit 안에서 sequential), 현재도 잘 동작함. 다만 spec 작성 시
**"이 edit 이 끝난 뒤 상태에서 다음 edit 의 find 가 매치되는가"** 를 mental
model 로 계산해야 함. spec 안에서 그게 자동 검증된다고 명시되면 안심
(이미 동작은 그렇게 하는 듯).

명시적 옵션: `--validate-sequential` 같은 메타 정보가 spec 헤더에 있으면
agent 가 spec 작성 시 더 자신 있게 누적 anchor 패턴 쓸 수 있음.

## 추가 — MCP 서버 첫 사용 (2026-05-29)

같은 세션에서 작은 follow-up 작업 (CashflowTab 내부 DepthSegment 제거)
을 **이번엔 MCP 로** 시도. 7 edits × 2 files. 결과 비교:

| 측면 | CLI (`--summary`) | MCP (`mcp__tedit__multiedit`) |
|---|---|---|
| 호출 방식 | bash + /tmp/spec.json | 인라인 typed arg |
| dry-run | `--dry-run --summary` | `dryRun: true` |
| 출력 | 한 줄/파일, ~500 bytes | **573KB verbose JSON** |
| 결과 파악 | 그대로 읽음 | `jq -r '.success, .summary'` 우회 필요 |

**핵심 문제**: MCP 도구가 `--summary` 동등 모드 미지원. 매 호출마다
verbose JSON (full diff + 파일 내용 + parse-state + git status) 반환.
agent harness 가 토큰 한도 초과 → 디스크 캐시 → 잘려서 표시. CLI 와
같은 quality-of-life 효과를 못 누림.

### 제안

MCP `multiedit` (그리고 `edit`, `patch`) 에 출력 모드 파라미터 추가:

```json
{
  "edits": [...],
  "dryRun": true,
  "summary": "files"   // 또는 "edits" | "off" (default off, agent 는 "files" 권장)
}
```

또는 MCP 의 **기본 출력을 summary 로** 하고, full JSON 이 필요한 경우만
`verbose: true` 옵트인. agent-facing 도구는 terse 가 디폴트가 더 자연스러움.

현재 jq 우회는 동작은 하지만:
1. 매번 jq 스크립트 작성 (LLM 토큰 소모)
2. 결과 파일 경로 추적 필요
3. JSON 구조 변경 시 깨짐 (e.g., `.results[].ok` 가 `null` 로 와서 처음엔 헷갈렸음)

### 좋았던 점 (MCP)

- /tmp 파일 작성 안 함 — spec 직접 인라인
- bash + node CLI 호출 안 함 — 한 단계 줄어듦
- 타입드 인자 — 스키마 검증 자동

요컨대 **호출 측은 좋아졌는데 출력 측은 같이 못 따라옴**. 출력 모드만
해결되면 MCP 가 CLI 보다 우월.

## 결론

**`--summary` (CLI) 합격. MCP 도 출력 mode 만 따라오면 완성.**

다음 dogfood 때는:
- MCP 의 `summary`/`verbose` 옵션 추가 여부 확인
- i18n key insertion 케이스가 또 나오면 `tedit i18n` 또는 json-aware insert
  enhancement 의 절실함 측정
