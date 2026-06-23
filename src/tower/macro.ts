// macro.ts — 매크로 승격(M11). 반복되는 TRUSTED NL→plan 을 명명 매크로로 저장 제안 → 다음엔 fast-path 즉시 실행.
//   "학습 = 명명 callable". 단, 코어 레지스트리에 새 command 이름을 동적 등록할 수는 없다(conformance:
//   plugin.json contributes.commands 가 모든 이름을 사전 선언해야 하므로 — 사용자-coined 런타임 이름은 불가).
//   그래서 매크로는 app.data(M7 인프라)에 영속되고 단일 사전선언 command tower.macro(save/run/list/forget) +
//   모달 팔레트로 노출된다. 매크로는 타워 *안의* 명명 fast-path 엔트리지 새 코어 레지스트리 이름이 아니다
//   (RULE 8 노출 + conformance 법칙 동시 충족).
//
// ── 순수 로직(I/O 0): planSignature(반복 탐지 키) + Promoter(임계 도달 판정) ──
//   planSignature = 정규화 NL + 정렬된 step 시그니처. 같은 trusted 요청이 같은 plan 으로 ≥ threshold 회
//   재발하면 승격 제안(human-approval — design-constitution graduation 동형, 절대 무음 자동저장 0).
//
// ── 영속(app.data, M7 동일 표면): MacroSink — save/get/list/forget. ns=pluginId 격리, raw SQL 0, 코어 변경 0 ──
//   매크로 = { name, trigger(NL), steps[], createdAt }. reload 후에도 같은 ns 로 재조회(인메모리 아님).
//
// ⚠️ 승격 가능 조건(RULE 0 no-bypass): trusted(untrusted 컨텍스트 0) + scanner-clean + non-tainted 한 plan 만
//   승격 가능. tainted/flagged(M10) plan 은 절대 매크로가 될 수 없다 — 그러면 untrusted-derived step 의 무음
//   fast-path 가 생긴다(금지). 이 봉인은 promotable() 단일 술어로 강제된다(승격 입력의 게이트).

import type { PlanStep } from "./plan";
import type { DataApi } from "./trace";

// 영속된 매크로 — 명명 fast-path 엔트리. trigger = 원 NL(정확매치 fast-path 키), steps = 저장된 plan.
//   createdAt = 저장 시각. id = app.data put 이 부여(= forget/get 키). name 은 사용자-coined(유일 키 — 같은
//   이름 재저장은 덮어쓰기).
export interface Macro {
  id: string;
  name: string;
  trigger: string;
  steps: PlanStep[];
  createdAt: number;
}

// 저장 입력(id/createdAt 은 sink 가 채움).
export interface MacroInput {
  name: string;
  trigger: string;
  steps: PlanStep[];
}

// 매크로 컬렉션(플러그인 ns 안의 논리 이름 — 코어 테이블 아님). 안정 상수(테스트 단언 대상).
export const MACROS = "tower_macros";
const MACROS_SCHEMA = { indexes: ["sessionId", "name", "createdAt"] };

// ── 순수: plan 시그니처(반복 탐지 키) ──
//
// 정규화 NL — 트림 + 소문자 + 연속 공백 1칸. 같은 의도를 같은 키로 묶되, 자명한 표기 차(대소문자·공백)만
//   흡수한다(과한 정규화로 다른 요청을 같은 키로 합치면 가짜 승격이 된다 — 보수적으로).
export function normalizeNl(nl: string): string {
  return nl.trim().toLowerCase().replace(/\s+/g, " ");
}

// 한 step 의 시그니처 — axis + name + (정렬된 params 키/값 또는 address). params 는 키 정렬로 직렬화해
//   { a:1, b:2 } 와 { b:2, a:1 } 이 같은 시그니처가 되게 한다(순서 무관 동일 plan = 동일 키). dom 은 address.
export function stepSignature(s: PlanStep): string {
  if (s.axis === "dom") return `dom|${s.name}|${s.address ?? ""}`;
  const p = s.params && typeof s.params === "object" ? stableStringify(s.params) : "";
  return `${s.axis}|${s.name}|${p}`;
}

// plan 시그니처 — 정규화 NL + 순서대로 이은 step 시그니처. 같은 NL 이라도 step 이 다르면 다른 plan(다른 키),
//   같은 NL+같은 ordered steps 면 같은 키(반복). step 순서는 의미가 있으므로 보존(정렬하지 않는다).
export function planSignature(nl: string, steps: PlanStep[]): string {
  return `${normalizeNl(nl)}::${steps.map(stepSignature).join(">>")}`;
}

// 안정 직렬화 — 객체 키를 재귀 정렬해 동일 내용이면 동일 문자열(JSON.stringify 키 순서 의존 제거).
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

// ── 순수: 승격 가능 술어(RULE 0 봉인) ──
//
// 한 plan 관측이 매크로로 승격 가능한가 — trusted(untrusted 0) + scanner-clean + non-tainted 셋 다여야 한다.
//   tainted/flagged(M10)면 false(절대 승격 0 — 무음 untrusted fast-path 금지). 단일 술어라 우회점 0.
export interface PromotionInput {
  tainted?: boolean; // M10 — untrusted 컨텍스트 유래(forced-gate). true 면 승격 불가.
  scanVerdict?: "clean" | "flagged"; // M10 — scanner 판정. flagged 면 승격 불가.
}
export function promotable(p: PromotionInput): boolean {
  if (p.tainted) return false; // untrusted 유래 — 매크로화 금지.
  if (p.scanVerdict === "flagged") return false; // 주입 시그니처 — 매크로화 금지.
  return true;
}

// ── 순수: 반복 탐지 → 승격 제안(human-approval) ──
//
// 관측(trace 또는 app.data history 에서 추출) = { nl, steps, tainted?, scanVerdict? } 들. 같은 plan
//   시그니처가 promotable 한 관측으로 ≥ threshold 회 재발하면 승격 제안을 만든다(자동저장 X — 제안만).
//   tainted/flagged 관측은 카운트에서 제외(promotable 통과분만 셈) — tainted 가 끼면 그 시그니처는 절대
//   threshold 에 못 닿는다(RULE 0). 제안은 가장 먼저 임계 도달한 시그니처 1건(결정적).
export interface PlanObservation {
  nl: string;
  steps: PlanStep[];
  tainted?: boolean;
  scanVerdict?: "clean" | "flagged";
}

// 승격 제안 — 사람이 승인하면 saveMacro 로 영속. proposed=true 면 trigger/steps/count 를 담는다.
//   count = promotable 관측 중 이 시그니처의 재발 횟수(≥ threshold). signature = 디버그·중복 가드 키.
export type PromotionProposal =
  | { proposed: false }
  | { proposed: true; trigger: string; steps: PlanStep[]; count: number; signature: string };

// 반복 탐지(순수) — observations 를 시그니처로 묶어 promotable 관측만 센다. threshold(기본 3) 도달 시
//   가장 먼저 도달한 시그니처를 제안. tainted/flagged 관측은 카운트 0(승격 절대 불가). 제안 ≠ 저장 —
//   호출자(executor.proposeMacro)가 이 제안을 사람에게 띄우고, 승인 시에만 saveMacro 를 부른다.
export function detectPromotion(observations: PlanObservation[], threshold = 3): PromotionProposal {
  // 시그니처 → { count(promotable 만), 첫 promotable 관측의 nl/steps, 도달 순번 } 누적.
  const acc = new Map<string, { count: number; trigger: string; steps: PlanStep[]; reachedAt: number }>();
  let order = 0;
  let winner: { signature: string; reachedAt: number } | null = null;
  for (const o of observations) {
    // RULE 0 — promotable 통과 관측만 센다. tainted/flagged 는 시그니처 카운트에 1도 더하지 않는다.
    if (!promotable(o)) continue;
    const sig = planSignature(o.nl, o.steps);
    let e = acc.get(sig);
    if (!e) {
      e = { count: 0, trigger: o.nl.trim(), steps: o.steps, reachedAt: -1 };
      acc.set(sig, e);
    }
    e.count++;
    if (e.count === threshold) {
      e.reachedAt = order++;
      // 가장 먼저 임계 도달한 시그니처가 우승(결정적). 이미 우승이 있으면 더 이른 것 유지.
      if (!winner || e.reachedAt < winner.reachedAt) winner = { signature: sig, reachedAt: e.reachedAt };
    }
  }
  if (!winner) return { proposed: false };
  const e = acc.get(winner.signature)!;
  return { proposed: true, trigger: e.trigger, steps: e.steps, count: e.count, signature: winner.signature };
}

// ── 영속 sink(app.data, M7 동일 표면) ──
//
// MacroSink — save/get/list/forget. ns=pluginId(코어 격리) 안에서 sessionId 로 세션별 매크로 분리한다.
//   reload 후 같은 store(디스크)·같은 sessionId 면 같은 매크로가 재조회된다(영속 단언). 코어 커플링 0.
export interface MacroSink {
  sessionId: string;
  // 저장 — 같은 name 이 있으면 그 id 에 덮어쓴다(이름 = 유일 키). 새 이름이면 새 레코드. 저장된 Macro 반환.
  save: (m: MacroInput) => Promise<Macro>;
  // 이름으로 1건 조회(fast-path 실행·trigger 매치용). 없으면 null.
  byName: (name: string) => Promise<Macro | null>;
  // trigger(원 NL) 정확매치로 1건 조회(타워 바 NL exact-trigger fast-path). 없으면 null.
  byTrigger: (trigger: string) => Promise<Macro | null>;
  // 전체 목록(createdAt 오름차순 — 저장 순서). 팔레트·tower.macro list 가 쓴다.
  list: () => Promise<Macro[]>;
  // 이름으로 삭제. 삭제했으면 true, 없던 이름이면 false(정직).
  forget: (name: string) => Promise<boolean>;
}

export interface MacroOptions {
  sessionId: string;
  now?: () => number;
}

export function createMacroStore(data: DataApi, opts: MacroOptions): MacroSink {
  const now = opts.now ?? (() => Date.now());
  const sessionId = opts.sessionId;

  let defined: Promise<void> | null = null;
  const ensureDefined = (): Promise<void> => {
    if (!defined) {
      defined = (async () => {
        await data.define(MACROS, MACROS_SCHEMA);
      })().catch(() => {
        // define 실패(이미 정의 등)는 무해 — put 이 진실 게이트.
      });
    }
    return defined;
  };

  // 이름 → 기존 레코드(있으면 그 id 에 덮어쓰기 위함). 세션 격리 + 이름 일치.
  async function findByName(name: string): Promise<Macro | null> {
    await ensureDefined();
    const rows = await data.query(MACROS, { where: { sessionId, name }, limit: 1 });
    return (rows[0] as unknown as Macro) ?? null;
  }

  async function save(m: MacroInput): Promise<Macro> {
    await ensureDefined();
    const existing = await findByName(m.name);
    const createdAt = existing?.createdAt ?? now();
    const doc: Record<string, unknown> = {
      sessionId,
      name: m.name,
      trigger: m.trigger,
      steps: m.steps,
      createdAt,
    };
    // 같은 이름 → 같은 id 에 덮어쓰기(이름 유일 키). 새 이름 → 새 id.
    const id = await data.put(MACROS, doc, existing ? { id: existing.id } : undefined);
    return { id, name: m.name, trigger: m.trigger, steps: m.steps, createdAt };
  }

  async function byName(name: string): Promise<Macro | null> {
    return findByName(name);
  }

  async function byTrigger(trigger: string): Promise<Macro | null> {
    await ensureDefined();
    const rows = await data.query(MACROS, { where: { sessionId, trigger }, limit: 1 });
    return (rows[0] as unknown as Macro) ?? null;
  }

  async function list(): Promise<Macro[]> {
    await ensureDefined();
    const rows = await data.query(MACROS, { where: { sessionId }, order: "createdAt", desc: false, limit: 1000 });
    return rows as unknown as Macro[];
  }

  async function forget(name: string): Promise<boolean> {
    const existing = await findByName(name);
    if (!existing) return false;
    // app.data 는 delete 표면이 없으므로(DataApi 부분집합) tombstone 으로 무력화 — 같은 id 에 빈/forgotten
    //   레코드를 덮어쓰고 list/byName 이 그것을 거른다. 정직: 실제 행은 남지만 forgotten 플래그로 유령 0.
    await data.put(MACROS, { sessionId, name, forgotten: true, createdAt: existing.createdAt }, { id: existing.id });
    return true;
  }

  // forgotten tombstone 을 거르는 list/byName 래퍼(위 query 결과를 필터). DataApi 가 delete 를 노출하지
  //   않으므로(코어 무강결합 — 부분집합만) tombstone 이 단일 정공법. 행이 forgotten=true 면 없는 것처럼 취급.
  const isLive = (m: any): m is Macro => m && !m.forgotten && typeof m.name === "string" && Array.isArray(m.steps);
  return {
    sessionId,
    save,
    byName: async (name) => {
      const m = await byName(name);
      return isLive(m) ? m : null;
    },
    byTrigger: async (trigger) => {
      const m = await byTrigger(trigger);
      return isLive(m) ? m : null;
    },
    list: async () => (await list()).filter(isLive),
    forget,
  };
}
