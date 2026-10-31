import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { AnthropicBrain, ClaudeCliBrain, type Brain } from "./brain.js";
import type { Exchange } from "./bridge.js";
import { Tachka } from "./core.js";
import { collectFinale } from "./finale.js";
import { Journal } from "./journal.js";
import { ScriptedKing, type King } from "./king.js";
import { LlmKing } from "./llmKing.js";
import { playGame, waitForBridge } from "./loop.js";
import { PLAYER_COLORS, portForPlayer, type PlayerColor } from "./protocol.js";
import { jsonlRecorder } from "./recorder.js";
import { startServer } from "./server.js";
import { Situation } from "./situation.js";
import { Talker } from "./talker.js";

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
const forceResume = process.argv.includes("--resume");
const forceNew = process.argv.includes("--new");

/** The game folder: the latest one when it holds the same unfinished game (not won or lost, its last day not after today's), a new one otherwise. A closed client does not end a game: it is the usual restart. */
function chooseDir(day: number): { dir: string; resume: boolean } {
	if(args.has("--out"))
		return { dir: args.get("--out") as string, resume: forceResume };
	const latest = existsSync("logs") ? readdirSync("logs").filter(d => existsSync(`logs/${d}/journal.jsonl`)).sort().at(-1) : undefined;
	if(latest && !forceNew) {
		const dir = `logs/${latest}`;
		const saved = existsSync(`${dir}/state.json`) ? JSON.parse(readFileSync(`${dir}/state.json`, "utf8")) : undefined;
		const lastLine = readFileSync(`${dir}/journal.jsonl`, "utf8").trim().split("\n").at(-1);
		const lastDay = lastLine ? JSON.parse(lastLine).day as number : 0;
		if(forceResume || (saved && saved.ended !== "game over" && lastDay <= day))
			return { dir, resume: true };
	}
	return { dir: `logs/${new Date().toISOString().replace(/[:.]/g, "-")}`, resume: false };
}

// exchanges are held until the game folder is known, and that needs the game's day
const early: Exchange[] = [];
let record: (exchange: Exchange) => void = x => { early.push(x); };
const tachka = new Tachka({ port: portForPlayer(player), onExchange: x => record(x) });
const ui = startServer(tachka, uiPort);
console.log(`open http://127.0.0.1:${uiPort}  (player ${player}, port ${portForPlayer(player)})`);

const abort = new AbortController();
// state is saved after every turn, so leaving mid-call is safe: ask the loop to stop, then exit anyway
for(const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		if(abort.signal.aborted)
			process.exit(1);
		console.log("\nstopping (press Ctrl-C again to leave at once)");
		abort.abort();
		setTimeout(() => process.exit(0), 1500).unref();
	});

try {
	if(await waitForBridge(tachka, portForPlayer(player), abort.signal)) {
		const today = await tachka.bridge.call<{ day: number }>("get_state", { radius: 0 }).then(s => s.day);
		const { dir, resume } = chooseDir(today);
		console.log(resume ? `continuing the game in ${dir}` : `new game, logs in ${dir}`);
		const write = jsonlRecorder(`${dir}/exchanges.jsonl`);
		early.forEach(write);
		record = write;

		const journal = new Journal(`${dir}/journal.jsonl`);
		let king: King;
		if(kingKind === "scripted")
			king = new ScriptedKing();
		else {
			const brain: Brain = kingKind === "api" ? new AnthropicBrain() : new ClaudeCliBrain(args.get("--model") ?? "sonnet");
			king = new LlmKing(brain, {
				onProblem: text => tachka.publish({ type: "problem", text }),
				query: (cmd, args) => tachka.bridge.call(cmd, args),
				onQuery: text => tachka.publish({ type: "query", text }),
			});
			console.log(`king: ${brain.name}`);
		}

		// the talker answers at any moment; it uses the king's model, or the claude CLI when the king is a script
		const talkBrain: Brain = kingKind === "api" ? new AnthropicBrain() : new ClaudeCliBrain(args.get("--chat-model") ?? "sonnet");
		const situation = new Situation(tachka, journal);
		new Talker(tachka, talkBrain, () => situation.describe(), `${dir}/chat.jsonl`);

		if(resume)
			for(const e of journal.tail(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).slice(-25)) {
				const none = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
				tachka.publish({ type: "king", note: e.note, usage: none, total: none, ms: 0 });
				tachka.publish({ type: "turn", day: e.day, journal: e, line: `built ${e.built.map(b => b.building.replace("core:", "")).join(", ") || "nothing"}; recruited ${e.recruited.reduce((n, r) => n + r.count, 0)}; ${e.moves.map(m => m.intent).join("; ") || "no moves"}` });
			}

		const state = await playGame({ tachka, king, journal, memoryDays: 7 }, { maxTurns, signal: abort.signal, statePath: `${dir}/state.json`, resume });
		console.log(`stopped after ${state.turn} turns${state.ended ? ` (${state.ended})` : ""}`);
		if(state.ended === "game over" || state.ended === "connection lost") {
			tachka.publish({ type: "status", text: state.ended === "game over" ? "the game is over" : "the game was closed" });
			const gameOver = await tachka.bridge.call<{ gameOver?: unknown }>("status", {}, 5_000).then(r => r.gameOver).catch(() => undefined);
			const final = { ...await collectFinale(tachka.bridge, gameOver).catch(() => ({ gameOver })), lastKnownFacts: situation.lastFacts };
			writeFileSync(`${dir}/final.json`, JSON.stringify(final, null, 1));
			tachka.publish({ type: "final", final });
			tachka.publish({ type: "chat", from: "king", text: state.ended === "game over" ? "The game is over. I'm still here: ask me anything about it." : "The game was closed. I'm still here, but I can only talk about what I remember from it." });
		}
	}
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
