# 컨트롤 타워 — 구현 가이드 & 현황

Agents Clubhouse 플러그인의 "AI 명령" 컨트롤 타워: 타이틀바 진입점에서 자연어 한
줄을 soksak의 세 제어 축(command / dom / status)을 가로지르는 프로젝트 전체
오케스트레이션으로 바꾼다. 이 문서는 "우리가 알아야 할 것" 레퍼런스다: 요구사항,
무엇을 만들었는가, 어떻게 동작하는가, 검증, TODO.

- `main`에 머지 커밋으로 안착(`Merge feat/control-tower: AI-command control tower (M1-M11)`).
- 현황: **완성**(M1–M11), 소켓 + 시각 검증. 기존 Clubhouse 콘텐츠 탭에 additive — 💬 대화 뷰는 그대로, 타워는 타이틀바 ✦ 아이콘을 **추가**한다.
- 전부 이 플러그인(`src/tower/`)에 산다; **코어 변경 0**(이미 출하된 범용 코어 capability만 소비).

---

## 1. 요구사항 (왜 만드는가)

로컬 제어 표면(command 레지스트리 + `ui.*` dom + `status.query`)은 이미
socket/CLI/MCP 채널로 헤드리스 도달 가능했다(코어의 `docs/AI-CONTROL.md`). 빠진
것은 **사람-대면 상호작용 표면**: 사람이 자연어 한 줄로 soksak 전체를 조종하는
길. Clubhouse 플러그인은 이미 다중 에이전트 대화 엔진(진행/순차/동시 모드,
`@지목` 체인, 영속 연결, 라이브 스트리밍, 인터럽트)을 가졌지만 자기 acp.* 표면
너머의 코어 커맨드를 못 불렀다.

컨트롤 타워는 둘을 융합한다: AI-명령 모달(NL 바 + 클릭 가능한 예시행 + 명령
팔레트 + 검색 + 라이브 칸) × Clubhouse 다중 에이전트 엔진 × 3축 substrate.
**기존 UX 위 additive** — 콘텐츠 탭은 그대로, 타이틀바 ✦ 아이콘이 프로젝트 전체
오케스트레이션 모달을 연다: "왼쪽 창 닫고 터미널 크게 보여줘"를 타이핑하면
에이전트들이 모든 것을 조종한다.

준수한 설계 원칙:
- **단일 실행점.** 모든 plan→디스패치는 `executor.ts`를 거치므로 불변식을 한 곳에서 테스트로 강제.
- **fast-path / slow-path.** 결정적 경로(예시행, 팔레트)는 에이전트 없이 실행; 모호한 NL만 엔진으로 — 비용·지연 절감.
- **전수 노출(RULE 8).** 모든 dom 노드·모든 command·모든 status를 관측 가능하게 해 AI/E2E가 타워를 투명하게 조종. 단 관측과 executor-쓰기는 별개: 보안 chrome(danger-confirm)은 `ui.tree`에 보이되 **executor의 dom 도달 밖** — 자기 게이트를 클릭 불가.

---

## 2. 무엇을 만들었나 (작업 내용)

`feat/control-tower`의 11 커밋, 각각 RED→GREEN + 소켓/시각 검증:

| M | 커밋 | 내용 |
|---|------|------|
| M1 | `2bcfb32` | `ui:titlebar` 권한 + 플러그인이 코어 커맨드(`state.commands`, `ui.tree`)를 부를 수 있다는 계약 테스트. |
| M2 | `06c800a` | 타이틀바 ✦ 액션(`registerHeaderAction`) + 빈 드래그 가능 560px 모달 셸(콘텐츠 탭 보존). |
| M3 | `3a23698` | 모달 본문 — NL 바, 클릭 가능한 예시행, 라이브 명령 팔레트, 검색, 라이브 칸; 코어 토큰 기반 5테마 CSS. |
| M4 | `fa3526a` | fast-path executor + `plan.ts` 검증; 예시/팔레트 → `app.commands.execute`; destructive → confirm 게이트. |
| M5 | `7687d54` | slow-path 오케스트레이션 — NL → 엔진 → 3축 plan → executor, dry-run 미리보기 + 결과 피드백. |
| M6 | `99cda8d` | 다중 에이전트 분배(모드별), 직렬 confirm 큐, 인터럽트. |
| M7 | `a015845` | `app.data` 위 세션 / trace 영속(plan + step + outcome). |
| M8 | `2931fe4` | 실행 후 reflection 루프(디스패치 → `status.query` 검증(폴링 아님) → 재계획) + max-steps / max-replan 가드 + escalation. |
| M9 | `ab964ba` | 편집 가능 dry-run 미리보기(삭제 / 재정렬 / 파라미터 수정, 재검증) + 한정 정직 rollback(스냅샷 → invertible step만 역명령; non-invertible은 `unrestorable`로 보고). |
| M10 | `5dfd067` | untrusted-content scanner(prompt-injection / homograph / pipe-to-interpreter / ANSI / zero-width / encoded) + taint 추적 → untrusted 컨텍스트 유래 destructive step은 confirm 게이트 강제; flagged plan은 거부. |
| M11 | `87ab983` | 매크로 승격 — 반복 trusted NL→plan을 명명 fast-path로 승격 제안(`app.data` 영속), 실행 전마다 재검증; tainted plan은 승격 불가. |

---

## 3. 아키텍처 & 기능 정의

### 흐름
```
NL 입력(또는 예시행 클릭) → executor 진입
 ├─ fast-path: 팔레트/예시 정확·퍼지 매치, destructive 아님
 │    → app.commands.execute(name, params)            (에이전트 없이, 즉답)
 └─ slow-path: 모호 NL
      → Clubhouse 엔진(facil / turn / simul), 라이브 도메인맵 주입
        (state.commands 레지스트리 + ui.tree 주소 + status.query)
      → 에이전트(들) plan 반환: [{axis:"command"|"dom"|"status", name, params|address}]
      → executor step별 디스패치:
          command → app.commands.execute(name, params)
          dom     → app.commands.execute("ui.input.click"/"ui.input.fill", {address})
          status  → status.query  (사전/사후 검사)
      → 각 step 결과를 다음 step / 다음 턴에 피드백 (verify, not poll)
```

### 파일 (`src/tower/`)
| 파일 | 역할 |
|------|------|
| `header.ts` | 타이틀바 ✦ 액션 + 모달 토글(`active` 강조) |
| `modal.ts` | 얇은 모달 뷰(DOM + `data-node` 배선); 로직은 executor만 호출 |
| `executor.ts` | 단일 실행점 — fast/slow path, danger 게이트, 디스패치, reflection, rollback |
| `plan.ts` | plan-step 스키마 + `validatePlan`(UNKNOWN_COMMAND / NOT_EXPOSED / INVALID_STEP) + `classifyDanger` |
| `distribute.ts` | 모드별 plan 분배(facil / turn / simul / @지목) |
| `trace.ts` | M7 `app.data` 영속 |
| `editplan.ts` | M9 순수 plan-편집 op(삭제 / 재정렬 / 파라미터 수정) |
| `rollback.ts` | M9 invertible-command 맵 + 정직 rollback |
| `scanner.ts` | M10 untrusted-content 주입 scanner |
| `macro.ts` | M11 매크로 감지 / 저장 / 실행 |

### 안전 모델 (load-bearing 불변식)
- **danger 게이트, 단일 `if` 아닌 woven.** destructive / inject step은 데스크톱 confirm을 거친다; 게이트가 실행에 엮여(confirm/파생값이 필수 입력) 단일-분기 패치로 우회 불가.
- **confirm chrome은 executor의 dom 도달 밖.** danger-confirm 모달은 `ui.tree`에 보이되 executor에게 dom-주소화 안 됨 — 악성 plan이 자기 승인을 `ui.input.click` 불가.
- **scope 매 step 강제**; untrusted-유래 destructive는 confirm 강제(M10); flagged plan은 거부, 미실행.
- **단일 실행점** — `modal.ts`는 executor만 호출(로직 누수 0); 모든 디스패치는 거기서 직렬화.

### 헤드리스 표면 (RULE: 모든 것에 command 노출)
전부 `plugin.json contributes.commands`에 선언(런타임 conformance 게이트가 declared ≡ actual 요구): `tower.plan`(slow-path NL→plan, dry-run/commit), `tower.reflect`(reflection 루프), `tower.trace`(세션 이력), `tower.scan`(untrusted-content 스캔), `tower.macro`(저장/실행/목록/삭제/승격제안). `plugin.soksak-plugin-agents-clubhouse.tower.*`로 네임스페이스.

---

## 4. 동작 방법 (사용)

- **열기**: 타이틀바 ✦ 아이콘 클릭(또는 바인딩된 단축키). 560px 드래그 가능 모달이 열림; 💬 콘텐츠 탭은 그대로.
- **NL 명령**: 예 "왼쪽 창 닫고 터미널 크게 보여줘" 타이핑; 모호 입력은 slow-path → dry-run 미리보기가 step 나열 → ⏎로 commit. 예시행/팔레트 정확 매치는 fast-path(즉답, 에이전트 0).
- **예시행**: 행 클릭 = 그 문장을 NL 바에 채우고 제출.
- **팔레트 / 검색**: 타이핑이 라이브 레지스트리 카탈로그 필터; 행이 그 command 실행(destructive ⇒ confirm).
- **dry-run 편집(M9)**: 미리보기에서 commit 전 step 삭제 / 재정렬 / 파라미터 수정; 편집 plan은 재검증.
- **다중 에이전트(M6)**: facil 모드에서 진행자가 plan을 도메인별로 `@지목`으로 분배; turn 모드는 의존 step을 라운드로빈 체인; simul은 독립 plan을 병렬. destructive confirm은 한 번에 하나씩 직렬화.
- **매크로(M11)**: 반복 trusted plan을 명명 fast-path로 저장 → 다음엔 즉시 실행.
- **헤드리스 / E2E**: `sok plugin.soksak-plugin-agents-clubhouse.tower.plan` / `.reflect` / `.trace` / `.scan` / `.macro`로 무엇이든 구동.

---

## 5. 검증

- **224 테스트**(tsc clean; vitest 14 파일), 타워 모듈(plan, executor, slowpath, distribution, trace, reflect, editplan, rollback, scanner, macro) + 대화 엔진 커버. 각 마일스톤 RED→GREEN, 사보타주 테스트로 보안 불변식 증명(confirm-자가클릭 `NOT_EXPOSED`, woven 게이트, 매 step scope).
- **소켓 검증**: 모든 기능을 `sok …tower.*` + dom-제어 표면으로 헤드리스 구동; `NOT_EXPOSED` confirm-chrome 불변식과 danger 게이트를 라이브 소켓으로 검증.
- **시각 검증**: `window.snapshot` PNG를 5테마(Cupertino / Midnight / Bare / Phosphor / Paper)에 걸쳐 Read로 직접 확인; 스타일 결함 수정·재캡처.
- 실 에이전트 발화 E2E가 실제 레이아웃 변화 산출(slow-path NL → 디스패치).

---

## 6. TODO / 참고

- 컨트롤 타워는 그 범위에서 기능-완성(M1–M11). 자연스러운 확장은 더 넓은 프로젝트 목표: 같은 3축 제어를 **폰에서 원격으로** 구동 — 그것이 코어의 폰-링크 작업(`vsterm-tauri/docs/PHONE-LINK-GUIDE.md`)이며, `command`/`dom`/`status`를 인증된 암호 채널로 노출한다. 타워와 폰-링크는 같은 substrate를 공유.
- 테마는 코어 CSS 변수(`--card`/`--bd`/`--acc`/`--accbg`/`--inset`)로만 구동되므로 per-theme 코드 유지보수 0.
- trace/매크로는 `app.data`로 영속(raw SQL 0)이라 reload 너머로 살아남고 플러그인에 네임스페이스.
