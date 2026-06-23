// 타워 모달 셸 + 본문(M3) — AI-명령 모달. 560px 드래그 오버레이 + 헤더(✦ AI 명령 · 부제 · 그립 · ✕) +
//   본문(NL 입력바 · 예시행 5 · 명령 팔레트 · 검색 · 우측 라이브칸). 실행(executor)은 M4 — 여기는 UI+라이브
//   데이터+필터만(파괴 동작 0). Enter/예시·팔레트 클릭은 NL 바를 채우는 stub.
//
// 코어 변경 0. 호스트 테마 변수(--card/--bd/--acc/--accbg/--inset/--fg/--fg3)만 사용 → 5테마 per-theme 코드 0.
// document.body 직속(뷰 컨테이너 밖)이라 코어 catalogDom.collectExposed 가 호스트 크롬으로 수집:
//   data-node="tower/<path>" → 주소 win/<win>/chrome/tower/<path>. 모든 인터랙티브 노드를 data-node 로 전수 노출
//   (RULE 8): input·example/0..4·cmd/<name>·live·close·grip.
// Clubhouse content 탭은 건드리지 않는다(별도 DOM, additive). 라이브칸은 Clubhouse 의 .st-bubble 룩을 재사용.
//
// RULE 7(이벤트-우선·폴링 0): 팔레트는 모달 open 시 state.commands 1회 fetch + theme/locale 변경 이벤트에
//   재fetch. 레지스트리-변경 이벤트는 호스트가 노출하지 않으므로(PluginEventMap 에 없음) open-시 fetch 가
//   정공법 — setInterval/poll 루프 금지. 라이브칸은 stable bus 토픽 구독(per-connId 추측·폴링 없음).

import { t, type I18nKey } from "../i18n";

// 라이브칸이 구독하는 stable bus 토픽 — Clubhouse 런타임(main.ts)이 스트림 단일 진실에서 재방송한다.
//   acp.update.<connId> 는 connId 별이라 모달이 직접 못 잡는다 → main.ts onStream 이 이 토픽으로 relay(이벤트-우선).
export const TOWER_LIVE_TOPIC = "clubhouse.tower.live";

// 라이브 이벤트 — main.ts 가 emit. kind 로 버블 구분(시작/델타/종료/사람/시스템).
export interface TowerLiveEvent {
  kind: "start" | "delta" | "end" | "user" | "reset";
  who?: string; // 표시 이름(에이전트/나)
  color?: string; // 에이전트 브랜드 색(없으면 테마 토큰)
  text?: string; // delta=증분, user=전체, end=최종(있으면 교체)
}

// 예시행(5) — handoff 고정 문구. 클릭 = NL 바를 이 문장으로 채움(실행 X, M4).
const EXAMPLES = [
  "에디터 패널 닫아줘",
  "터미널 패널 닫아줘",
  "분할 반반으로 맞춰줘",
  "다크 모드로 바꿔줘",
  "다음 테마로 바꿔줘",
];

const STYLE_ID = "tower-modal-style";
const CSS = `
.tower-ov{position:fixed;left:50%;top:76px;transform:translateX(-50%);width:560px;max-width:calc(100vw - 32px);
  z-index:9001;background:var(--card,#262626);color:var(--fg,#e6e6e6);border:1px solid var(--bd,#3a3a3a);
  border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3);
  font:13px system-ui,-apple-system,sans-serif;overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 110px)}
.tower-hd{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid var(--bd,#3a3a3a);
  cursor:grab;user-select:none;flex:0 0 auto}
.tower-hd.drag{cursor:grabbing}
.tower-mk{display:inline-flex;align-items:center;color:var(--acc,#7aa2f7)}
.tower-htxt{flex:1 1 auto;min-width:0}
.tower-tt{font-weight:700;letter-spacing:.01em;white-space:nowrap}
.tower-sub{font-size:10.5px;color:var(--fg3,#888);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tower-grip{opacity:.4;letter-spacing:2px;font-size:11px;cursor:grab;user-select:none}
.tower-x{appearance:none;border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;
  font-size:15px;line-height:1;padding:3px 6px;border-radius:6px}
.tower-x:hover{opacity:1;background:var(--inset,rgba(127,127,127,.14))}
/* 본문 = 좌(입력·예시·팔레트) | 우(라이브) 2열 */
.tower-bd{display:flex;min-height:0;flex:1 1 auto}
.tower-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;padding:12px;gap:11px;overflow-y:auto}
.tower-side{flex:0 0 188px;border-left:1px solid var(--bd,#3a3a3a);display:flex;flex-direction:column;min-height:0}
/* NL 입력바 */
.tower-inwrap{display:flex;align-items:center;gap:8px;border:1px solid var(--bd,#3a3a3a);border-radius:9px;
  background:var(--inset,rgba(127,127,127,.08));padding:8px 10px}
.tower-inwrap:focus-within{border-color:var(--acc,#7aa2f7)}
.tower-inmk{display:inline-flex;align-items:center;color:var(--acc,#7aa2f7);flex:0 0 auto}
.tower-in{flex:1 1 auto;min-width:0;background:transparent;border:0;outline:0;color:var(--fg,#e6e6e6);font:inherit}
.tower-in::placeholder{color:var(--fg3,#888)}
.tower-enter{flex:0 0 auto;font-size:11px;color:var(--fg3,#888);border:1px solid var(--bd,#3a3a3a);
  border-radius:5px;padding:0 5px;line-height:16px}
/* 섹션 라벨 */
.tower-sec{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--fg3,#888)}
/* 예시행 */
.tower-exs{display:flex;flex-direction:column;gap:5px}
.tower-ex{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;border:1px solid var(--bd,#3a3a3a);
  background:var(--inset,rgba(127,127,127,.06));cursor:pointer;text-align:left;color:inherit;font:inherit}
.tower-ex:hover{border-color:var(--acc,#7aa2f7);background:var(--accbg,rgba(122,162,247,.12))}
.tower-ex-mk{color:var(--acc,#7aa2f7);flex:0 0 auto;font-size:12px}
.tower-ex-tx{flex:1 1 auto;min-width:0}
.tower-ex-go{flex:0 0 auto;font-size:11px;color:var(--fg3,#888)}
/* 팔레트 */
.tower-pal{display:flex;flex-direction:column;gap:2px;max-height:208px;overflow-y:auto}
.tower-cmd{display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:7px;cursor:pointer;
  color:inherit;font:inherit;text-align:left;border:1px solid transparent}
.tower-cmd:hover{background:var(--accbg,rgba(122,162,247,.12));border-color:var(--acc,#7aa2f7)}
.tower-cmd-ic{flex:0 0 18px;text-align:center;color:var(--fg3,#888);font-size:12px}
.tower-cmd-tt{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tower-cmd-sc{flex:0 0 auto;font-size:10.5px;color:var(--fg3,#888);font-variant-numeric:tabular-nums;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tower-cmd-dg{flex:0 0 auto;color:var(--danger-soft,#d77);font-size:11px}
.tower-empty{font-size:11.5px;color:var(--fg3,#888);padding:8px 9px}
/* 라이브칸 — Clubhouse st-bubble 룩 재사용 */
.tower-live-hd{padding:9px 11px;border-bottom:1px solid var(--bd,#3a3a3a);font-size:10.5px;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;color:var(--fg3,#888);flex:0 0 auto}
.tower-live{flex:1 1 auto;min-height:120px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.tower-live-empty{font-size:11px;color:var(--fg3,#888);line-height:1.45}
.tower-lrow{display:flex;flex-direction:column;gap:2px;max-width:100%}
.tower-lrow.user{align-items:flex-end}
.tower-lwho{font-size:10px;color:var(--fg3,#888);font-weight:600;padding:0 3px}
.tower-lbubble{padding:6px 9px;border-radius:9px;white-space:pre-wrap;word-break:break-word;line-height:1.42;
  font-size:12px;background:var(--inset,rgba(127,127,127,.14))}
.tower-lrow.user .tower-lbubble{background:var(--accbg,rgba(122,162,247,.18))}
`;

// 명령 prefix → 글리프(축2 dom 아님, 시각 보조만). 미스 시 점 글리프.
const ICON_BY_PREFIX: Record<string, string> = {
  terminal: ">_",
  panel: "▤",
  view: "▤",
  content: "▤",
  window: "❑",
  file: "▤",
  fs: "▤",
  browser: "🌐",
  bookmark: "★",
  theme: "◐",
  settings: "⚙",
  plugin: "⬡",
  state: "≡",
  status: "◷",
  ui: "⊹",
  project: "▢",
  clipboard: "⎘",
  search: "⌕",
};
function cmdIcon(name: string): string {
  const pre = name.split(".")[0];
  return ICON_BY_PREFIX[pre] ?? "·";
}
// destructive 어휘 → danger 글리프(M3 시각만 — 실제 게이트는 M4). catalogJson 이 danger 를 안 실어
//   이름 기반 휴리스틱으로 표식만 한다(가짜 안전감 아님 — 단지 시각 힌트).
function cmdDanger(name: string): boolean {
  return /\.(close|remove|delete|kill|clear|reset|disable|quit|destroy)\b/.test(name);
}
// 표시 제목 — catalogJson description 은 "base | 트리거…" 합성본이라 ' | ' 앞 base 만(없으면 name).
function cmdTitle(name: string, description: string): string {
  const base = (description || "").split(" | ")[0].trim();
  return base || name;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" /></svg>';
const ICON_SM =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" /></svg>';

export interface TowerModalDeps {
  title: string;
  lang: () => string; // 현재 호스트 언어(locale.changed 로 갱신됨) — 본문 텍스트·재fetch 에 사용
  app: any; // ctx.app — commands.execute(팔레트) · events.on(재fetch) · bus.on(라이브)
  onChange?: () => void; // 열림/닫힘 변화 단일 채널(헤더 active 동기화, 이벤트-우선)
}

export interface TowerModal {
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  dispose: () => void;
}

interface CatalogCmd {
  name: string;
  description: string;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function elText(tag: string, text: string, cls = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

// 드래그 — 그립/헤더 pointerdown 으로 창 경계 내에서 reposition(left/top 절대, transform 해제).
function makeDraggable(ov: HTMLElement, handle: HTMLElement): () => void {
  let sx = 0,
    sy = 0,
    ox = 0,
    oy = 0,
    dragging = false;
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const r = ov.getBoundingClientRect();
    let nx = ox + (e.clientX - sx);
    let ny = oy + (e.clientY - sy);
    nx = Math.max(8, Math.min(nx, window.innerWidth - r.width - 8));
    ny = Math.max(8, Math.min(ny, window.innerHeight - r.height - 8));
    ov.style.left = `${nx}px`;
    ov.style.top = `${ny}px`;
    ov.style.transform = "none";
  };
  const onUp = () => {
    dragging = false;
    handle.classList.remove("drag");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  const onDown = (e: PointerEvent) => {
    // 닫기 버튼·입력바·예시·팔레트 등 인터랙티브 요소에서 시작한 드래그는 무시(그립/헤더 빈 곳만 드래그).
    const target = e.target as HTMLElement;
    if (
      target.closest(".tower-x") ||
      target.closest(".tower-in") ||
      target.closest(".tower-ex") ||
      target.closest(".tower-cmd")
    ) {
      return;
    }
    const r = ov.getBoundingClientRect();
    ov.style.left = `${r.left}px`;
    ov.style.top = `${r.top}px`;
    ov.style.transform = "none";
    sx = e.clientX;
    sy = e.clientY;
    ox = r.left;
    oy = r.top;
    dragging = true;
    handle.classList.add("drag");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  handle.addEventListener("pointerdown", onDown);
  return () => handle.removeEventListener("pointerdown", onDown);
}

export function createTowerModal(deps: TowerModalDeps): TowerModal {
  const { app, lang, onChange } = deps;
  ensureStyle();
  let ov: HTMLElement | null = null;
  let undrag: (() => void) | null = null;
  // 본문 라이프사이클(open 마다 새로) — 구독 해지(호스트 Disposable)·필터·라이브 상태.
  let subs: Array<{ dispose: () => void }> = [];
  let palWrap: HTMLElement | null = null;
  let liveBox: HTMLElement | null = null;
  let nlInput: HTMLInputElement | null = null;
  let catalog: CatalogCmd[] = [];
  let liveActive: { who?: string; color?: string; text: HTMLElement } | null = null;

  const tr = (key: I18nKey) => t(key, lang());

  const emit = () => {
    try {
      onChange?.();
    } catch {
      // 구독자 실패 격리.
    }
  };

  // ── 팔레트(축1 라이브) — state.commands 1회 fetch 후 현재 검색어로 렌더(이벤트-우선, 폴링 0) ──
  async function fetchCatalog(): Promise<void> {
    try {
      const r = await app.commands.execute("state.commands", {});
      const cmds: any[] = Array.isArray(r?.commands) ? r.commands : [];
      catalog = cmds
        .filter((c) => c && typeof c.name === "string")
        .map((c) => ({ name: c.name as string, description: String(c.description ?? "") }));
    } catch {
      catalog = []; // 거부/오류 — 빈 팔레트(검색은 동작, 가짜 행 0)
    }
    renderPalette();
  }

  function renderPalette(): void {
    const wrap = palWrap;
    if (!wrap) return;
    const q = (nlInput?.value ?? "").trim().toLowerCase();
    const rows = catalog.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
    wrap.replaceChildren();
    if (!rows.length) {
      wrap.appendChild(elText("div", tr("towerPaletteEmpty"), "tower-empty"));
      return;
    }
    for (const c of rows) {
      const row = el("button", "tower-cmd");
      (row as HTMLButtonElement).type = "button";
      row.dataset.node = `tower/cmd/${c.name}`; // RULE 8 — 팔레트 행 전수 노출(주소 chrome/tower/cmd/<name>)
      row.append(elText("span", cmdIcon(c.name), "tower-cmd-ic"));
      const tt = elText("span", cmdTitle(c.name, c.description), "tower-cmd-tt");
      tt.title = c.name; // hover 로 정식 command 이름 노출
      row.append(tt);
      if (cmdDanger(c.name)) row.append(elText("span", "⚠", "tower-cmd-dg"));
      row.append(elText("span", c.name, "tower-cmd-sc")); // 단축키 필드 부재 → command 이름을 mono 로(축1 진실)
      // 클릭 = NL 바를 이 command 이름으로 채움(실행 X, M4 executor). 파괴 동작 0.
      row.addEventListener("click", () => fillInput(c.name));
      wrap.appendChild(row);
    }
  }

  // 예시/팔레트 클릭·향후 ⏎ → NL 바 채움. M4 전엔 채우기만(실행·제출 없음).
  function fillInput(text: string): void {
    if (!nlInput) return;
    nlInput.value = text;
    nlInput.focus();
    nlInput.setSelectionRange(text.length, text.length);
    renderPalette(); // 입력 변경 = 검색 필터 갱신
  }

  // ── 라이브칸(이벤트-우선) — main.ts 가 TOWER_LIVE_TOPIC 으로 재방송한 스트림을 버블로 ──
  function clearLive(): void {
    if (!liveBox) return;
    liveBox.replaceChildren(elText("div", tr("towerLiveEmpty"), "tower-live-empty"));
    liveActive = null;
  }
  function liveScroll(): void {
    if (liveBox) liveBox.scrollTop = liveBox.scrollHeight;
  }
  function onLive(ev: TowerLiveEvent): void {
    const box = liveBox;
    if (!box) return;
    if (ev.kind === "reset") return clearLive();
    box.querySelector(".tower-live-empty")?.remove();
    if (ev.kind === "user") {
      const row = el("div", "tower-lrow user");
      row.append(elText("div", ev.who ?? "나", "tower-lwho"), elText("div", ev.text ?? "", "tower-lbubble"));
      box.appendChild(row);
      liveActive = null;
      return liveScroll();
    }
    if (ev.kind === "start") {
      const row = el("div", "tower-lrow assistant");
      const who = elText("div", ev.who ?? "", "tower-lwho");
      if (ev.color) who.style.color = ev.color;
      const bubble = el("div", "tower-lbubble");
      row.append(who, bubble);
      box.appendChild(row);
      liveActive = { who: ev.who, color: ev.color, text: bubble };
      return liveScroll();
    }
    if (ev.kind === "delta") {
      if (!liveActive) onLive({ kind: "start", who: ev.who, color: ev.color });
      if (liveActive) liveActive.text.textContent = (liveActive.text.textContent || "") + (ev.text ?? "");
      return liveScroll();
    }
    if (ev.kind === "end") {
      if (liveActive && ev.text) liveActive.text.textContent = ev.text;
      liveActive = null;
      return liveScroll();
    }
  }

  // 본문 빌드 — open 시 1회. 좌(입력·예시·팔레트) | 우(라이브). 모든 인터랙티브 노드 data-node 전수 노출.
  function buildBody(body: HTMLElement): void {
    const main = el("div", "tower-main");

    // NL 입력바 — ✦ 프리픽스 · placeholder · ⏎ 뱃지. 입력이 곧 팔레트 검색 필터(한 입력 = NL + 검색).
    const inwrap = el("div", "tower-inwrap");
    const inmk = el("span", "tower-inmk");
    inmk.innerHTML = ICON_SM;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tower-in";
    input.placeholder = tr("towerInputPlaceholder");
    input.dataset.node = "tower/input"; // RULE 8
    input.addEventListener("input", () => renderPalette()); // 타이핑 = 라이브 검색(이벤트-우선)
    input.addEventListener("keydown", (e) => {
      // Enter = M4 executor 진입점 stub — 지금은 아무 파괴 동작도 하지 않는다(채움/검색만 유지).
      if (e.key === "Enter") e.preventDefault();
    });
    nlInput = input;
    inwrap.append(inmk, input, elText("span", "⏎", "tower-enter"));
    main.appendChild(inwrap);

    // 예시행 섹션 — 클릭 = NL 바 채움(실행 X).
    main.appendChild(elText("div", tr("towerExamplesTitle"), "tower-sec"));
    const exs = el("div", "tower-exs");
    EXAMPLES.forEach((text, i) => {
      const ex = el("button", "tower-ex");
      (ex as HTMLButtonElement).type = "button";
      ex.dataset.node = `tower/example/${i}`; // RULE 8 — 예시행 전수 노출
      ex.append(elText("span", "✦", "tower-ex-mk"));
      ex.append(elText("span", `"${text}"`, "tower-ex-tx"));
      ex.append(elText("span", "⏎", "tower-ex-go"));
      ex.addEventListener("click", () => fillInput(text));
      exs.appendChild(ex);
    });
    main.appendChild(exs);

    // 명령 팔레트 섹션 — 레지스트리 라이브(state.commands). 검색은 NL 바가 구동.
    main.appendChild(elText("div", tr("towerPaletteTitle"), "tower-sec"));
    const pal = el("div", "tower-pal");
    palWrap = pal;
    pal.appendChild(elText("div", tr("towerPaletteEmpty"), "tower-empty")); // fetch 전 자리표시
    main.appendChild(pal);

    // 우측 라이브칸 — Clubhouse 스트림 버블 룩 재사용.
    const side = el("div", "tower-side");
    side.append(elText("div", tr("towerLiveTitle"), "tower-live-hd"));
    const live = el("div", "tower-live");
    live.dataset.node = "tower/live"; // RULE 8 — 라이브칸 노출
    liveBox = live;
    side.appendChild(live);
    clearLive();

    body.append(main, side);
  }

  const build = (): HTMLElement => {
    const root = el("div", "tower-ov");
    root.dataset.node = "tower/modal"; // chrome/tower/modal

    const hd = el("div", "tower-hd");
    const mk = el("span", "tower-mk");
    mk.innerHTML = ICON;
    const htxt = el("div", "tower-htxt");
    htxt.append(elText("div", deps.title, "tower-tt"), elText("div", tr("towerSubtitle"), "tower-sub"));
    const grip = elText("span", "⠿", "tower-grip");
    grip.dataset.node = "tower/grip"; // RULE 8 — 드래그 그립 노출
    const x = el("button", "tower-x");
    (x as HTMLButtonElement).type = "button";
    x.textContent = "✕";
    x.title = "닫기";
    x.dataset.node = "tower/close"; // chrome/tower/close
    x.addEventListener("click", () => api.close());
    hd.append(mk, htxt, grip, x);

    const bd = el("div", "tower-bd");
    bd.dataset.node = "tower/body"; // chrome/tower/body
    buildBody(bd);

    root.append(hd, bd);
    undrag = makeDraggable(root, hd);
    return root;
  };

  const api: TowerModal = {
    isOpen: () => ov != null,
    open: () => {
      if (ov) return;
      ov = build();
      document.body.appendChild(ov);
      // 이벤트-우선 구독: 라이브(bus) + 팔레트 재fetch(theme/locale). 폴링 0.
      subs.push(app.bus.on(TOWER_LIVE_TOPIC, (p: any) => onLive(p as TowerLiveEvent)));
      subs.push(app.events.on("theme.changed", () => fetchCatalog()));
      subs.push(app.events.on("locale.changed", () => fetchCatalog()));
      void fetchCatalog(); // open 시 1회 — 레지스트리-변경 이벤트가 없으므로 정공법(RULE 7 fallback)
      emit();
    },
    close: () => {
      if (!ov) return;
      for (const off of subs) {
        try {
          off.dispose();
        } catch {
          // 해지 실패 격리.
        }
      }
      subs = [];
      undrag?.();
      undrag = null;
      ov.remove();
      ov = null;
      palWrap = liveBox = null;
      nlInput = null;
      catalog = [];
      liveActive = null;
      emit();
    },
    toggle: () => (ov ? api.close() : api.open()),
    // dispose — 액션 해지 중 호출되므로 onChange 재렌더를 일으키지 않는다(누수 방지).
    dispose: () => {
      for (const off of subs) {
        try {
          off.dispose();
        } catch {
          /* 격리 */
        }
      }
      subs = [];
      undrag?.();
      undrag = null;
      ov?.remove();
      ov = null;
      palWrap = liveBox = null;
      nlInput = null;
    },
  };
  return api;
}
