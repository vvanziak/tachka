import readline from "node:readline";
import { Tachka } from "./core.js";
import { jsonlRecorder } from "./recorder.js";
import { PLAYER_COLORS, portForPlayer, type PlayerColor } from "./protocol.js";

const MAX_PRINT = 4000;

function parseArgs(argv: string[]): { port: number; record: string | undefined } {
	let port = portForPlayer("red");
	let record: string | undefined;
	for(let i = 0; i < argv.length; i++) {
		const [flag, value] = [argv[i], argv[i + 1]];
		if(flag === "--player" && value) {
			if(!PLAYER_COLORS.includes(value as PlayerColor))
				throw new Error(`--player must be one of ${PLAYER_COLORS.join(", ")}`);
			port = portForPlayer(value as PlayerColor);
			i++;
		}
		else if(flag === "--port" && value) {
			port = Number(value);
			i++;
		}
		else if(flag === "--record" && value) {
			record = value;
			i++;
		}
		else
			throw new Error(`unknown argument ${flag}; usage: --player <color> | --port <n> [--record <file.jsonl>]`);
	}
	return { port, record };
}

function show(value: unknown): string {
	const text = JSON.stringify(value, null, 1);
	return text.length > MAX_PRINT ? text.slice(0, MAX_PRINT) + `\n... (${text.length - MAX_PRINT} more characters)` : text;
}

const { port, record } = parseArgs(process.argv.slice(2));
const tachka = new Tachka({ port, onExchange: record ? jsonlRecorder(record) : undefined });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

tachka.subscribe(event => {
	if(event.type === "chat" && event.from === "tachka")
		console.log(`tachka> ${event.text}`);
	else if(event.type === "paused" || event.type === "resumed")
		console.log(`[${event.type}]`);
});

console.log(`Tachka console on port ${port}. Plain text talks to Tachka. /call <cmd> [json], /pause, /resume, /quit`);
rl.prompt();

rl.on("line", async line => {
	const text = line.trim();
	try {
		if(text === "/quit")
			return rl.close();
		else if(text === "/pause")
			tachka.pause();
		else if(text === "/resume")
			tachka.resume();
		else if(text.startsWith("/call ")) {
			const [cmd, ...rest] = text.slice(6).trim().split(/\s+/);
			const args = rest.length ? JSON.parse(rest.join(" ")) : {};
			console.log(show(await tachka.bridge.call(cmd ?? "", args)));
		}
		else if(text)
			tachka.say(text);
	}
	catch(e) {
		console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
	}
	rl.prompt();
});

rl.on("close", () => {
	tachka.bridge.close();
	process.exit(0);
});
