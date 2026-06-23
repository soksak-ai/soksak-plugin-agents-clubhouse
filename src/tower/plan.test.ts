// plan.ts 보안 단위 테스트 (RED→GREEN, RULE 1). 순수 검증 — 미등록 command/주소 거부 + danger 분류 미러.
//
// RED 의 핵심: 검증이 없으면 가짜 command(`nope.nonexistent`)·가짜 주소가 그대로 통과(취약).
// validatePlan 이 라이브 카탈로그/ui.tree 대조로 거부해야 GREEN. 기준 미달 시 이 단언을 약화하지 말고
// 구현을 고친다(배신 금지).

import { describe, expect, it } from "vitest";
import {
  validatePlan,
  classifyDanger,
  buildPlanSystemPrompt,
  parsePlan,
  planContextFromDomain,
  EXAMPLE_COMMANDS,
  type PlanStep,
  type PlanContext,
  type DomainMap,
} from "./plan";

// 라이브 카탈로그/ui.tree 를 흉내내는 검증 컨텍스트.
const ctx = (): PlanContext => ({
  commandNames: new Set(["panel.close", "panel.equalize", "theme.apply", "state.commands", "ui.tree", "ui.input.click", "status.query"]),
  domAddresses: new Set(["win/main/chrome/tower/input", "win/main/proj/x/content/pane/0/view/p.v/node/a"]),
});

describe("validatePlan — 미등록 command 거부 (RED→GREEN)", () => {
  it("미등록 command 는 거부된다 (검증 없으면 통과=취약, RED 입증 대상)", () => {
    const steps: PlanStep[] = [{ axis: "command", name: "nope.nonexistent" }];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_COMMAND");
  });

  it("등록된 command 는 통과한다 (긍정)", () => {
    const steps: PlanStep[] = [{ axis: "command", name: "panel.equalize", params: { split: "s1" } }];
    expect(validatePlan(steps, ctx()).ok).toBe(true);
  });

  it("여러 step 중 하나라도 미등록이면 전체 거부", () => {
    const steps: PlanStep[] = [
      { axis: "command", name: "theme.apply", params: { name: "Cupertino" } },
      { axis: "command", name: "fake.evil" },
    ];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.index).toBe(1);
  });
});

describe("validatePlan — 미등록 dom 주소 거부 (RED→GREEN)", () => {
  it("ui.tree 에 없는 주소는 거부된다", () => {
    const steps: PlanStep[] = [{ axis: "dom", name: "ui.input.click", address: "win/main/chrome/nope/fake" }];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_EXPOSED");
  });

  it("ui.tree 에 있는 주소는 통과한다 (긍정)", () => {
    const steps: PlanStep[] = [{ axis: "dom", name: "ui.input.click", address: "win/main/chrome/tower/input" }];
    expect(validatePlan(steps, ctx()).ok).toBe(true);
  });

  it("dom step 에 address 가 빠지면 거부", () => {
    const steps: PlanStep[] = [{ axis: "dom", name: "ui.input.click" }];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_STEP");
  });
});

describe("validatePlan — 축/형태 검증", () => {
  it("알 수 없는 axis 는 거부", () => {
    const steps = [{ axis: "shell", name: "panel.close" } as unknown as PlanStep];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_STEP");
  });

  it("command step 에 name 이 없으면 거부", () => {
    const steps = [{ axis: "command" } as unknown as PlanStep];
    const r = validatePlan(steps, ctx());
    expect(r.ok).toBe(false);
  });

  it("status step 도 미등록 command 면 거부(축3도 레지스트리 대조)", () => {
    const steps: PlanStep[] = [{ axis: "status", name: "status.nope" }];
    expect(validatePlan(steps, ctx()).ok).toBe(false);
  });
});

describe("classifyDanger — 코어 레지스트리 danger 미러 (단일 진실)", () => {
  it("destructive close 류는 destructive 로 분류", () => {
    expect(classifyDanger("panel.close")).toBe("destructive");
    expect(classifyDanger("view.close")).toBe("destructive");
    expect(classifyDanger("content.close")).toBe("destructive");
    expect(classifyDanger("project.close")).toBe("destructive");
    expect(classifyDanger("secret.delete")).toBe("destructive");
  });

  it("inject 류(입력 주입)는 inject 로 분류", () => {
    expect(classifyDanger("ui.input.click")).toBe("inject");
    expect(classifyDanger("ui.input.fill")).toBe("inject");
    expect(classifyDanger("term.send")).toBe("inject");
    expect(classifyDanger("clipboard.write")).toBe("inject");
  });

  it("비파괴 command 는 undefined (게이트 없음)", () => {
    expect(classifyDanger("theme.apply")).toBeUndefined();
    expect(classifyDanger("panel.equalize")).toBeUndefined();
    expect(classifyDanger("state.commands")).toBeUndefined();
    expect(classifyDanger("panel.list")).toBeUndefined();
  });
});

// ── M5 도메인맵 주입 + plan 파싱(순수) ──

const DOMAIN: DomainMap = {
  commands: [
    { name: "panel.close", description: "패널 닫기 | 트리거…" },
    { name: "theme.apply", description: "테마 적용 | 트리거…" },
    { name: "status.query", description: "상태 조회" },
  ],
  addresses: ["win/main/chrome/tower/input", "win/main/proj/x/content/pane/0"],
  statuses: [{ viewId: "v9", code: "dirty", message: "미저장" }],
};

describe("buildPlanSystemPrompt — 도메인맵 라이브 주입", () => {
  it("축1 command 이름, 축2 주소, 축3 상태를 전부 프롬프트에 싣는다(전수 노출)", () => {
    const p = buildPlanSystemPrompt("패널 닫고 어둡게", DOMAIN);
    expect(p).toContain("패널 닫고 어둡게"); // 사용자 NL
    expect(p).toContain("panel.close"); // 축1
    expect(p).toContain("theme.apply");
    expect(p).toContain("win/main/chrome/tower/input"); // 축2
    expect(p).toContain("v9"); // 축3
    expect(p).toContain("dirty");
  });

  it("description 의 ' | ' 뒤 트리거 합성본은 잘라 base 만 싣는다", () => {
    const p = buildPlanSystemPrompt("x", DOMAIN);
    expect(p).toContain("패널 닫기");
    expect(p).not.toContain("패널 닫기 | 트리거"); // 합성 트리거어는 프롬프트에 안 들어감
  });

  it("correction 이 있으면 직전 거부 사유를 self-correct 블록으로 덧붙인다", () => {
    const p = buildPlanSystemPrompt("x", DOMAIN, "step #0 거부: 미등록 command: nope.evil");
    expect(p).toContain("거부");
    expect(p).toContain("nope.evil");
  });

  it("주소/상태가 비면 '(없음)' 으로 표기(빈 칸 노출, 가짜 주소 0)", () => {
    const empty: DomainMap = { commands: [], addresses: [], statuses: [] };
    const p = buildPlanSystemPrompt("x", empty);
    expect(p).toContain("(없음)");
  });
});

describe("parsePlan — LLM 출력 내성(코드펜스/산문)", () => {
  it("순수 JSON 배열을 파싱한다", () => {
    const r = parsePlan('[{"axis":"command","name":"theme.apply"}]');
    expect(r).toEqual([{ axis: "command", name: "theme.apply" }]);
  });

  it("```json 펜스로 감싼 배열을 파싱한다", () => {
    const r = parsePlan('PLAN:\n```json\n[{"axis":"command","name":"panel.close"}]\n```\n끝');
    expect(r?.[0]).toMatchObject({ name: "panel.close" });
  });

  it("산문에 섞인 첫 균형 배열을 추출한다(중첩 [] 안전)", () => {
    const r = parsePlan('이렇게요: [{"axis":"command","name":"x","params":{"arr":[1,2]}}] 입니다.');
    expect(r?.[0]).toMatchObject({ name: "x" });
  });

  it("배열이 아니면(객체 단독) null", () => {
    expect(parsePlan('{"axis":"command","name":"x"}')).toBeNull();
  });

  it("JSON 이 전혀 없으면 null", () => {
    expect(parsePlan("미안하지만 못 하겠어요.")).toBeNull();
  });
});

describe("planContextFromDomain — 도메인맵 → 검증 컨텍스트(단일 진실)", () => {
  it("command 이름 집합·주소 집합을 그대로 옮긴다", () => {
    const ctx2 = planContextFromDomain(DOMAIN);
    expect(ctx2.commandNames.has("panel.close")).toBe(true);
    expect(ctx2.commandNames.has("nope")).toBe(false);
    expect(ctx2.domAddresses.has("win/main/chrome/tower/input")).toBe(true);
  });

  it("도메인맵으로 만든 컨텍스트가 validatePlan 과 일관(같은 진실)", () => {
    const ctx2 = planContextFromDomain(DOMAIN);
    expect(validatePlan([{ axis: "command", name: "theme.apply" }], ctx2).ok).toBe(true);
    expect(validatePlan([{ axis: "command", name: "ghost.cmd" }], ctx2).ok).toBe(false);
  });
});

describe("EXAMPLE_COMMANDS — 5 예시행 → 실 command 매핑", () => {
  it("5개 모두 매핑되어 있다", () => {
    expect(EXAMPLE_COMMANDS).toHaveLength(5);
  });

  it("에디터/터미널 닫기 예시는 destructive command 로 매핑", () => {
    // index 0 = "에디터 패널 닫아줘", index 1 = "터미널 패널 닫아줘"
    expect(classifyDanger(EXAMPLE_COMMANDS[0].command)).toBe("destructive");
    expect(classifyDanger(EXAMPLE_COMMANDS[1].command)).toBe("destructive");
  });

  it("분할/다크/다음테마 예시는 비파괴 command 로 매핑", () => {
    expect(classifyDanger(EXAMPLE_COMMANDS[2].command)).toBeUndefined();
    expect(classifyDanger(EXAMPLE_COMMANDS[3].command)).toBeUndefined();
    expect(classifyDanger(EXAMPLE_COMMANDS[4].command)).toBeUndefined();
  });

  it("매핑된 command 는 전부 코어 카탈로그에 존재할 법한 정식 이름(점 표기)", () => {
    for (const e of EXAMPLE_COMMANDS) {
      expect(e.command).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });
});
