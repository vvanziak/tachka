# Tachka

Agent that plays Heroes of Might and Magic III through VCMI. A "king" (a language model, or a script) decides each turn; code gathers facts, walks heroes and builds what the king names. It talks to a player slot of the `ClaudeBridge` AI (VCMI fork, `AI/ClaudeBridge`, wire format in its `PROTOCOL.md`).

Name: what we called the computer player 25 years ago (тачка).

## Play a game against Tachka

1. Start the VCMI client with a slot for Tachka. The colour is the slot Tachka takes (red 37100, blue 37101, tan 37102, green 37103, ...):
   ```sh
   cd ~/Projects/vcmi-build/bin && VCMI_CLAUDE_PLAYER=blue ./vcmiclient --nointro
   ```
   In the lobby choose a map, play yourself as another colour, and start the game.
2. Start Tachka (the king uses your Claude Code login through the `claude` CLI; set `ANTHROPIC_API_KEY` and pass `--king api` to use the API instead):
   ```sh
   cd ~/Projects/tachka && npm install && npm run play -- --player blue
   ```
3. Open http://127.0.0.1:8787. Write in the box at any moment, on your turn or hers: a separate talker answers right away from the same facts and journal (a second model call, so it works while the king is thinking or waiting). Everything you write also reaches the king at its next decision, together with what the talker already answered. Pause stops the king before its next decision; chat keeps working.

When the game ends (or the client is closed) Tachka stays up: it saves `final.json` (the bridge's last answers plus the last facts it saw), shows a Game over card, and you can talk the game over with it.

Restarting needs no flag: Tachka looks at the game's day and continues the latest game folder (journal, economy plan, turn counter, chat) when that game was not won or lost and its last day is not after today's; otherwise it starts a new folder. `--new` forces a new folder, `--resume` forces the latest one. A closed or crashed client does not end a game, so restarting and loading an autosave continues it.

Pace and limits: `--pace 20` makes each turn last at least 20 seconds so you can follow it; `--max-heroes 3` (default) refuses hires beyond that.

Options: `--king cli|api|scripted` (scripted needs no model), `--model sonnet` (CLI), `--turns N`, `--ui PORT`, `--out DIR` (default `logs/<time>`: `exchanges.jsonl` is every bridge request and reply, `journal.jsonl` is one line per turn).

A model failure never stops the game: the page shows the problem, the economy plan keeps running and heroes stand still until the next turn.

## How it fits together

- `facts.ts`, `blockers.ts`, `missions.ts`: what the king sees (economy, buildings blocked by a resource and the sites that supply it, reachable sites with guards).
- `king.ts`, `llmKing.ts`, `brain.ts`, `brief.ts`, `prompts/king.md`: the decision (`note`, `reply`, `plan`, `missions`, `hire`, `merge`), the model adapters and the prompt that carries the human's advice.
- `plan.ts`, `executor.ts`: the economy plan and its executor; anything it cannot do comes back as a deviation.
- `loop.ts`, `turn.ts`: wait for our turn, brief, decide, execute, journal, end turn. Dialogs use fixed answers in `questions.ts`.
- `server.ts`, `ui/index.html`: the web page and its event stream.
- `tools/`: mine past games from Claude Code transcripts into per-turn records and pick decision scenarios from them.
- `docs/`: gaps found in the plan format and the missions design.

## Tests

```sh
npm test
npm run typecheck
```
