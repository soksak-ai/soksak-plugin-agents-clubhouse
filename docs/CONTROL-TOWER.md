# Control Tower — implementation guide & status

The "AI command" control tower of the Agents Clubhouse plugin: a titlebar entry
point that turns one line of natural language into project-wide orchestration over
soksak's three control axes (command / dom / status). This is the "what we need to
know" reference: requirements, what was built, how it works, verification, TODO.

- Landed on `main` via merge commit (`Merge feat/control-tower: AI-command control tower (M1-M11)`).
- Status: **complete** (M1–M11), socket + visually verified. Additive to the existing Clubhouse content tab — the 💬 conversation view is unchanged; the tower adds a titlebar ✦ icon.
- Everything lives in this plugin (`src/tower/`); **core changes: 0** (it only consumes generic, already-shipped core capabilities).

---

## 1. Requirements (why this exists)

The local control surface (command registry + `ui.*` dom + `status.query`) was
already reachable headlessly over the socket/CLI/MCP channels (`docs/AI-CONTROL.md`
in the core). What was missing was the **human-facing interaction surface**: a way
for a person to drive all of soksak with one natural-language line. The Clubhouse
plugin already had a multi-agent conversation engine (facilitator / turn / simul
modes, `@mention` chaining, persistent connections, live streaming, interrupt) but
could not call core commands beyond its own acp.* surface.

The control tower fuses the two: an AI-command modal (NL bar + clickable example
rows + command palette + search + live pane) × the Clubhouse multi-agent engine ×
the 3-axis substrate. **Additive to the existing UX** — the content tab stays; a
titlebar ✦ icon opens a project-wide orchestration modal: type "close the left
pane and make the terminal big" and agents drive everything.

Design principles followed:
- **Single execution point.** Every plan→dispatch goes through `executor.ts`, so
  invariants are enforced by tests in one place.
- **Fast-path / slow-path.** Deterministic paths (example rows, palette) execute
  without an agent; only ambiguous NL goes to the engine — lower cost and latency.
- **Expose everything (RULE 8).** All dom nodes, all commands, all status are
  observable so AI/E2E can drive the tower transparently. But observation and
  executor-writes are separate: the security chrome (danger-confirm) is visible in
  `ui.tree` yet **out of the executor's dom reach** — it cannot click its own gate.

---

## 2. What was built (work content)

11 commits on `feat/control-tower`, each RED→GREEN + socket/visual verified:

| M | commit | delivers |
|---|--------|----------|
| M1 | `2bcfb32` | `ui:titlebar` permission + a contract test that the plugin can call core commands (`state.commands`, `ui.tree`). |
| M2 | `06c800a` | titlebar ✦ action (`registerHeaderAction`) + an empty draggable 560px modal shell (content tab preserved). |
| M3 | `3a23698` | the modal body — NL bar, clickable example rows, live command palette, search, live pane; 5-theme CSS via core tokens. |
| M4 | `fa3526a` | fast-path executor + `plan.ts` validation; example/palette → `app.commands.execute`; destructive → confirm gate. |
| M5 | `7687d54` | slow-path orchestration — NL → engine → 3-axis plan → executor, with a dry-run preview and result feedback. |
| M6 | `99cda8d` | multi-agent distribution (per mode), a serial confirm queue, and interrupt. |
| M7 | `a015845` | session / trace persistence over `app.data` (plans + steps + outcomes). |
| M8 | `2931fe4` | post-execution reflection loop (dispatch → verify via `status.query`, not poll → re-plan) with max-steps / max-replan guards and escalation. |
| M9 | `ab964ba` | editable dry-run preview (delete / reorder / edit-param, re-validated) + limited honest rollback (snapshot → inverse commands for invertible steps only; non-invertible reported as `unrestorable`). |
| M10 | `5dfd067` | untrusted-content scanner (prompt-injection / homograph / pipe-to-interpreter / ANSI / zero-width / encoded) + taint tracking → a destructive step derived from untrusted context is forced through the confirm gate; flagged plans are refused. |
| M11 | `87ab983` | macro promotion — a repeated trusted NL→plan is proposed for promotion to a named fast-path (persisted via `app.data`), re-validated before each run; tainted plans are never promotable. |

---

## 3. Architecture & feature definitions

### Flow
```
NL input (or example-row click) → executor entry
 ├─ fast-path: exact/fuzzy palette or example match, not destructive
 │    → app.commands.execute(name, params)            (no agent, instant)
 └─ slow-path: ambiguous NL
      → Clubhouse engine (facil / turn / simul) with a live domain map injected
        (state.commands registry + ui.tree addresses + status.query)
      → agent(s) return a plan: [{axis:"command"|"dom"|"status", name, params|address}]
      → executor dispatches per step:
          command → app.commands.execute(name, params)
          dom     → app.commands.execute("ui.input.click"/"ui.input.fill", {address})
          status  → status.query  (pre/post check)
      → each step result feeds the next step / next turn (verify, not poll)
```

### Files (`src/tower/`)
| file | role |
|------|------|
| `header.ts` | the titlebar ✦ action + modal toggle (`active` highlight) |
| `modal.ts` | the thin modal view (DOM + `data-node` wiring); logic calls executor only |
| `executor.ts` | the single execution point — fast/slow path, danger gate, dispatch, reflection, rollback |
| `plan.ts` | plan-step schema + `validatePlan` (UNKNOWN_COMMAND / NOT_EXPOSED / INVALID_STEP) + `classifyDanger` |
| `distribute.ts` | per-mode plan distribution (facil / turn / simul / @mention) |
| `trace.ts` | M7 persistence over `app.data` |
| `editplan.ts` | M9 pure plan-edit ops (delete / reorder / edit-param) |
| `rollback.ts` | M9 invertible-command map + honest rollback |
| `scanner.ts` | M10 untrusted-content injection scanner |
| `macro.ts` | M11 macro detect / store / run |

### Safety model (the load-bearing invariants)
- **danger gate, woven not single-`if`.** Destructive / inject steps go through a desktop confirm; the gate is woven into execution (a confirm/derived value is a required input), so a single-branch patch cannot bypass it.
- **Confirm chrome is out of the executor's dom reach.** The danger-confirm modal is visible in `ui.tree` but is not dom-addressable for the executor — a malicious plan cannot `ui.input.click` its own approval.
- **Scope enforced per step**; untrusted-derived destructive is forced through confirm (M10); flagged plans are refused, not executed.
- **Single execution point** — `modal.ts` calls only the executor (no logic leak); all dispatch is serialized there.

### Headless surface (RULE: expose a command for everything)
All declared in `plugin.json contributes.commands` (the runtime conformance gate requires declared ≡ actual): `tower.plan` (slow-path NL→plan, dry-run/commit), `tower.reflect` (reflection loop), `tower.trace` (session history), `tower.scan` (untrusted-content scan), `tower.macro` (save/run/list/forget/propose). Namespaced as `plugin.soksak-plugin-agents-clubhouse.tower.*`.

---

## 4. How it works (usage)

- **Open**: click the titlebar ✦ icon (or the bound shortcut). A 560px draggable modal opens; the 💬 content tab is untouched.
- **NL command**: type e.g. "close the left pane and make the terminal big"; ambiguous input goes slow-path → a dry-run preview lists the steps; press ⏎ to commit. Exact matches to example rows / palette go fast-path (instant, no agent).
- **Example rows**: clicking a row fills the NL bar with that sentence and submits it.
- **Palette / search**: typing filters the live registry catalog; a row runs that command (destructive ⇒ confirm).
- **Dry-run editing (M9)**: in the preview you can delete / reorder steps and edit params before committing; the edited plan is re-validated.
- **Multi-agent (M6)**: in facil mode a facilitator splits the plan by domain via `@mention`; turn mode chains dependent steps round-robin; simul runs independent plans in parallel. Destructive confirms are serialized one at a time.
- **Macros (M11)**: a repeated trusted plan can be saved as a named fast-path and run instantly next time.
- **Headless / E2E**: drive any of it with `sok plugin.soksak-plugin-agents-clubhouse.tower.plan` / `.reflect` / `.trace` / `.scan` / `.macro`.

---

## 5. Verification

- **224 tests** (tsc clean; vitest 14 files), covering the tower modules (plan, executor, slowpath, distribution, trace, reflect, editplan, rollback, scanner, macro) plus the conversation engine. Each milestone was RED→GREEN, with sabotage tests proving the security invariants (confirm-self-click `NOT_EXPOSED`, the woven gate, per-step scope).
- **Socket verification**: every feature driven headlessly via `sok …tower.*` and the dom-control surface; the `NOT_EXPOSED` confirm-chrome invariant and the danger-gate were exercised over the live socket.
- **Visual verification**: `window.snapshot` PNGs read directly across the 5 themes (Cupertino / Midnight / Bare / Phosphor / Paper); styling defects fixed and re-captured.
- Real-agent utterance E2E produced an actual layout change (slow-path NL → dispatch).

---

## 6. TODO / notes

- The control tower is feature-complete for its scope (M1–M11). Its natural extension is the broader project goal: the same 3-axis control driven **remotely from a phone** — that is the core's phone-link work (`vsterm-tauri/docs/PHONE-LINK-GUIDE.md`), which exposes `command`/`dom`/`status` over an authenticated encrypted channel. The tower and phone-link share the same substrate.
- Themes are driven entirely by core CSS variables (`--card`/`--bd`/`--acc`/`--accbg`/`--inset`), so there is no per-theme code to maintain.
- Trace/macros persist via `app.data` (no raw SQL), so they survive reload and are namespaced to the plugin.
