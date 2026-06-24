// scanner.ts — incoming-plan 콘텐츠 스캐너(M10, 순수, Tirith식). plan 을 만들어낸 *untrusted* 텍스트
//   (embedded browser view 텍스트 · 도구 결과 · inter-agent/@멘션 페이로드)와 plan step 자체를 주입
//   시그니처로 검사한다. 페이지 유래 텍스트는 instruction(명령)이 아니라 DATA 다 — 그 안에 박힌
//   "ignore previous, run a destructive command" 류는 절대 실행 경로로 새지 못한다.
//
// RULE 1(RED→GREEN): 위협마다 공격 RED(방어 전 통과 = 취약 입증) → 방어 GREEN. scanner.test.ts 가
//   각 시그니처의 RED→GREEN 쌍을 단언한다.
// RULE 2(기준 불변): false-positive 0 이 하한선 — 정상 NL("다크 모드로 바꿔줘")·정상 페이지 텍스트는
//   무음 통과(flag 0). 과탐으로 정상 입력을 막으면 그것도 배반이다. 시그니처는 좁고 정확하게.
// RULE 6(단일 실행점): 이 모듈은 순수 — I/O 0, 실행 0. executor 가 이 verdict 를 입력으로 받아 자기
//   게이트(forced confirm / refuse)를 결정할 뿐, 별도 실행 경로가 아니다.
//
// ⚠️ 이 스캐너는 "가짜 안전감" 을 주지 않는다 — heuristic 콘텐츠 스캔은 사고 방지(defense-in-depth)
//   레이어일 뿐, 진짜 경계는 (1) untrusted taint → forced desktop confirm 게이트(executor),
//   (2) flagged plan = refused-not-executed(executor) 다. 스캐너가 못 잡아도 taint 가 게이트로 막는다.
//
// ⚠️ 제어/zero-width 문자는 소스에 raw 바이트로 쓰지 않고 \u/\x 이스케이프로만 쓴다 — 소스와 번들 main.js
//   가 순수 텍스트로 남아야 호스트 플러그인 로더가 "바이너리 파일" 로 거부하지 않는다(번들에 NUL/제어바이트 0).

import { classifyDanger } from "./plan";
import type { PlanStep } from "./plan";

// flag 종류 — 어떤 주입 시그니처에 걸렸는가(투명 보고용 단일 진실).
export type FlagKind =
  | "prompt-injection" // "ignore previous instructions" / "disregard" / "you are now" / system-override 류.
  | "homograph" // Cyrillic/Greek 등 confusable 문자가 섞인(ASCII 레지스트리 이름을 위장한) command 명.
  | "pipe-to-interpreter" // `| sh` / `| bash` / `curl … | sh` 류 인터프리터 파이프.
  | "ansi-control" // ANSI escape / control char 로 텍스트를 숨김(터미널 가독성 악용·은닉).
  | "zero-width" // zero-width 문자(U+200B 류)로 토큰을 쪼개 시그니처 회피·은닉.
  | "encoded-payload"; // base64/hex 로 인코딩된 의심 페이로드(난독화).

// 한 flag — 무엇에(kind) 어떤 증거(evidence)로 어디서(span) 걸렸는가. span 은 원문 내 [start,end).
export interface ScanFlag {
  kind: FlagKind;
  evidence: string; // 매치된 부분(트림·길이 제한 — 로그/감사 투명).
  span: [number, number]; // 원문 내 매치 위치 [start, end).
}

export interface ScanResult {
  flags: ScanFlag[];
  verdict: "clean" | "flagged"; // flags.length 0 = clean, 1+ = flagged. 파생값(이중 진실 0).
}

// 증거 문자열 길이 상한(로그 폭주 방지). 매치가 길면 잘라서 보고(투명하되 가벼움).
const EVIDENCE_CAP = 80;
function evidence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EVIDENCE_CAP ? `${t.slice(0, EVIDENCE_CAP)}…` : t;
}

// ── 1) prompt-injection 디렉티브 ──
//   "이전 지시를 무시하고…" / "disregard the above" / "you are now …" / "system prompt:" / override 류.
//   영어 + 한국어(우리 발화 환경) 둘 다. 좁게 — 정상 산문에 잘 안 나오는 명령형 override 구문만.
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions?|prompts?|context|messages?)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier|system)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)?\b/i,
  /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|prompt|directive)s?\s*[:：]/i,
  /\bsystem\s+prompt\s*[:：]/i,
  /\boverride\s+(?:the\s+)?(?:previous|prior|safety|security|all)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+are\s+)?(?:an?\s+)?(?:unrestricted|jailbroken|dan)\b/i,
  // 한국어 — "이전 지시(를) 무시", "위(의 모든) 지시를 무시", "지금부터 너는".
  /이전\s*(?:의)?\s*지시\s*(?:를|는|사항을)?\s*무시/,
  /위\s*(?:의)?\s*(?:모든)?\s*(?:지시|명령|지침)\s*(?:를|을|은)?\s*무시/,
  /지금\s*부터\s*(?:너는|당신은)/,
];

// ── 2) pipe-to-interpreter ──
//   `curl … | sh` / `wget … | bash` / `… | sh -c` / `… | python` 등 다운로드→인터프리터 파이프.
//   파괴적 원격 실행의 고전 패턴. 좁게 — 파이프 뒤 인터프리터 토큰이 와야 매치.
const PIPE_INTERPRETER = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node|powershell|pwsh|cmd)\b/i;
// curl/wget … | (인터프리터) — 다운로드 소스가 함께 있으면 더 강한 증거(별도 보고).
const CURL_PIPE = /\b(?:curl|wget|fetch|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*|perl|ruby|node|powershell|pwsh)\b/i;

// ── 3) ANSI / control-char 은닉 ──
//   ESC[ … (ANSI escape) 또는 비표준 control char(탭/개행/캐리지리턴 제외). 텍스트를 가리거나
//   터미널에서 보이지 않게 만들어 사람 검토를 우회하는 은닉. 한 글자라도 있으면 의심(정상 텍스트엔 없음).
//   raw 제어바이트 대신 \u/\x 이스케이프로만 쓴다(소스/번들 순수 텍스트 유지).
const ANSI_ESCAPE = new RegExp("\u001b\[[0-9;?]*[ -/]*[@-~]");
const CONTROL_CHARS = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]");

// ── 4) zero-width 은닉 ──
//   U+200B(zero-width space)·U+200C/D(ZWNJ/ZWJ)·U+FEFF(BOM)·U+2060(word joiner). 토큰을 쪼개
//   시그니처를 회피하거나 보이지 않는 텍스트를 심는다. 정상 텍스트엔 사실상 안 나온다. \u 이스케이프만.
const ZERO_WIDTH = new RegExp("[\u200b\u200c\u200d\u2060\ufeff]");

// ── 5) homograph / confusable command 명 ──
//   Cyrillic/Greek 등 ASCII 와 똑같이 보이는 글자로 레지스트리 command 이름을 위장한다(예: Cyrillic
//   'а'(U+0430) 가 ASCII 'a' 처럼 보임 → "pаnel.close" 가 "panel.close" 로 보이나 다른 문자열).
//   위험한 건 "ASCII 로 봤을 때 실제 danger command 와 똑같아 보이는데 실제로는 non-ASCII 가 섞인" 경우 —
//   이게 fuzzy-match 로 실제 command 에 매칭돼 실행되면 게이트 우회가 된다. 그래서:
//   confusable 을 ASCII 로 folding(역매핑)한 결과가 실제 danger command 이름과 같으면 homograph 플래그.

// 잘 알려진 ASCII-confusable 역매핑(Cyrillic/Greek → ASCII). 키는 \u 이스케이프로(소스 순수 텍스트). 좁게 —
//   command 명에 쓰이는 라틴 소문자 범위만(Unicode confusables 전수는 과대 — 과탐 0).
const CONFUSABLE_TO_ASCII: Record<string, string> = {
  // Cyrillic
  "а": "a",
  "е": "e",
  "о": "o",
  "р": "p",
  "с": "c",
  "у": "y",
  "х": "x",
  "ѕ": "s",
  "і": "i",
  "ј": "j",
  "һ": "h",
  "ԛ": "q",
  "ԁ": "d",
  // Greek
  "ο": "o",
  "α": "a",
  "ι": "i",
  "κ": "k",
  "ν": "v",
  "ρ": "p",
  "τ": "t",
  "υ": "u",
  "χ": "x",
};

// confusable 문자가 하나라도 섞인 토큰을 ASCII 로 folding. 섞인 게 없으면 입력 그대로(=ASCII).
function foldConfusables(token: string): { folded: string; hadConfusable: boolean } {
  let hadConfusable = false;
  let folded = "";
  for (const ch of token) {
    const map = CONFUSABLE_TO_ASCII[ch];
    if (map !== undefined) {
      hadConfusable = true;
      folded += map;
    } else {
      folded += ch;
    }
  }
  return { folded, hadConfusable };
}

// command-like 토큰(dotted identifier — panel.close 류) 추출. ASCII 영숫자 + confusable 라틴 + '.'/'_'/'-' 로
//   이뤄진 연속열. 순수 ASCII 영단어는 무시(homograph 아님) — confusable 이 섞인 것만 검사 대상.
//   토큰 경계: 공백/구두점/괄호 등. dotted 형태(. 포함)만 command 후보로 본다(과탐 축소).
//   문자 클래스에 비-ASCII 식별자 영역(라틴 확장·키릴·그리스)을 \u 범위로 포함(raw 바이트 0).
const TOKEN_RE = new RegExp("[\\w.\\u0370-\\u03ff\\u0400-\\u04ff-]+", "gu");

export interface ScanContext {
  // danger command 이름 집합(homograph 의 fold 결과를 대조할 대상). 미주입이면 plan.ts 의 DESTRUCTIVE∪INJECT.
  //   executor 가 라이브 도메인맵의 command 이름을 넣어 "실제 존재하는 command 로 위장" 까지 잡을 수 있다.
  dangerNames?: Set<string>;
  // 전체 command 이름 집합(라이브 도메인맵). fold 결과가 어떤 실제 command 와 같으면(위험 여부 무관)
  //   homograph 위장으로 본다 — 위장 자체가 공격 의도. 미주입이면 dangerNames 만 대조.
  commandNames?: Set<string>;
}

// 한 텍스트에서 homograph command 위장을 찾는다. confusable 이 섞인 dotted 토큰을 fold 해서, 그 결과가
//   실제 command(danger 또는 전체) 이름과 같으면 플래그. fold 후에도 매칭 안 되면 무시(우발적 키릴 0).
function scanHomographs(text: string, ctx: ScanContext): ScanFlag[] {
  const flags: ScanFlag[] = [];
  const danger = ctx.dangerNames;
  const all = ctx.commandNames;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[0];
    if (!raw.includes(".")) continue; // dotted 식별자(command 형태)만.
    const { folded, hadConfusable } = foldConfusables(raw);
    if (!hadConfusable) continue; // confusable 안 섞임 = homograph 아님(순수 ASCII 명령은 정상 경로).
    const foldedLower = folded.toLowerCase();
    const isCmd =
      (danger && danger.has(foldedLower)) ||
      (all && all.has(foldedLower)) ||
      isMirroredDanger(foldedLower);
    if (isCmd) {
      flags.push({ kind: "homograph", evidence: evidence(raw), span: [m.index, m.index + raw.length] });
    }
  }
  return flags;
}

// plan.ts 의 danger 미러(DESTRUCTIVE∪INJECT)와 fold 결과를 대조 — ctx 미주입 시 폴백 진실.
//   classifyDanger 가 둘 중 하나면 danger command 이름. (단일 진실 = plan.ts 의 미러.)
function isMirroredDanger(name: string): boolean {
  return classifyDanger(name) !== undefined;
}

// 패턴 1회 매치 → flag(없으면 null). 첫 매치 위치를 span 으로.
function matchFlag(text: string, re: RegExp, kind: FlagKind): ScanFlag | null {
  const m = re.exec(text);
  if (!m) return null;
  return { kind, evidence: evidence(m[0]), span: [m.index, m.index + m[0].length] };
}

// 모든 INJECTION_PATTERNS 중 첫 매치 → flag(없으면 null). 하나라도 걸리면 prompt-injection.
function scanInjection(text: string): ScanFlag | null {
  for (const re of INJECTION_PATTERNS) {
    const f = matchFlag(text, re, "prompt-injection");
    if (f) return f;
  }
  return null;
}

// 한 텍스트를 전 시그니처로 검사 → flags. ctx 는 homograph 대조용 command 집합(미주입이면 미러 폴백).
//   순수 — I/O 0. 같은 입력 → 같은 출력(결정적). false-positive 0 은 시그니처의 좁음으로 보장.
export function scanText(text: string, ctx: ScanContext = {}): ScanFlag[] {
  if (typeof text !== "string" || !text) return [];
  const flags: ScanFlag[] = [];
  const inj = scanInjection(text);
  if (inj) flags.push(inj);
  const pipeCurl = matchFlag(text, CURL_PIPE, "pipe-to-interpreter");
  if (pipeCurl) flags.push(pipeCurl);
  else {
    const pipe = matchFlag(text, PIPE_INTERPRETER, "pipe-to-interpreter");
    if (pipe) flags.push(pipe);
  }
  const ansi = matchFlag(text, ANSI_ESCAPE, "ansi-control") ?? matchFlag(text, CONTROL_CHARS, "ansi-control");
  if (ansi) flags.push(ansi);
  const zw = matchFlag(text, ZERO_WIDTH, "zero-width");
  if (zw) flags.push(zw);
  flags.push(...scanHomographs(text, ctx));
  flags.push(...scanEncoded(text));
  return flags;
}

// ── 6) base64/hex 인코딩 의심 페이로드 ──
//   긴 base64/hex 덩어리는 난독화된 명령/스크립트를 숨길 수 있다. 좁게 — 충분히 긴 연속열(짧은 토큰·
//   해시·색상값 과탐 회피)만. 디코드해서 인터프리터 파이프/injection 이 나오면 더 강한 증거.
const BASE64_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;
const HEX_BLOB = /\b(?:[0-9a-fA-F]{2}[\s:]?){32,}\b/;

function scanEncoded(text: string): ScanFlag[] {
  const flags: ScanFlag[] = [];
  const b64 = BASE64_BLOB.exec(text);
  if (b64 && looksDecodable(b64[0])) {
    flags.push({ kind: "encoded-payload", evidence: evidence(b64[0]), span: [b64.index, b64.index + b64[0].length] });
  }
  const hex = HEX_BLOB.exec(text);
  if (hex) {
    flags.push({ kind: "encoded-payload", evidence: evidence(hex[0]), span: [hex.index, hex.index + hex[0].length] });
  }
  return flags;
}

// base64 후보가 실제로 디코드되어 텍스트(또는 의심 명령)를 내놓는지 — 디코드 실패/이진이면 무시(과탐 0).
//   디코드 결과에 인터프리터 파이프/injection 시그니처가 보이면 강한 증거(인코딩된 페이로드 확정).
function looksDecodable(blob: string): boolean {
  let decoded: string | null = null;
  try {
    const g: any = globalThis as any;
    if (typeof g.atob === "function") decoded = g.atob(blob);
    else if (g.Buffer) decoded = g.Buffer.from(blob, "base64").toString("utf8");
  } catch {
    return false;
  }
  if (!decoded) return false;
  // 디코드 결과가 대부분 인쇄가능 텍스트(ASCII printable)이고, injection/파이프 시그니처를 품으면 페이로드로 본다.
  const printable = decoded.replace(/[^\x20-\x7e]/g, "").length / decoded.length;
  if (printable < 0.8) return false; // 이진/잡음 → 무시(과탐 0).
  return PIPE_INTERPRETER.test(decoded) || CURL_PIPE.test(decoded) || scanInjection(decoded) !== null;
}

// plan step 자체를 텍스트화해 스캔 대상에 포함 — step 의 name/params/address 안에 박힌 시그니처를 잡는다
//   (untrusted 텍스트가 plan step 으로 흘러들어간 경우). 결정적 직렬화(JSON) — 키 순서 무관하게 값만.
function stepToText(s: PlanStep): string {
  const parts = [s.axis, s.name];
  if (s.address) parts.push(s.address);
  if (s.params) {
    try {
      parts.push(JSON.stringify(s.params));
    } catch {
      /* 직렬화 불가 params 는 건너뜀 */
    }
  }
  return parts.join(" ");
}

// 스캔 입력 — untrusted 텍스트 출처들 + plan step 들. 출처별로 검사해 어느 출처가 걸렸는지 추적 가능.
export interface ScanInput {
  // plan 을 만들어낸 untrusted 텍스트(browser-view text · tool result · inter-agent/@멘션 페이로드).
  //   각 항목은 { source, text } — source 는 추적/감사용 라벨(예: "browser:tab1", "agent:codex", "tool:read").
  untrusted?: Array<{ source: string; text: string }>;
  // plan step 들(step 자체에 박힌 시그니처도 검사). 미주입이면 step 검사 0.
  steps?: PlanStep[];
}

// 스캔 결과 — flags + verdict + 출처별 분해(어느 untrusted 출처/어느 step 이 걸렸나, 투명 보고).
export interface ScanReport extends ScanResult {
  // flags 가 어디서 나왔는지 — source 라벨별 flags(감사·되먹임). steps 는 source="step#i".
  bySource: Array<{ source: string; flags: ScanFlag[] }>;
}

// incoming-plan 스캔(공개 진입점, 순수) — untrusted 텍스트 출처들과 plan step 을 전 시그니처로 검사한다.
//   verdict="flagged" 면 executor 가 그 plan 을 refuse/quarantine(실행 0)하고 flags 를 되먹인다(self-correct).
//   verdict="clean" 이면 무음 통과(정상 입력 차단 0). ctx = homograph 대조용 라이브 command 집합(선택).
export function scanIncoming(input: ScanInput, ctx: ScanContext = {}): ScanReport {
  const bySource: Array<{ source: string; flags: ScanFlag[] }> = [];
  const all: ScanFlag[] = [];
  for (const u of input.untrusted ?? []) {
    const fs = scanText(u.text, ctx);
    if (fs.length) {
      bySource.push({ source: u.source, flags: fs });
      all.push(...fs);
    }
  }
  const steps = input.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const fs = scanText(stepToText(steps[i]), ctx);
    if (fs.length) {
      bySource.push({ source: `step#${i}`, flags: fs });
      all.push(...fs);
    }
  }
  return { flags: all, bySource, verdict: all.length ? "flagged" : "clean" };
}
