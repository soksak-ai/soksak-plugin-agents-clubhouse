import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  detectMentions,
  driveExchange,
  driveSimul,
  inviteePreamble,
  nextSpeaker,
  participants,
  runExchange,
  type RosterEntry,
  type Utterance,
} from "./conversation";

const roster = (ids: string[], checked: string[]): RosterEntry[] =>
  ids.map((id) => ({ id, checked: checked.includes(id) }));
const nameOf = (id: string): string =>
  ({ claude: "Claude", codex: "Codex", gemini: "Gemini" })[id] ?? id;

describe("participants — 체크된 것, 탭 순서 보존", () => {
  it("체크된 에이전트만, 배열(탭) 순서대로", () => {
    expect(participants(roster(["claude", "codex", "gemini"], ["claude", "gemini"]))).toEqual([
      "claude",
      "gemini",
    ]);
  });
  it("드래그로 순서가 바뀌면 참여 순서도 바뀐다", () => {
    expect(participants(roster(["gemini", "claude", "codex"], ["claude", "codex", "gemini"]))).toEqual([
      "gemini",
      "claude",
      "codex",
    ]);
  });
  it("아무도 체크 안 하면 빈 참여자", () => {
    expect(participants(roster(["claude", "codex"], []))).toEqual([]);
  });
});

describe("nextSpeaker — 참견 모드별 턴 순서", () => {
  const parts = ["claude", "codex", "gemini"];
  it("turn(턴제): 참여자 각 1회, 탭 순서, 한 바퀴 후 끝", () => {
    expect(nextSpeaker(parts, "turn", 0, 5)).toBe("claude");
    expect(nextSpeaker(parts, "turn", 1, 5)).toBe("codex");
    expect(nextSpeaker(parts, "turn", 2, 5)).toBe("gemini");
    expect(nextSpeaker(parts, "turn", 3, 5)).toBeNull();
  });
  it("free(자유): 라운드 반복, 탭 순서 순환", () => {
    expect(nextSpeaker(parts, "free", 0, 2)).toBe("claude");
    expect(nextSpeaker(parts, "free", 3, 2)).toBe("claude"); // 2바퀴째 시작
    expect(nextSpeaker(parts, "free", 5, 2)).toBe("gemini"); // 2바퀴째 마지막
  });
  it("free: maxRounds 바퀴 초과 시 끝(폭주 방지 안전판)", () => {
    expect(nextSpeaker(parts, "free", 6, 2)).toBeNull(); // 2*3=6 도달
  });
  it("참여자 0이면 항상 null", () => {
    expect(nextSpeaker([], "turn", 0, 5)).toBeNull();
    expect(nextSpeaker([], "free", 0, 5)).toBeNull();
  });
});

describe("buildPrompt — canonical 재주입(방 구성 + 전체 대화)", () => {
  const r = roster(["claude", "codex"], ["claude", "codex"]);
  const conv: Utterance[] = [
    { who: "human", text: "안녕" },
    { who: "claude", text: "반가워요" },
  ];
  it("로스터의 동료(자신 제외)를 알린다", () => {
    const p = buildPrompt({ roster: r, conversation: conv, speaker: "codex" });
    expect(p).toContain("codex");
    expect(p).toContain("claude"); // 동료
  });
  it("전체 대화를 사용자/이름으로 재주입한다", () => {
    const p = buildPrompt({ roster: r, conversation: conv, speaker: "codex" });
    expect(p).toContain("사용자: 안녕");
    expect(p).toContain("claude: 반가워요");
  });
  it("nameOf 로 표시명을 치환한다", () => {
    const p = buildPrompt({
      roster: r,
      conversation: conv,
      speaker: "codex",
      nameOf: (id) => ({ claude: "Claude", codex: "Codex" })[id] ?? id,
    });
    expect(p).toContain("Codex");
    expect(p).toContain("Claude: 반가워요");
  });
  it("preamble 가 있으면 기본 지시를 대체한다", () => {
    const p = buildPrompt({ roster: r, conversation: conv, speaker: "codex", preamble: "초대장X" });
    expect(p.startsWith("초대장X")).toBe(true);
  });
  it("대화가 비면 [지금까지의 대화] 블록이 없다", () => {
    const p = buildPrompt({ roster: r, conversation: [], speaker: "claude" });
    expect(p).not.toContain("[지금까지의 대화]");
  });
});

describe("runExchange — 교환 실행(턴 순서·canonical·견고함)", () => {
  const r = roster(["claude", "codex", "gemini"], ["claude", "codex", "gemini"]);
  const human: Utterance[] = [{ who: "human", text: "이 과제를 처리하자" }];

  it("turn 모드: 참여자 각 1회, 탭 순서로 발화", async () => {
    const seen: string[] = [];
    const out = await runExchange({
      roster: r,
      mode: "turn",
      conversation: human,
      maxRounds: 5,
      turn: async (id) => {
        seen.push(id);
        return `${id} 응답`;
      },
    });
    expect(seen).toEqual(["claude", "codex", "gemini"]);
    expect(out.map((u) => u.who)).toEqual(["claude", "codex", "gemini"]);
  });

  it("canonical: 뒤 발화자는 앞 발화자의 말을 프롬프트에서 본다", async () => {
    const prompts: Record<string, string> = {};
    await runExchange({
      roster: r,
      mode: "turn",
      conversation: human,
      maxRounds: 5,
      turn: async (id, prompt) => {
        prompts[id] = prompt;
        return `${id}의 의견`;
      },
    });
    // codex 프롬프트엔 앞선 claude 발화가 들어 있다(누적 재주입).
    expect(prompts["codex"]).toContain("claude의 의견");
    expect(prompts["gemini"]).toContain("codex의 의견");
  });

  it("free 모드: maxRounds 바퀴(참여자 3 × 2 = 6 발화)", async () => {
    const seen: string[] = [];
    await runExchange({
      roster: r,
      mode: "free",
      conversation: human,
      maxRounds: 2,
      turn: async (id) => {
        seen.push(id);
        return `${id}`;
      },
    });
    expect(seen).toEqual(["claude", "codex", "gemini", "claude", "codex", "gemini"]);
  });

  it("빈/실패 발화는 건너뛰되 대화는 지속(견고함)", async () => {
    const out = await runExchange({
      roster: r,
      mode: "turn",
      conversation: human,
      maxRounds: 5,
      turn: async (id) => {
        if (id === "claude") return "   "; // 빈 발화
        if (id === "codex") throw new Error("prompt 실패");
        return `${id} 응답`;
      },
    });
    expect(out.map((u) => u.who)).toEqual(["gemini"]); // claude(빈)·codex(실패) 제외
  });

  it("onUtterance 로 라이브 통지한다", async () => {
    const live: Utterance[] = [];
    await runExchange({
      roster: r,
      mode: "turn",
      conversation: human,
      maxRounds: 5,
      turn: async (id) => `${id}!`,
      onUtterance: (u) => live.push(u),
    });
    expect(live.map((u) => u.who)).toEqual(["claude", "codex", "gemini"]);
  });

});

describe("driveExchange — 사람 참견(cancel + 같은 화자 재시작)", () => {
  const r = roster(["a", "b"], ["a", "b"]);

  it("턴 도중 참견하면 그 발화 폐기 + 같은 화자가 사람 메시지 보고 재시작, 턴 미advance", async () => {
    const conv: Utterance[] = [{ who: "human", text: "시작" }];
    let interject = false;
    const seq: string[] = [];
    const prompts: string[] = [];
    let aDone = false;
    await driveExchange({
      roster: r,
      mode: "turn",
      conversation: conv,
      maxRounds: 5,
      consumeInterject: () => {
        const v = interject;
        interject = false;
        return v;
      },
      turn: async (speaker, prompt) => {
        seq.push(speaker);
        prompts.push(prompt);
        if (speaker === "a" && !aDone) {
          aDone = true;
          // a 첫 턴 "도중" 사람 참견: conversation 에 사람 메시지 + 플래그 set(라이브에선 cancel 이 유발).
          conv.push({ who: "human", text: "잠깐 이렇게 해줘" });
          interject = true;
          return "a 취소될 발화";
        }
        return `${speaker} 발화`;
      },
    });
    // a(취소) → a(재시작) → b. 취소 발화는 대화에 없고, a 재시작 프롬프트는 사람 참견을 본다.
    expect(seq).toEqual(["a", "a", "b"]);
    expect(conv.filter((u) => u.who !== "human").map((u) => u.who)).toEqual(["a", "b"]);
    expect(conv.some((u) => u.text === "a 취소될 발화")).toBe(false);
    expect(prompts[1]).toContain("잠깐 이렇게 해줘");
  });

  it("참견 없으면 turn 모드대로 한 바퀴", async () => {
    const conv: Utterance[] = [{ who: "human", text: "시작" }];
    const seq: string[] = [];
    await driveExchange({
      roster: r,
      mode: "turn",
      conversation: conv,
      maxRounds: 5,
      turn: async (speaker) => {
        seq.push(speaker);
        return `${speaker}!`;
      },
    });
    expect(seq).toEqual(["a", "b"]);
  });
});

describe("driveSimul — 동시(병렬·스냅샷 고정·도착순 push)", () => {
  const r = roster(["a", "b", "c"], ["a", "b", "c"]);

  it("전원이 같은 맥락(스냅샷)을 보고 병렬 1회 — 서로의 동시 응답은 프롬프트에 없음", async () => {
    const conv: Utterance[] = [{ who: "human", text: "질문" }];
    const prompts: Record<string, string> = {};
    await driveSimul({
      roster: r,
      conversation: conv,
      turn: async (speaker, prompt) => {
        prompts[speaker] = prompt;
        return `${speaker} 답`;
      },
    });
    // 세 참여자 모두 발화(누락 0).
    expect(conv.filter((u) => u.who !== "human").map((u) => u.who).sort()).toEqual(["a", "b", "c"]);
    // 동시 — 어떤 프롬프트에도 다른 참여자의 이번 답이 들어있지 않다(스냅샷 고정).
    for (const p of Object.values(prompts)) {
      expect(p).not.toContain("a 답");
      expect(p).not.toContain("b 답");
      expect(p).not.toContain("c 답");
    }
  });

  it("실제 병렬 — 느린 a 가 끝나기 전에 b 가 시작된다", async () => {
    const conv: Utterance[] = [{ who: "human", text: "q" }];
    const started: string[] = [];
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((res) => (releaseA = res));
    await driveSimul({
      roster: roster(["a", "b"], ["a", "b"]),
      conversation: conv,
      turn: async (speaker) => {
        started.push(speaker);
        if (speaker === "a") await aGate; // a 는 b 가 시작 신호를 줄 때까지 대기
        if (speaker === "b") releaseA(); // b 가 먼저 진행되면서 a 를 푼다
        return `${speaker}!`;
      },
    });
    // 병렬이 아니면(순차) a 가 aGate 에서 영영 막혀 데드락 → 완료되었다는 것 자체가 동시 증거.
    expect(started).toContain("a");
    expect(started).toContain("b");
  });

  it("한 참여자 실패(throw)는 그 발화만 건너뛰고 나머지는 발화", async () => {
    const conv: Utterance[] = [{ who: "human", text: "q" }];
    await driveSimul({
      roster: r,
      conversation: conv,
      turn: async (speaker) => {
        if (speaker === "b") throw new Error("b 연결 실패");
        return `${speaker}!`;
      },
    });
    expect(conv.filter((u) => u.who !== "human").map((u) => u.who).sort()).toEqual(["a", "c"]);
  });
});

describe("inviteePreamble — 방 정체성 + 인간 대화 결 + @멘션", () => {
  it("Studio 협업방·cwd·메타금지", () => {
    const p = inviteePreamble("claude", ["claude", "codex"], nameOf, "/repo");
    expect(p).toContain("Studio");
    expect(p).toContain("협업");
    expect(p).toContain("/repo");
    expect(p).toContain("내부 절차"); // 메타 서술 금지
    expect(p).toContain("Codex"); // 동료
  });
  it("인간 대화 결 — 독백 금지·침묵 허용·억지 포함 금지(다만 잊지 말기)·@멘션 규칙", () => {
    const p = inviteePreamble("claude", ["claude", "codex"], nameOf, "/repo");
    expect(p).toContain("독백");
    expect(p).toContain("침묵");
    expect(p).toContain("억지로");
    expect(p).toContain("잊지");
    expect(p).toContain("@이름");
  });
  it("simul 노트 — 끝까지·기다림 소프트(강제 아님). 비-simul 엔 없음", () => {
    const p = inviteePreamble("claude", ["claude", "codex"], nameOf, "/repo", true);
    expect(p).toContain("동시 발화");
    expect(p).toContain("끝까지");
    expect(p).toContain("기다려");
    expect(p).toContain("강제는 아닙니다");
    expect(inviteePreamble("claude", ["claude", "codex"], nameOf, "/repo", false)).not.toContain(
      "동시 발화",
    );
  });
  it("Clubhouse 잔재 없음 — <회고>/<잡담> 사교 태그 미주입(단일 대화 통합)", () => {
    const p = inviteePreamble("claude", ["claude", "codex"], nameOf, "/repo");
    expect(p).not.toContain("<회고>");
    expect(p).not.toContain("<잡담>");
    expect(p).not.toContain("Clubhouse");
  });
});

describe("detectMentions — @지목(작업 대화에서 특정 동료 직접 호출)", () => {
  const r = ["claude", "codex", "gemini"];
  it("'@이름' 지목 → 그 id", () => {
    expect(detectMentions("이건 @Codex 가 검증해줘", r, "claude", nameOf)).toEqual(["codex"]);
  });
  it("'@id'(소문자)로도", () => {
    expect(detectMentions("@gemini 확인 부탁", r, "claude", nameOf)).toEqual(["gemini"]);
  });
  it("'@' 없는 단순 이름 언급은 지목 아님", () => {
    expect(detectMentions("Codex 와 함께 짰다", r, "claude", nameOf)).toEqual([]);
  });
  it("자기 자신 @지목 제외", () => {
    expect(detectMentions("@Claude 내가 한다", r, "claude", nameOf)).toEqual([]);
  });
  it("여럿 @지목 — 등장 순서·중복 제거", () => {
    expect(detectMentions("@Gemini 랑 @Codex, 또 @Gemini", r, "claude", nameOf)).toEqual([
      "gemini",
      "codex",
    ]);
  });
  it("체크 안 된 구경꾼도 roster 에 있으면 @지목 가능", () => {
    expect(detectMentions("@Gemini 의견?", r, "codex", nameOf)).toEqual(["gemini"]);
  });
});
