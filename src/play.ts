import { Tachka } from "./core.js";
import { Journal } from "./journal.js";
import { ScriptedKing } from "./king.js";
import { playGame } from "./loop.js";
import { PLAYER_COLORS, portForPlayer, type PlayerColor } from "./protocol.js";
import { jsonlRecorder } from "./recorder.js";

const args = new Map<string, string>();
for(let i = 2; i < process.argv.length; i += 2)
	args.set(process.argv[i] ?? "", process.argv[i + 1] ?? "");

const player = (args.get("--player") ?? "red") as PlayerColor;
if(!PLAYER_COLORS.includes(player))
	throw new Error(`--player must be one of ${PLAYER_COLORS.join(", ")}`);
const turns = Number(args.get("--turns") ?? "10");
const dir = args.get("--out") ?? `logs/${new Date().toISOString().replace(/[:.]/g, "-")}`;

const tachka = new Tachka({ port: portForPlayer(player), onExchange: jsonlRecorder(`${dir}/exchanges.jsonl`) });
const journal = new Journal(`${dir}/journal.jsonl`);

const state = await playGame({ tachka, king: new ScriptedKing(), journal, memoryDays: 7 }, turns, s => {
	const last = journal.tail(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).at(-1);
	if(last)
		console.log(`day ${last.day}: built ${last.built.map(b => b.building).join(",") || "-"}; recruited ${last.recruited.length}; moves ${last.moves.map(m => `${m.intent}${m.reached ? " (reached)" : m.stopped ? ` (${m.stopped})` : ""}`).join("; ") || "-"}; deviations ${last.deviations.length}`);
	void s;
});
console.log(`done after ${state.turn} turns; logs in ${dir}`);
tachka.bridge.close();
