// plan.ts 보안 단위 테스트 (RED→GREEN, RULE 1). 순수 검증 — 미등록 command/주소 거부 + danger 분류 미러.
//
// RED 의 핵심: 검증이 없으면 가짜 command(`nope.nonexistent`)·가짜 주소가 그대로 통과(취약).
// validatePlan 이 라이브 카탈로그/ui.tree 대조로 거부해야 GREEN. 기준 미달 시 이 단언을 약화하지 말고
// 구현을 고친다(배신 금지).

import { describe, expect, it } from "vitest";
import {
  validatePlan,
  classifyDanger,
  EXAMPLE_COMMANDS,
  type PlanStep,
  type PlanContext,
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
