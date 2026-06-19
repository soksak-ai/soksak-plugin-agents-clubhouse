// conversation — Studio 대화 순수 로직(앱/DOM 비의존 — vitest 단위검증 대상).
// 참여자(탭 순서)·참견 모드별 다음 발화자·canonical 턴 프롬프트·한 교환(exchange) 실행.
// 실 연결/세션은 주입된 turn() 뒤로 숨긴다 — 실행 로직을 실 에이전트·인증 없이 결정적으로 검증.
//
// 모델(사용자 확정):
//  - 로스터 = 탭(드래그 정렬). 탭 순서 = 턴 순서. 체크된 것 = 주요 참여자.
//  - 참견 모드: turn(턴제) = 참여자 각 1회, 탭 순서. free(자유) = 라운드 반복(끼어들기 emergent),
//    maxRounds 바퀴 안전판(강제 아님 — 호명 기반 종료는 P3에서 합류).
//  - canonical: 매 턴 [방 구성(로스터) + 전체 대화] 재주입(세션 메모리 비의존).

export interface RosterEntry {
  id: string;
  checked: boolean;
}
export type KibitzMode = "turn" | "free" | "simul";
export interface Utterance {
  who: string; // 에이전트 id 또는 "human"
  text: string;
}

export type TurnFn = (agentId: string, prompt: string) => Promise<string>;

// 참여자 = 체크된 에이전트, 탭(배열) 순서 보존 = 턴 순서.
export function participants(roster: RosterEntry[]): string[] {
  return roster.filter((r) => r.checked).map((r) => r.id);
}

// 다음 발화자 — 이번 교환에서 나온 에이전트 발화 수(agentTurnCount) 기준.
//  turn: 참여자 각 1회(탭 순서). 한 바퀴 돌면 끝(null).
//  free: 탭 순서 라운드 반복, 최대 maxRounds 바퀴(폭주 방지 cap — 강제 아닌 안전판). 초과 시 끝.
export function nextSpeaker(
  parts: string[],
  mode: KibitzMode,
  agentTurnCount: number,
  maxRounds: number,
): string | null {
  if (parts.length === 0) return null;
  if (mode === "turn") return agentTurnCount < parts.length ? parts[agentTurnCount] : null;
  const cap = Math.max(1, maxRounds) * parts.length;
  return agentTurnCount < cap ? parts[agentTurnCount % parts.length] : null;
}

// canonical 턴 프롬프트 — 매 턴 [방 구성(로스터) + 전체 대화]를 재주입(세션 메모리 비의존). speaker 1인칭.
// preamble = 상위(P3 초대장 등)가 끼우는 추가 지시. 없으면 기본 협업 지시(역할 고정 X — 자기 턴에 실작업).
export function buildPrompt(opts: {
  roster: RosterEntry[];
  conversation: Utterance[];
  speaker: string;
  nameOf?: (id: string) => string;
  preamble?: string;
}): string {
  const name = (id: string) => (opts.nameOf ? opts.nameOf(id) : id);
  const others = opts.roster
    .filter((r) => r.checked && r.id !== opts.speaker)
    .map((r) => name(r.id));
  const room = others.length
    ? `이 작업공간엔 동료 ${others.join(", ")}와(과) 당신(${name(opts.speaker)})이 함께 있습니다.`
    : `지금은 당신(${name(opts.speaker)}) 혼자입니다.`;
  const lines = opts.conversation.map(
    (m) => `${m.who === "human" ? "사용자" : name(m.who)}: ${m.text}`,
  );
  const convo = lines.length ? `\n\n[지금까지의 대화]\n${lines.join("\n\n")}` : "";
  const base =
    opts.preamble ??
    `당신은 ${name(opts.speaker)}입니다. ${room} 위 대화에 이어 당신의 차례로 응답하세요. ` +
      `필요한 작업이 있으면 설명만 하지 말고 당신의 도구로 실제 파일을 만들거나 명령을 실행해 처리하세요.`;
  return `${base}${convo}`;
}

// driveExchange — 한 교환의 핵심 루프(라이브·헤드리스 공용). 참견 모드대로 참여자가 턴을 돈다. 각 턴:
// canonical 프롬프트 → turn(). turn() 실패/빈 응답은 그 발화만 건너뛴다(대화 지속, 견고함 규율).
//
// 사람 참견 — turn() 도중 사람이 끼어들면(호출자가 conversation 에 사람 메시지 append + 플래그 set),
// 그 턴 직후 consumeInterject() 가 true → 그 발화를 폐기하고 **같은 화자를 재시작**한다(턴 미advance →
// conversation 에 반영된 사람 메시지를 보고 다시 말함). 렌더·연결·cancel 은 turn()/콜백으로 분리(DOM/엔진 비의존).
// conversation 은 호출자와 공유(in-place) — 에이전트 발화는 여기서 push.
export async function driveExchange(opts: {
  roster: RosterEntry[];
  mode: KibitzMode;
  conversation: Utterance[]; // 공유(in-place) — 사람 메시지는 호출자가, 에이전트 발화는 여기서 append
  maxRounds: number;
  turn: TurnFn;
  consumeInterject?: () => boolean; // 직전 턴 중 사람 참견? (읽으며 리셋) — 없으면 참견 없음
  nameOf?: (id: string) => string;
  preamble?: (speaker: string) => string;
  onTurnStart?: (speaker: string) => void;
  onUtterance?: (u: Utterance) => void;
  onDiscard?: (speaker: string) => void; // 참견으로 폐기된 발화
}): Promise<void> {
  const parts = participants(opts.roster);
  let agentTurns = 0;
  for (;;) {
    const speaker = nextSpeaker(parts, opts.mode, agentTurns, opts.maxRounds);
    if (!speaker) break;
    opts.onTurnStart?.(speaker);
    const prompt = buildPrompt({
      roster: opts.roster,
      conversation: opts.conversation,
      speaker,
      nameOf: opts.nameOf,
      preamble: opts.preamble?.(speaker),
    });
    let text = "";
    try {
      text = (await opts.turn(speaker, prompt)).trim();
    } catch {
      text = ""; // 실패 → 빈 발화로 취급(건너뜀)
    }
    if (opts.consumeInterject?.()) {
      opts.onDiscard?.(speaker);
      continue; // 사람 참견 — 발화 폐기, 같은 화자 재시작(턴 미advance)
    }
    if (text) {
      const u: Utterance = { who: speaker, text };
      opts.conversation.push(u);
      opts.onUtterance?.(u);
    }
    agentTurns++;
  }
}

// driveSimul — 동시(simul) 모드. 턴테이킹 없음: 전원이 같은 맥락(현재 대화의 스냅샷)을 보고 **병렬로** 1회씩
// 응답한다. 서로의 동시 응답은 못 본다(스냅샷 고정 — 한 사람 질문에 다 같이 반응하는 그룹챗 모델). 완료된 발화는
// 도착 순서대로 conversation 에 push(동시이므로 순서는 완료 시점). 참견·재시작 없음(원샷 라운드).
export async function driveSimul(opts: {
  roster: RosterEntry[];
  conversation: Utterance[]; // 공유(in-place) — 사람 메시지는 호출자가, 에이전트 발화는 여기서 append
  turn: TurnFn;
  nameOf?: (id: string) => string;
  preamble?: (speaker: string) => string;
  onTurnStart?: (speaker: string) => void;
  onUtterance?: (u: Utterance) => void;
}): Promise<void> {
  const parts = participants(opts.roster);
  const snapshot = opts.conversation.slice(); // 고정 — 전원 동일 맥락(서로의 동시 응답은 안 보임)
  await Promise.all(
    parts.map(async (speaker) => {
      opts.onTurnStart?.(speaker);
      const prompt = buildPrompt({
        roster: opts.roster,
        conversation: snapshot,
        speaker,
        nameOf: opts.nameOf,
        preamble: opts.preamble?.(speaker),
      });
      let text = "";
      try {
        text = (await opts.turn(speaker, prompt)).trim();
      } catch {
        text = ""; // 실패 → 빈 발화(건너뜀, 다른 참여자엔 영향 없음)
      }
      if (text) {
        const u: Utterance = { who: speaker, text };
        opts.conversation.push(u);
        opts.onUtterance?.(u);
      }
    }),
  );
}

// 헤드리스 1교환(참견 없음) — driveExchange 위 얇은 래퍼. 대화 복사본으로 돌리고 이번 교환의 에이전트 발화만 반환.
export async function runExchange(opts: {
  roster: RosterEntry[];
  mode: KibitzMode;
  conversation: Utterance[]; // 원본 변형 안 함(복사)
  maxRounds: number;
  turn: TurnFn;
  nameOf?: (id: string) => string;
  preamble?: (speaker: string) => string;
  onUtterance?: (u: Utterance) => void;
}): Promise<Utterance[]> {
  const produced: Utterance[] = [];
  await driveExchange({
    roster: opts.roster,
    mode: opts.mode,
    conversation: opts.conversation.slice(),
    maxRounds: opts.maxRounds,
    turn: opts.turn,
    nameOf: opts.nameOf,
    preamble: opts.preamble,
    onUtterance: (u) => {
      produced.push(u);
      opts.onUtterance?.(u);
    },
  });
  return produced;
}

// 초대장(페르소나) — 매 턴 프롬프트의 preamble. 방 정체성 + 인간 그룹 대화의 결을 주입. 이게 없으면 에이전트가
// 솔로 세션처럼 굴거나 기계적으로 턴을 채운다. simul=동시 모드 한정 소프트 노트(상대 말 끝까지·지목 답 기다림, 강제 X).
export function inviteePreamble(
  speaker: string,
  roster: string[],
  nameOf: (id: string) => string,
  cwd?: string,
  simul?: boolean,
): string {
  const others = roster.filter((id) => id !== speaker).map(nameOf);
  const room = others.length
    ? `동료 ${others.join(", ")} 와(과) 당신(${nameOf(speaker)})이 함께 있습니다.`
    : `지금은 당신(${nameOf(speaker)}) 혼자입니다.`;
  const place = cwd ? ` 작업 디렉터리는 ${cwd} 입니다.` : "";
  const at = `@${others[0] ?? "동료"}`;
  // 동시(simul) 모드 — 전원이 같은 순간에 답해 서로의 답을 못 봄. 양보·기다림은 소프트(강제 X — 턴제 강요는 대화를 굳힌다).
  const simulNote = simul
    ? `\n[동시 발화] 지금은 모두가 같은 순간에 답합니다 — 이번 차례엔 서로의 답을 아직 못 봅니다. 되도록 상대의 말을 끝까지 듣고, 누군가 '@이름'으로 지목하면 그 동료의 답을 기다려 주세요. 강제는 아닙니다 — 자연스러우면 그대로 답하세요.`
    : "";
  return (
    `여기는 'Studio' — 여러 AI 코딩 에이전트가 한 워크스페이스에서 사용자의 일을 함께 하는 협업 채팅방입니다. ` +
    `${room}${place}\n` +
    `당신은 ${nameOf(speaker)} 본인으로서, 여러 사람이 한자리에 모여 이야기하듯 참여하세요. 사람들의 대화는 이렇게 흐릅니다:\n` +
    `- 순서는 기계적이지 않습니다. 차례를 채우려 말하지 말고, 보탤 게 있을 때 말하세요. 할 말이 없으면 듣고 넘겨도 됩니다(침묵도 참여입니다).\n` +
    `- 방금 나온 말에 곧바로 반응하세요 — 동의·보충·반론·질문. 길게 독백하지 말고 짧게 주고받으세요.\n` +
    `- 이미 나온 말은 반복하지 마세요. 같은 결론이면 짧게 동의만 하고, 다르면 그 관점을 보태세요.\n` +
    `- 가끔은 두 사람이 한 주제를 깊이 주고받습니다 — 억지로 끼어들지 말고 지켜보다, 정말 보탤 게 생기면 들어오세요. 누구도 억지로 끌어들이지는 마세요. 다만 아무도 잊지도 마세요 — 어떤 주제가 특정 동료의 몫이면 자연스럽게 부르면 됩니다.\n` +
    `- 특정 동료의 답이 필요하면 본문에 '${at}'처럼 '@이름'으로 지목하세요 — 지목된 동료가 이어서 답합니다.\n` +
    `- 작업이 필요하면 설명만 하지 말고 당신의 도구로 실제 파일/명령으로 처리하세요(위 작업 디렉터리 기준).\n` +
    `- 당신의 내부 절차(어떤 스킬을 쓰는지, 세션 설정·규칙 확인 등)는 대화에 적지 마세요 — 인사·의견·결과만 자연스럽게.` +
    simulNote
  );
}

// @멘션 — 작업 대화에서 '@이름' 또는 '@id' 로 특정 동료를 지목(직접 답 요청). 자기 자신 제외, 등장 순서·중복 제거.
// '@' 가 명시 신호 — '@' 없는 단순 이름 언급은 호명이 아니다. roster=방 구성 전원(체크 무관 — 구경꾼도 @지목되면 깨어남).
export function detectMentions(
  text: string,
  roster: string[],
  speaker: string,
  nameOf: (id: string) => string,
): string[] {
  const hay = text.toLowerCase();
  const out: { id: string; idx: number }[] = [];
  for (const id of roster) {
    if (id === speaker) continue;
    let best = -1;
    for (const cand of [nameOf(id), id]) {
      const i = hay.indexOf(("@" + cand).toLowerCase());
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) out.push({ id, idx: best });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out.map((x) => x.id);
}
