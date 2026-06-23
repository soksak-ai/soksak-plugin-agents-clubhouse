// plan.ts — 타워 plan step 스키마 + 검증(순수, I/O 0) + danger 분류 + 예시행 매핑.
//
// RULE 6(단일 진실): executor 가 디스패치하는 모든 plan 은 먼저 여기서 검증된다. 미등록 command/주소는
//   거부 → 에러를 plan 컨텍스트에 되먹임(self-correct). 순수 함수라 단위 테스트로 불변식 강제.
//
// ⚠️ danger 분류의 단일 진실: 코어 state.commands(catalogJson)는 danger 필드를 싣지 않는다(registry.ts
//   catalogJson 가 description/params/returns 만 직렬화). 그래서 in-process 호출 경로(app.commands.execute)
//   가 destructive 인지를 호스트에 물을 길이 없다 — 코어 게이트는 remote(소켓/CLI/MCP) 호출에만 걸리고
//   로컬 모달 fast-path 는 우회한다(plan §안전모델). 따라서 타워는 코어 레지스트리의 danger 선언을
//   이름 집합으로 미러해 자기 게이트의 진실로 삼는다. 코어가 danger 를 추가/변경하면 이 집합도 갱신한다
//   (단일 출처 = 코어 catalog*.ts 의 danger:"…" 선언, 여기 DESTRUCTIVE/INJECT 가 그 미러).

// 코어 catalog*.ts 의 danger:"destructive" 선언 전수 미러(2026-06 기준). 닫기·제거·복원·치환 류.
const DESTRUCTIVE = new Set<string>([
  "content.close",
  "data.import",
  "data.restore",
  "panel.close",
  "plugin.consent.revoke",
  "plugin.disable",
  "plugin.install",
  "plugin.remove",
  "plugin.update",
  "project.close",
  "secret.delete",
  "view.close",
  "editor.close", // view.close 위임(코어 desc "same as view.close") — 닫기이므로 게이트.
  "window.close", // 창 닫기 — 파괴.
]);

// 코어 catalog*.ts 의 danger:"inject" 선언 전수 미러. 입력 주입·네트워크 송신·secret 쓰기 류.
const INJECT = new Set<string>([
  "clipboard.write",
  "media.proxy.info",
  "media.proxy.playlist",
  "media.proxy.stream",
  "net.http.request",
  "net.udp.request",
  "net.udp.send",
  "plugin.dev.load",
  "plugin.dev.new",
  "plugin.enable",
  "schedule.set",
  "secret.set",
  "secret.unlock",
  "term.exec",
  "term.send",
  "ui.input.click",
  "ui.input.dblclick",
  "ui.input.drag",
  "ui.input.fill",
]);

export type Danger = "destructive" | "inject";

// command 이름 → danger 분류(코어 레지스트리 미러). undefined = 비파괴(게이트 없음).
//   휴리스틱(이름 정규식)이 아니라 코어 선언의 정확 미러 — 가짜 안전감 0, 과탐/미탐 0.
export function classifyDanger(name: string): Danger | undefined {
  if (DESTRUCTIVE.has(name)) return "destructive";
  if (INJECT.has(name)) return "inject";
  return undefined;
}

// plan step — 3축 직매핑. command/status = 레지스트리 name(+params), dom = 노출 주소(address).
export interface PlanStep {
  axis: "command" | "dom" | "status";
  name: string; // command/status = 레지스트리 이름. dom = "ui.input.click"/"ui.input.fill" 등.
  params?: Record<string, unknown>;
  address?: string; // dom 축 전용 — 노출 DOM 주소(ui.tree 대조).
}

// 검증 컨텍스트 — 라이브 카탈로그(축1/3)·라이브 ui.tree(축2)의 허용 집합. executor 가 호출 직전 주입.
export interface PlanContext {
  commandNames: Set<string>; // state.commands 의 전체 name 집합.
  domAddresses: Set<string>; // ui.tree 의 전체 address 집합.
}

export type PlanValidation =
  | { ok: true }
  | { ok: false; code: "UNKNOWN_COMMAND" | "NOT_EXPOSED" | "INVALID_STEP"; index: number; message: string };

const AXES = new Set(["command", "dom", "status"]);

// plan 전체 검증 — 한 step 이라도 미등록 command/주소/형태면 그 index 와 함께 거부.
//   첫 위반에서 멈춘다(executor 가 그 index 의 에러를 plan 컨텍스트에 되먹임).
export function validatePlan(steps: PlanStep[], ctx: PlanContext): PlanValidation {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== "object" || !AXES.has((s as PlanStep).axis)) {
      return { ok: false, code: "INVALID_STEP", index: i, message: `잘못된 step(axis): ${JSON.stringify(s)}` };
    }
    if (s.axis === "dom") {
      // 축2 — name 은 ui.input.* 디스패처여야 하고(레지스트리 대조), address 는 ui.tree 에 있어야 한다.
      if (typeof s.name !== "string" || !s.name) {
        return { ok: false, code: "INVALID_STEP", index: i, message: "dom step 에 name 누락" };
      }
      if (!ctx.commandNames.has(s.name)) {
        return { ok: false, code: "UNKNOWN_COMMAND", index: i, message: `미등록 dom command: ${s.name}` };
      }
      if (typeof s.address !== "string" || !s.address) {
        return { ok: false, code: "INVALID_STEP", index: i, message: "dom step 에 address 누락" };
      }
      if (!ctx.domAddresses.has(s.address)) {
        return { ok: false, code: "NOT_EXPOSED", index: i, message: `노출되지 않은 주소: ${s.address}` };
      }
      continue;
    }
    // 축1(command)·축3(status) — name 이 레지스트리에 있어야 한다.
    if (typeof s.name !== "string" || !s.name) {
      return { ok: false, code: "INVALID_STEP", index: i, message: `${s.axis} step 에 name 누락` };
    }
    if (!ctx.commandNames.has(s.name)) {
      return { ok: false, code: "UNKNOWN_COMMAND", index: i, message: `미등록 command: ${s.name}` };
    }
  }
  return { ok: true };
}

// 예시행 매핑 — 5 handoff 문장 → 실 코어 command + 라이브 파라미터 리졸버.
//   command = 정식 레지스트리 이름(축1). resolveParams = 클릭 시점 라이브 상태(panel.list/theme.list/
//   state.tree)에서 필수 파라미터를 채운다 — 정적 문장이 동적 컨텍스트로 해소(좌표 hallucination 0).
//   query = executor 가 주입하는 read 명령 실행기(app.commands.execute 래퍼).
export interface ExampleSpec {
  text: string; // handoff 고정 문구(modal EXAMPLES 와 동일 순서).
  command: string; // 정식 코어 command 이름.
  // 라이브 read 로 필수 파라미터 해소. 못 채우면 null(executor 가 NEEDS_TARGET 로 보고).
  resolveParams: (q: (name: string, params?: Record<string, unknown>) => Promise<any>) => Promise<Record<string, unknown> | null>;
}

export const EXAMPLE_COMMANDS: ExampleSpec[] = [
  {
    // "에디터 패널 닫아줘" — 활성 패널의 에디터 뷰를 찾아 닫는다(destructive).
    text: "에디터 패널 닫아줘",
    command: "editor.close",
    resolveParams: async (q) => {
      const r = await q("panel.list");
      const panels: any[] = Array.isArray(r?.panels) ? r.panels : [];
      for (const p of panels) {
        const v = (p.views ?? []).find((vw: any) => vw.kind === "editor");
        if (v) return { view: v.id };
      }
      return null; // 열린 에디터 없음 → executor 가 NEEDS_TARGET.
    },
  },
  {
    // "터미널 패널 닫아줘" — 터미널 뷰가 든 패널 그룹을 닫는다(destructive).
    text: "터미널 패널 닫아줘",
    command: "panel.close",
    resolveParams: async (q) => {
      const r = await q("panel.list");
      const panels: any[] = Array.isArray(r?.panels) ? r.panels : [];
      const term = panels.find((p) =>
        (p.views ?? []).some((vw: any) => vw.plugin === "soksak-plugin-terminal"),
      );
      if (term) return { group: term.id };
      // 폴백 = 활성 그룹(마지막 패널은 코어가 거부 — 그 거부가 진실).
      const active = panels.find((p) => p.active) ?? panels[0];
      return active ? { group: active.id } : null;
    },
  },
  {
    // "분할 반반으로 맞춰줘" — 첫 split 을 균등 분배(비파괴).
    text: "분할 반반으로 맞춰줘",
    command: "panel.equalize",
    resolveParams: async (q) => {
      const r = await q("state.tree");
      const sid = findFirstSplitId(r?.tree);
      return sid ? { split: sid } : null;
    },
  },
  {
    // "다크 모드로 바꿔줘" — 현재 테마 유지, 모드만 dark(비파괴).
    text: "다크 모드로 바꿔줘",
    command: "theme.apply",
    resolveParams: async (q) => {
      const r = await q("theme.list");
      const name = typeof r?.current === "string" ? r.current : (r?.themes?.[0]?.name as string | undefined);
      return name ? { name, mode: "dark" } : null;
    },
  },
  {
    // "다음 테마로 바꿔줘" — theme.list 순서상 다음 테마(비파괴).
    text: "다음 테마로 바꿔줘",
    command: "theme.apply",
    resolveParams: async (q) => {
      const r = await q("theme.list");
      const themes: any[] = Array.isArray(r?.themes) ? r.themes : [];
      if (!themes.length) return null;
      const cur = typeof r?.current === "string" ? r.current : themes[0].name;
      const idx = themes.findIndex((tt) => tt.name === cur);
      const next = themes[(idx + 1) % themes.length];
      return next?.name ? { name: next.name } : null;
    },
  },
];

// state.tree 에서 첫 split node id 를 찾는다(재귀, 순수). 코어 layout split 노드의 id 필드를 따른다.
function findFirstSplitId(node: any): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (node.split && typeof node.split.id === "string") return node.split.id;
  if (typeof node.id === "string" && Array.isArray(node.children)) return node.id;
  for (const v of Object.values(node)) {
    const found = findFirstSplitId(v);
    if (found) return found;
  }
  return undefined;
}
