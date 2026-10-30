import { ClaudeCliBrain, AnthropicBrain, type Brain } from "./brain.js";
import { Tachka } from "./core.js";
import { Journal } from "./journal.js";
import { ScriptedKing, type King } from "./king.js";
import { LlmKing } from "./llmKing.js";
import { playGame } from "./loop.js";
import { PLAYER_COLORS, portForPlayer, type PlayerColor } from "./protocol.js";
import { jsonlRecorder } from "./recorder.js";
import { startServer } from "./server.js";

const args = new Map<string, string>();
for(let i = 2; i < process.argv.length; i += 2)
	args.set(process.argv[i] ?? "", process.argv[i + 1] ?? "");

const player = (args.get("--player") ?? "red") as PlayerColor;
if(!PLAYER_COLORS.includes(player))
	throw new Error(`--player must be one of ${PLAYER_COLORS.join(", ")}`);
const kingKind = args.get("--king") ?? (process.env.ANTHROPIC_API_KEY ? "api" : "cli");
const maxTurns = args.has("--turns") ? Number(args.get("--turns")) : undefined;
const uiPort = Number(args.get("--ui") ?? "8787");
const dir = args.get("--out") ?? `logs/${new Date().toISOString().replace(/[:.]/g, "-")}`;

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
console.log(`open http://127.0.0.1:${uiPort}  (player ${player}, port ${portForPlayer(player)}, logs in ${dir})`);

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());

try {
	const state = await playGame({ tachka, king, journal, memoryDays: 7 }, { maxTurns, signal: abort.signal });
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
