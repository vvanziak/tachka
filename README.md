# Tachka

Agent that plays Heroes of Might and Magic III through VCMI. It talks to a player slot of the `ClaudeBridge` AI (VCMI fork, `AI/ClaudeBridge`) over local TCP; the wire format is in that directory's `PROTOCOL.md`.

Name: what we called the computer player 25 years ago (тачка).

## Status

Skeleton only: bridge client, headless core with a human message inbox and event stream, console client, JSONL exchange recorder. No brain yet. Plan:

1. Protocol client and recorder (done).
2. Deterministic turn routines (recruit, build chain, merge, garrison, save).
3. Structured state and memory; compact per-turn brief.
4. Escalation triggers and an Anthropic brain.
5. Tiered models and cost tracking.
6. Several agents in one game (one process per slot; slot ports are 37100 + player index).
7. OpenAI-compatible brain (OpenRouter, local models).

## Run

```sh
npm install
npm test
npm run console -- --player red --record logs/game.jsonl   # needs a running VCMI client with a ClaudeBridge slot
```

Console: plain text goes to Tachka's inbox, `/call <cmd> [json]` sends a bridge command, `/pause`, `/resume`, `/quit`.
