import { ClaudeCliBrain, AnthropicBrain, type Brain } from "./brain.js";
import { Tachka } from "./core.js";
import { Journal } from "./journal.js";
import { ScriptedKing, type King } from "./king.js";
import { LlmKing } from "./llmKing.js";
import { playGame, waitForBridge } from "./loop.js";
import { existsSync, readdirSync } from "node:fs";
import { PLAYER_COLORS, portForPlayer, type PlayerColor } from "./protocol.js";
import { jsonlRecorder } from "./recorder.js";
import { startServer } from "./server.js";

const args = new Map<string, string>();
for(let i = 2; i < process.argv.length; i++) {
	const flag = process.argv[i] ?? "";
	const next = process.argv[i + 1];
	if(next !== undefined && !next.startsWith("--")) {
		args.set(flag, next);
		i++;
	}
}

const player = (args.get("--player") ?? "red") as PlayerColor;
if(!PLAYER_COLORS.includes(player))
	throw new Error(`--player must be one of ${PLAYER_COLORS.join(", ")}`);
const kingKind = args.get("--king") ?? (process.env.ANTHROPIC_API_KEY ? "api" : "cli");
const maxTurns = args.has("--turns") ? Number(args.get("--turns")) : undefined;
const uiPort = Number(args.get("--ui") ?? "8787");
const resume = process.argv.includes("--resume");
const latest = existsSync("logs") ? readdirSync("logs").filter(d => existsSync(`logs/${d}/journal.jsonl`)).sort().at(-1) : undefined;
const dir = args.get("--out") ?? (resume && latest ? `logs/${latest}` : `logs/${new Date().toISOString().replace(/[:.]/g, "-")}`);

const tachka = new Tachka({ port: portForPlayer(player), onExchange: jsonlRecorder(`${dir}/exchanges.jsonl`) });
const journal = new Journal(`${dir}/journal.jsonl`);

let king: King;
if(kingKind === "scripted")
	king = new ScriptedKing();
else {
	const brain: Brain = kingKind === "api" ? new AnthropicBrain() : new ClaudeCliBrain(args.get("--model") ?? "sonnet");
	king = new LlmKing(brain, { onProblem: text => tachka.publish({ type: "problem", text }) });
	console.log(`king: ${brain.name}`);
}

const ui = startServer(tachka, uiPort);
if(resume)
	for(const e of journal.tail(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).slice(-25)) {
		const none = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
		tachka.publish({ type: "king", note: e.note, usage: none, total: none, ms: 0 });
		tachka.publish({ type: "turn", day: e.day, journal: e, line: `built ${e.built.map(b => b.building.replace("core:", "")).join(", ") || "nothing"}; recruited ${e.recruited.reduce((n, r) => n + r.count, 0)}; ${e.moves.map(m => m.intent).join("; ") || "no moves"}` });
	}
if(resume)
	console.log(`resuming ${dir}`);
console.log(`open http://127.0.0.1:${uiPort}  (player ${player}, port ${portForPlayer(player)}, logs in ${dir})`);

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());

try {
	await waitForBridge(tachka, portForPlayer(player), abort.signal);
	const state = await playGame({ tachka, king, journal, memoryDays: 7 }, { maxTurns, signal: abort.signal, statePath: `${dir}/state.json`, resume });
	console.log(`stopped after ${state.turn} turns`);
}
catch(e) {
	const text = e instanceof Error ? e.message : String(e);
	tachka.publish({ type: "problem", text: `the game loop stopped: ${text}` });
	console.error(text);
}
// keep the page up so the last events and any problem stay readable; Ctrl-C leaves
tachka.bridge.close();
if(!abort.signal.aborted)
	await new Promise(resolve => abort.signal.addEventListener("abort", resolve));
ui.close();
process.exit(0);
