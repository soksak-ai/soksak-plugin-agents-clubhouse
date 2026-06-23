// executor.ts — 타워의 유일 실행점(RULE 6). 모든 fast-path(예시행·팔레트)와 향후 slow-path plan 이
//   여기 한 곳을 거쳐 app.commands.execute 로 직렬화된다(입력 race 0, 불변식 강제 1곳).
//
// fast-path: 예시행 → EXAMPLE_COMMANDS 의 command + 라이브 파라미터 / 팔레트행 → 그 command 자체.
//   destructive 는 퍼지매치 금지(정확매치만). danger 면 confirm 게이트 경유 후에야 실행.
//
// ── DANGER-CONFIRM 게이트(보안 핵심, 매트릭스 불변식) ──
//  (a) destructive/inject → confirm 모달이 실행 전에 뜬다. 거부/타임아웃 → 미실행.
//  (b) ⚠️ confirm accept 는 executor 의 dom 도달 밖:
//      - 모달 accept 컨트롤에 data-node 없음 → collectExposed 미수집 → ui.input.click NOT_EXPOSED.
//      - 그리고 executor.runDom 은 "confirm" 을 포함한 보안-chrome 주소를 명시 거부(FORBIDDEN_CHROME)
//        — 악성 plan 이 어떤 우회로도 자기 게이트를 클릭 못 한다. 컨테이너 data-node 는 노출(가시성).
//  (c) 게이트가 실행에 엮인다(단일 if 아님): confirm 수락이 1회용 토큰을 발급하고, 그 토큰을 키로
//      {name, params} 를 보관한 게이트 엔트리만이 실행을 구성한다. 토큰 없이는 name/params 출처 자체가
//      없어 execute 호출을 만들 수 없다 — 검증 분기를 NOP-패치해도 동작 안 함(데이터 의존).

import { classifyDanger, validatePlan, EXAMPLE_COMMANDS, type PlanStep } from "./plan";

export interface CommandOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  [k: string]: unknown;
}

// confirm 게이트 — 사람이 수락하면 issue() 로 1회용 토큰을 발급하고 그 토큰을 반환한다.
//   거부/타임아웃 → null(토큰 미발급). 실모달은 DOM(아래 createConfirmModal)이 구현, 테스트는 주입.
export type ConfirmGate = (issue: () => string, info: ConfirmInfo) => Promise<string | null>;

export interface ConfirmInfo {
  command: string;
  danger: "destructive" | "inject";
  params: Record<string, unknown>;
}

export interface ExecutorDeps {
  app: any; // ctx.app — commands.execute 단일 코어 호출 seam.
  confirmGate: ConfirmGate;
  lang?: () => string;
}

// confirm 모달이 노출하는 data-node 경로(소스 단일 진실). 컨테이너만 노출(가시성), accept 는 비노출.
//   executor.test.ts 가 이 집합으로 "accept 비노출" 계약을 단언한다.
export const CONFIRM_EXPOSED_NODES = ["tower/confirm", "tower/confirm/cancel"] as const;

// 보안-chrome 주소 판별 — executor 의 dom 도달에서 영구 차단. confirm 게이트 표면은 절대 클릭 대상 아님.
function isForbiddenChrome(address: string): boolean {
  return /(^|\/)tower\/confirm(\/|$)/.test(address) || /(^|\/)modal\/confirm-close(\/|$)/.test(address);
}

// 16바이트 랜덤 토큰(게이트 1회분). crypto 우선, 없으면 Math.random 폴백(테스트/노드 환경).
function randomToken(): string {
  try {
    const g: any = globalThis as any;
    if (g.crypto?.getRandomValues) {
      const b = new Uint8Array(16);
      g.crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* 폴백 */
  }
  return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export interface TowerExecutor {
  runExample: (index: number) => Promise<CommandOutcome>;
  runCommand: (name: string, params?: Record<string, unknown>) => Promise<CommandOutcome>;
  runDom: (address: string) => Promise<CommandOutcome>;
  runPlan: (steps: PlanStep[]) => Promise<CommandOutcome>;
}

// 게이트의 유일 실행 통로(sealedDispatch) 접근 심볼 — 테스트가 "토큰만으로는 못 뚫는다"를 실증하려면
//   gatedRun 의 분기를 건너뛰고 sealedDispatch 를 직접 쳐 봐야 한다(단일 if NOP 공격 동형). 일반 코드는
//   이 심볼을 모르므로 우발 접근 0 — 적대 테스트만이 이 능력을 가진다(공격 표면 확장 아님, 검증용).
export const SEALED = Symbol("tower.executor.sealed");

export function createExecutor(deps: ExecutorDeps): TowerExecutor {
  const { app, confirmGate } = deps;
  const exec = (name: string, params?: Record<string, unknown>): Promise<CommandOutcome> =>
    app.commands.execute(name, params ?? {});

  // ── 게이트 엔트리 저장소(토큰 → {name, params}). (c) 데이터 의존의 핵심 ──
  //   destructive/inject 실행의 name/params 는 오직 confirm 이 발급한 토큰을 통해서만 얻는다. 토큰이 없으면
  //   조회 결과도 없어 sealedDispatch 가 execute 를 구성할 수 없다. 1회용(조회 즉시 삭제 = replay 차단).
  const gates = new Map<string, { name: string; params: Record<string, unknown> }>();

  // 유일한 destructive/inject 실행 통로 — 토큰으로 게이트 엔트리를 꺼내 그 안의 name/params 로만 실행한다.
  //   인자로 받은 name/params 가 아니라 *엔트리* 가 진실 → 토큰 위조 시 엔트리 부재로 미실행(단일 if 아님).
  async function sealedDispatch(token: string): Promise<CommandOutcome> {
    const entry = gates.get(token);
    if (!entry) {
      // 위조/만료/소비된 토큰 — 실행을 구성할 데이터가 없음. (c) NOP-패치 내성: 여기에 분기가 아니라
      //   데이터 부재가 막는다. 검증을 지워도 entry 가 undefined 라 .name 접근이 곧 실패.
      return { ok: false, code: "GATE_REQUIRED", message: "확인 게이트 토큰이 없거나 만료됨(실행 불가)" };
    }
    gates.delete(token); // 1회용 소비.
    return exec(entry.name, entry.params);
  }

  // danger command 게이트 통과 → 실행. confirm 이 토큰 발급(issue)하면서 게이트 엔트리에 name/params 봉인.
  async function gatedRun(
    name: string,
    params: Record<string, unknown>,
    danger: "destructive" | "inject",
  ): Promise<CommandOutcome> {
    const issue = (): string => {
      const token = randomToken();
      gates.set(token, { name, params }); // 수락 순간에만 실행 데이터가 존재.
      return token;
    };
    const token = await confirmGate(issue, { command: name, danger, params });
    if (token == null) {
      return { ok: false, code: "CONFIRM_DENIED", message: "사용자가 위험 명령 확인을 거부/취소함" };
    }
    return sealedDispatch(token);
  }

  // 단일 command 실행(fast-path 종점). 비파괴 = 직행, danger = 게이트 경유.
  async function runCommand(name: string, params: Record<string, unknown> = {}): Promise<CommandOutcome> {
    const danger = classifyDanger(name);
    if (danger) return gatedRun(name, params, danger);
    return exec(name, params); // 비파괴 → 즉시 직행(에이전트 우회).
  }

  // dom 디스패치(축2) — 노출 주소를 ui.input.click 으로. 단, 보안-chrome(confirm)은 영구 거부.
  //   (b) 악성 plan 이 confirm accept 주소를 넣어도 여기서 차단 → 자가승인 0.
  async function runDom(address: string): Promise<CommandOutcome> {
    if (isForbiddenChrome(address)) {
      return { ok: false, code: "FORBIDDEN_CHROME", message: `보안 chrome 은 클릭 대상이 아님: ${address}` };
    }
    return exec("ui.input.click", { address });
  }

  // 예시행 실행 — text → command + 라이브 파라미터 해소 → runCommand(게이트 포함).
  async function runExample(index: number): Promise<CommandOutcome> {
    const spec = EXAMPLE_COMMANDS[index];
    if (!spec) return { ok: false, code: "UNKNOWN_EXAMPLE", message: `예시 인덱스 범위 밖: ${index}` };
    let params: Record<string, unknown> | null;
    try {
      params = await spec.resolveParams((n, p) => exec(n, p));
    } catch (e) {
      return { ok: false, code: "RESOLVE_FAILED", message: String((e as Error)?.message ?? e) };
    }
    if (params == null) {
      return { ok: false, code: "NEEDS_TARGET", message: `대상을 찾지 못함: "${spec.text}"` };
    }
    return runCommand(spec.command, params);
  }

  // slow-path plan 실행(M5 토대) — 먼저 라이브 카탈로그/ui.tree 로 전수 검증 후 step 별 디스패치.
  //   M4 범위에선 검증 + 축별 라우팅만(엔진 연동은 M5). danger command step 도 게이트를 거친다.
  async function runPlan(steps: PlanStep[]): Promise<CommandOutcome> {
    const [cat, tree] = await Promise.all([exec("state.commands"), exec("ui.tree")]);
    const commandNames = new Set<string>(
      (Array.isArray((cat as any)?.commands) ? (cat as any).commands : []).map((c: any) => c.name),
    );
    const domAddresses = new Set<string>(
      (Array.isArray((tree as any)?.nodes) ? (tree as any).nodes : []).map((n: any) => n.address),
    );
    const v = validatePlan(steps, { commandNames, domAddresses });
    if (!v.ok) return { ok: false, code: v.code, message: v.message, index: (v as any).index };
    for (const s of steps) {
      let r: CommandOutcome;
      if (s.axis === "dom") r = await runDom(s.address as string);
      else r = await runCommand(s.name, s.params ?? {});
      if (!r.ok) return r; // 첫 실패에서 멈춤(되먹임은 M5).
    }
    return { ok: true };
  }

  const api: TowerExecutor = { runExample, runCommand, runDom, runPlan };
  // 적대 테스트 전용 봉인 통로 — gatedRun 분기를 우회해 토큰만으로 sealedDispatch 를 직접 호출(NOP 공격
  //   동형). 데이터 의존이라 위조/소비 토큰 → 게이트 엔트리 부재 → 0 실행을 단언한다(검증을 지워도 막힘).
  Object.defineProperty(api, SEALED, { value: sealedDispatch, enumerable: false });
  return api;
}

// ── 테스트 전용: 게이트 단일-분기 NOP 공격을 모사하는 경로 ──
//   '공격자' 가 gatedRun 의 if 를 제거하고 임의 토큰으로 sealedDispatch 를 직접 호출한다고 가정한다.
//   SEALED 심볼로 진짜 sealedDispatch 를 토큰만으로 직접 호출 → 위조/소비 토큰이면 게이트 엔트리가
//   없어 0 실행(데이터 의존이라 NOP 으로 못 뚫음)을 단언한다. 게이트가 단일 if 였다면 이 호출이 실행을
//   냈을 것(취약). 엔트리가 진실이라 막힌다(GREEN).
export async function __unsafeDispatchForNopTest(ex: TowerExecutor, token: string): Promise<CommandOutcome> {
  const sealed = (ex as unknown as Record<symbol, (t: string) => Promise<CommandOutcome>>)[SEALED];
  return sealed(token);
}
