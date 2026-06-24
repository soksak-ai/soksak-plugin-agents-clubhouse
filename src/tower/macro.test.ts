// macro.test.ts — 매크로 승격(M11) 단위 테스트 (RED→GREEN, RULE 0·1·2·6·8).
//
// 매크로 = 반복되는 TRUSTED NL→plan 을 명명 fast-path 엔트리로(학습 = 명명 callable). 불변식:
//   1. 반복 탐지 — 같은 trusted plan 이 threshold 미만 → 제안 X, 도달 → 제안(RED: 너무 일찍/끝까지 제안 X).
//   2. tainted 면 승격 불가 — tainted/flagged(M10) plan 은 절대 제안/저장 0(RED: tainted 승격 → 무음 untrusted fast-path).
//   3. 제안 ≠ 자동저장 — 제안은 매크로를 영속하지 않는다(RED: 무음 저장).
//   4. 저장-매크로 fast-path — 저장된 step 을 0 planner 로 디스패치(RED: 엔진 경유).
//   5. 재검증 — command 가 라이브 도메인에서 사라지면 REFUSED(stale-execute 0)(RED: stale step 실행).
//   6. danger 보존 — destructive step 매크로는 confirm 게이트 발동, deny → 미실행(RED: 게이트 우회).
//   7. 영속 — 저장된 매크로가 reload(새 인스턴스)에서도 살아 있다(RED: reload 시 소실).
//   8. list/forget — list 가 매크로 노출, forget 이 제거 → 더는 fast-path 안 됨(RED: 유령 매크로).
//
// app.data(define/put/get/query)만 쓴다(ns 격리·코어 변경 0). fakeData=순수 메모리 store(reload 모사 외부 보유).
// 기준 미달 시 단언 약화 금지 — 구현을 고친다(RULE 2).

import { describe, expect, it, vi } from "vitest";
import { createExecutor, type ExecutorDeps } from "./executor";
import { createTrace, type DataApi, type TraceSink } from "./trace";
import { createMacroStore, detectPromotion, planSignature, promotable, type MacroSink, type PlanObservation } from "./macro";
import type { PlanStep } from "./plan";

// ── 라이브 도메인 카탈로그(검증 대조용). bogus.command 는 일부러 빠져 있다(재검증 거부 단언). ──
const CATALOG = [
  "panel.close",
  "panel.equalize",
  "theme.apply",
  "view.close",
  "editor.close",
  "state.commands",
  "ui.tree",
  "status.query",
  "theme.list",
  "state.tree",
  "panel.list",
];

// 실행을 가로채 기록하는 가짜 코어(read 명령은 fixture). plannerSpy 로 "0 planner" 단언.
function fakeApp(catalog: string[] = CATALOG) {
  const executed: Array<{ name: string; params: any }> = [];
  const app = {
    commands: {
      execute: vi.fn(async (name: string, params: any) => {
        if (name === "state.commands") return { ok: true, commands: catalog.map((c) => ({ name: c, description: c })) };
        if (name === "ui.tree") return { ok: true, nodes: [{ address: "win/main/chrome/tower/input" }] };
        if (name === "status.query") return { ok: true, statuses: [{ viewId: "v9", code: "idle" }] };
        if (name === "theme.list") return { ok: true, current: "Cupertino", mode: "dark", themes: [{ name: "Cupertino" }, { name: "Midnight" }] };
        if (name === "state.tree") return { ok: true, tree: { split: { id: "s1", sizes: [0.5, 0.5] } } };
        if (name === "panel.list") return { ok: true, panels: [{ id: "g3", active: true, views: [{ id: "v9", kind: "editor" }] }] };
        executed.push({ name, params });
        return { ok: true };
      }),
    },
  };
  return { app, executed };
}

// ── 가짜 app.data — 순수 메모리 KV(define/put/get/query). reload 모사: store 는 테스트가 보유(디스크 동형). ──
interface FakeStore {
  rows: Map<string, Map<string, Record<string, unknown>>>;
  seq: number;
}
function newStore(): FakeStore {
  return { rows: new Map(), seq: 0 };
}
function fakeData(store: FakeStore): DataApi {
  const coll = (c: string) => {
    let m = store.rows.get(c);
    if (!m) {
      m = new Map();
      store.rows.set(c, m);
    }
    return m;
  };
  return {
    define: async () => {},
    put: async (c, doc, opts) => {
      const id = opts?.id ?? `id${++store.seq}`;
      coll(c).set(id, { ...doc, id });
      return id;
    },
    get: async (c, id) => coll(c).get(id) ?? null,
    query: async (c, opts: any) => {
      let rows = [...coll(c).values()];
      const where = (opts?.where ?? {}) as Record<string, unknown>;
      rows = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      const order = typeof opts?.order === "string" ? opts.order : undefined;
      if (order) rows.sort((a, b) => ((a[order] as number) - (b[order] as number)) * (opts?.desc ? -1 : 1));
      if (typeof opts?.limit === "number") rows = rows.slice(0, opts.limit);
      return rows;
    },
  };
}

function clock() {
  let t = 1_000;
  return () => ++t;
}

// executor deps — trace + macros sink 주입(둘 다 같은 store). confirmGate 기본 수락.
function deps(
  store: FakeStore,
  over: Partial<ExecutorDeps> = {},
): { d: ExecutorDeps; executed: Array<{ name: string; params: any }>; trace: TraceSink; macros: MacroSink; app: any } {
  const { app, executed } = over.app ? { app: over.app, executed: [] as any[] } : fakeApp();
  const trace = createTrace(fakeData(store), { sessionId: "s1", now: clock() });
  const macros = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
  const d: ExecutorDeps = { app, confirmGate: async (issue) => issue(), trace, macros, ...over };
  return { d, executed, trace, macros, app };
}

// ── (1) 반복 탐지: threshold 미만 제안 X, 도달 제안 ──
describe("(1) 반복 탐지 — threshold 미만이면 제안 안 함, 도달하면 제안", () => {
  // 순수 detectPromotion 단언(결정성) — 같은 trusted plan N 회.
  const trustedPlan: PlanStep[] = [
    { axis: "command", name: "theme.apply", params: { name: "Midnight", mode: "dark" } },
    { axis: "command", name: "panel.equalize", params: { split: "s1" } },
  ];
  const obs = (n: number): PlanObservation[] =>
    Array.from({ length: n }, () => ({ nl: "어둡게 하고 반반", steps: trustedPlan }));

  it("RED 경계 — 2회(threshold 3 미만)면 proposed:false", () => {
    expect(detectPromotion(obs(2), 3)).toEqual({ proposed: false });
  });

  it("GREEN — 3회(threshold 도달)면 proposed:true + trigger/steps/count", () => {
    const p = detectPromotion(obs(3), 3);
    expect(p.proposed).toBe(true);
    if (!p.proposed) return;
    expect(p.trigger).toBe("어둡게 하고 반반");
    expect(p.steps).toEqual(trustedPlan);
    expect(p.count).toBe(3);
  });

  it("서로 다른 plan(같은 NL, 다른 steps)은 합산되지 않는다 — 각 2회면 threshold 3 미달", () => {
    const a: PlanObservation = { nl: "정리", steps: [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }] };
    const b: PlanObservation = { nl: "정리", steps: [{ axis: "command", name: "panel.equalize", params: { split: "s1" } }] };
    // 같은 NL 이지만 steps 다름 → 다른 시그니처. a×2 + b×2 = 둘 다 2회 → 어느 것도 threshold 3 미달(합산 0).
    expect(detectPromotion([a, b, a, b], 3).proposed).toBe(false);
    // 대조 — a 만 3회면 제안(시그니처별 카운트가 진실).
    expect(detectPromotion([a, b, a, b, a], 3).proposed).toBe(true);
  });

  it("executor.proposeMacro — committed plan 이 3회 재발하면 제안(trace history 기반)", async () => {
    const store = newStore();
    const { d } = deps(store);
    const ex = createExecutor(d);
    const plan: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }];
    // 같은 trusted plan 을 3회 commit(실제 실행 — 의도 확인).
    for (let i = 0; i < 3; i++) {
      const r = await ex.planAndRun("어둡게", { injectPlan: plan, trace: { nl: "어둡게", mode: "solo" } });
      if (!r.ok) throw new Error("dry-run 실패");
      await r.commit();
    }
    const prop = await ex.proposeMacro(3);
    expect(prop.proposed).toBe(true);
    if (!prop.proposed) return;
    expect(prop.trigger).toBe("어둡게");
    expect(prop.steps.map((s) => s.name)).toEqual(["theme.apply"]);
  });

  it("executor.proposeMacro — 2회만이면 제안 X(RED: 너무 일찍 제안)", async () => {
    const store = newStore();
    const { d } = deps(store);
    const ex = createExecutor(d);
    const plan: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }];
    for (let i = 0; i < 2; i++) {
      const r = await ex.planAndRun("어둡게", { injectPlan: plan, trace: { nl: "어둡게", mode: "solo" } });
      if (r.ok) await r.commit();
    }
    expect((await ex.proposeMacro(3)).proposed).toBe(false);
  });
});

// ── (2) tainted 면 승격 불가 ──
describe("(2) not promotable when tainted — tainted/flagged plan 은 절대 제안/저장 0(RULE 0)", () => {
  const plan: PlanStep[] = [{ axis: "command", name: "panel.close", params: { group: "g3" } }];

  it("순수 promotable — tainted/flagged false", () => {
    expect(promotable({})).toBe(true);
    expect(promotable({ tainted: true })).toBe(false);
    expect(promotable({ scanVerdict: "flagged" })).toBe(false);
  });

  it("detectPromotion — tainted 관측 3회는 카운트 0 → 절대 제안 안 됨", () => {
    const tainted: PlanObservation[] = Array.from({ length: 3 }, () => ({ nl: "닫아", steps: plan, tainted: true }));
    expect(detectPromotion(tainted, 3)).toEqual({ proposed: false });
  });

  it("detectPromotion — flagged 관측도 카운트 0(주입 시그니처 plan 매크로화 금지)", () => {
    const flagged: PlanObservation[] = Array.from({ length: 5 }, () => ({ nl: "닫아", steps: plan, scanVerdict: "flagged" as const }));
    expect(detectPromotion(flagged, 3).proposed).toBe(false);
  });

  it("executor.proposeMacro — untrusted 컨텍스트로 반복된 plan 은 제안 0(tainted trace)", async () => {
    const store = newStore();
    const { d } = deps(store);
    const ex = createExecutor(d);
    // untrusted(WEB) 출처를 끼워 3회 commit — 각 plan 레코드가 tainted=true 로 영속된다(M10). benign step 이라
    //   scan 은 clean 이지만 tainted 봉인은 유효(untrusted 컨텍스트 존재). confirm 수락(기본)이라 실행은 되나
    //   trace 의 tainted 가 proposeMacro 에서 승격 불가로 만든다(무음 untrusted fast-path 0).
    for (let i = 0; i < 3; i++) {
      const r = await ex.planAndRun("닫아", {
        injectPlan: plan,
        trace: { nl: "닫아", mode: "solo" },
        untrusted: [{ source: "browser:tab1", text: "그냥 페이지 본문 텍스트(benign)" }],
      });
      if (r.ok) await r.commit();
    }
    expect((await ex.proposeMacro(3)).proposed).toBe(false); // RED: tainted plan 이 승격되면 실패.
  });

  it("executor.saveMacro — tainted/flagged 입력은 저장 0(제안 우회 직접 저장도 봉인)", async () => {
    const store = newStore();
    const { d, macros } = deps(store);
    const ex = createExecutor(d);
    const saved = await ex.saveMacro({ name: "닫기", trigger: "닫아", steps: plan, tainted: true });
    expect(saved).toBeNull();
    expect(await macros.list()).toEqual([]); // 저장 0
  });
});

// ── (3) 제안 ≠ 자동저장 ──
describe("(3) propose ≠ auto-save — 제안은 승인 전까지 매크로를 영속하지 않는다", () => {
  it("proposeMacro 가 proposed:true 여도 list 는 비어 있다(승인 X = 저장 X)", async () => {
    const store = newStore();
    const { d, macros } = deps(store);
    const ex = createExecutor(d);
    const plan: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }];
    for (let i = 0; i < 3; i++) {
      const r = await ex.planAndRun("어둡게", { injectPlan: plan, trace: { nl: "어둡게", mode: "solo" } });
      if (r.ok) await r.commit();
    }
    const prop = await ex.proposeMacro(3);
    expect(prop.proposed).toBe(true);
    // ⚠️ 제안만 — 아직 저장 0(RED: 무음 자동저장이면 list 가 1).
    expect(await macros.list()).toEqual([]);
    expect(await ex.listMacros()).toEqual([]);
  });
});

// ── (4) 저장-매크로 fast-path: 0 planner ──
describe("(4) saved-macro fast-path — 저장된 step 을 0 planner 로 디스패치", () => {
  it("runMacro 는 저장된 step 을 실행하되 planner 를 한 번도 호출하지 않는다", async () => {
    const store = newStore();
    const plannerSpy = vi.fn(async () => "[]"); // 호출되면 실패해야 함(fast-path = 엔진 미경유).
    const { d, executed } = deps(store, { planner: plannerSpy });
    const ex = createExecutor(d);
    const steps: PlanStep[] = [
      { axis: "command", name: "theme.apply", params: { name: "Midnight" } },
      { axis: "command", name: "panel.equalize", params: { split: "s1" } },
    ];
    const saved = await ex.saveMacro({ name: "야간정리", trigger: "어둡게 하고 반반", steps });
    expect(saved).not.toBeNull();
    const r = await ex.runMacro("야간정리");
    expect(r.ok).toBe(true);
    // 저장된 step 이 그대로 디스패치됨.
    expect(executed.map((e) => e.name)).toEqual(["theme.apply", "panel.equalize"]);
    // ⚠️ 0 planner — fast-path SOURCE 라 엔진 미경유(RED: 엔진 경유면 plannerSpy 호출됨).
    expect(plannerSpy).not.toHaveBeenCalled();
  });
});

// ── (5) 재검증: command 가 사라지면 REFUSED(stale 0) ──
describe("(5) re-validation — 저장된 step 의 command 가 라이브 도메인에서 사라지면 REFUSED", () => {
  it("저장은 풀카탈로그에서, 실행은 그 command 가 빠진 카탈로그 → MACRO_REFUSED, 디스패치 0", async () => {
    const store = newStore();
    // 저장 시점 — view.close 가 카탈로그에 있다.
    const full = fakeApp(CATALOG);
    const trace1 = createTrace(fakeData(store), { sessionId: "s1", now: clock() });
    const macros1 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    const exSave = createExecutor({ app: full.app, confirmGate: async (i) => i(), trace: trace1, macros: macros1 });
    const steps: PlanStep[] = [{ axis: "command", name: "view.close", params: { view: "v9" } }];
    await exSave.saveMacro({ name: "탭닫기", trigger: "탭 닫아", steps });

    // 실행 시점 — view.close 가 사라진 카탈로그(플러그인 비활성 등). 같은 store 의 새 macros sink.
    const reduced = fakeApp(CATALOG.filter((c) => c !== "view.close"));
    const macros2 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    const exRun = createExecutor({ app: reduced.app, confirmGate: async (i) => i(), macros: macros2 });
    const r = await exRun.runMacro("탭닫기");
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("refused");
    if (r.stage !== "refused") return;
    expect(r.code).toBe("MACRO_REFUSED");
    expect(r.refusal.code).toBe("UNKNOWN_COMMAND");
    // ⚠️ stale 0 — 어떤 step 도 디스패치되지 않았다(RED: stale view.close 실행).
    expect(reduced.executed).toEqual([]);
  });
});

// ── (6) danger 보존: destructive step 매크로도 confirm 게이트 ──
describe("(6) danger preserved — destructive step 매크로는 confirm 게이트, deny → 미실행", () => {
  const steps: PlanStep[] = [{ axis: "command", name: "panel.close", params: { group: "g3" } }];

  it("confirm deny → destructive 매크로 미실행(게이트 우회 0)", async () => {
    const store = newStore();
    const confirmGate = vi.fn(async () => null); // deny
    const { d, executed } = deps(store, { confirmGate });
    const ex = createExecutor(d);
    await ex.saveMacro({ name: "패널닫기", trigger: "패널 닫아", steps });
    const r = await ex.runMacro("패널닫기");
    expect(r.ok).toBe(false); // confirm 거부 → 실패.
    expect(confirmGate).toHaveBeenCalledTimes(1); // ⚠️ 게이트 발동(RED: 매크로가 게이트 우회면 0회).
    expect(executed).toEqual([]); // 미실행.
  });

  it("confirm accept → destructive 매크로 실행(긍정 — 게이트 통과 후엔 실행)", async () => {
    const store = newStore();
    const confirmGate = vi.fn(async (issue: () => string) => issue()); // accept
    const { d, executed } = deps(store, { confirmGate });
    const ex = createExecutor(d);
    await ex.saveMacro({ name: "패널닫기", trigger: "패널 닫아", steps });
    const r = await ex.runMacro("패널닫기");
    expect(r.ok).toBe(true);
    expect(confirmGate).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([{ name: "panel.close", params: { group: "g3" } }]);
  });
});

// ── (7) 영속: reload 후에도 매크로가 살아 있다 ──
describe("(7) persistence — 저장된 매크로가 reload(새 인스턴스)에서도 살아 있다", () => {
  it("저장 후 같은 store 의 새 macros sink 가 매크로를 재조회한다(인메모리면 소실=RED)", async () => {
    const store = newStore();
    const steps: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }];
    const macros1 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    await macros1.save({ name: "야간", trigger: "어둡게", steps });

    // reload 모사 — 같은 store, 완전히 새 인스턴스.
    const macros2 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    const list = await macros2.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "야간", trigger: "어둡게" });
    expect(list[0].steps).toEqual(steps);
    // reload 후 runMacro 도 동작 — fast-path 가 영속을 진실로 쓴다.
    const reduced = fakeApp(CATALOG);
    const exRun = createExecutor({ app: reduced.app, confirmGate: async (i) => i(), macros: macros2 });
    const r = await exRun.runMacro("야간");
    expect(r.ok).toBe(true);
    expect(reduced.executed.map((e) => e.name)).toEqual(["theme.apply"]);
  });
});

// ── (8) list/forget: forget 후 더는 fast-path 안 됨 ──
describe("(8) list/forget — list 가 매크로 노출, forget 이 제거 → 유령 매크로 0", () => {
  it("두 매크로 저장 → list 둘 다, forget 하나 → list 하나 + 그 매크로 runMacro 는 NOT_FOUND", async () => {
    const store = newStore();
    const { d } = deps(store);
    const ex = createExecutor(d);
    await ex.saveMacro({ name: "a", trigger: "에이", steps: [{ axis: "command", name: "theme.apply", params: { name: "Midnight" } }] });
    await ex.saveMacro({ name: "b", trigger: "비", steps: [{ axis: "command", name: "panel.equalize", params: { split: "s1" } }] });
    expect((await ex.listMacros()).map((m) => m.name).sort()).toEqual(["a", "b"]);

    const forgot = await ex.forgetMacro("a");
    expect(forgot).toBe(true);
    expect((await ex.listMacros()).map((m) => m.name)).toEqual(["b"]); // a 사라짐.

    // ⚠️ forget 후 — a 는 더는 fast-path 안 됨(RED: 유령 매크로면 실행됨).
    const r = await ex.runMacro("a");
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("not-found");
  });

  it("forget — 없던 이름이면 false(정직)", async () => {
    const store = newStore();
    const { d } = deps(store);
    const ex = createExecutor(d);
    expect(await ex.forgetMacro("없음")).toBe(false);
  });

  it("forget 은 reload 후에도 영속된다(tombstone 이 재조회에서도 걸러진다)", async () => {
    const store = newStore();
    const macros1 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    await macros1.save({ name: "x", trigger: "엑스", steps: [{ axis: "command", name: "theme.apply", params: {} }] });
    await macros1.forget("x");
    const macros2 = createMacroStore(fakeData(store), { sessionId: "s1", now: clock() });
    expect(await macros2.list()).toEqual([]); // reload 후에도 유령 0.
    expect(await macros2.byName("x")).toBeNull();
  });
});

// ── 단일 진실: 매크로 컬렉션 이름 안정성(코어 ns) ──
describe("매크로 컬렉션 이름 — 플러그인 ns(코어 테이블 아님)", () => {
  it("planSignature 는 params 키 순서 무관 동일(정렬 직렬화)", () => {
    const a: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { name: "M", mode: "dark" } }];
    const b: PlanStep[] = [{ axis: "command", name: "theme.apply", params: { mode: "dark", name: "M" } }];
    expect(planSignature("x", a)).toBe(planSignature("x", b));
  });
});
