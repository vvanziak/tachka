import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Exchange } from "./bridge.js";

/** Appends every bridge exchange as one JSON line, so a game can be inspected or replayed offline. */
export function jsonlRecorder(path: string): (exchange: Exchange) => void {
	mkdirSync(dirname(path), { recursive: true });
	return exchange => {
		// 15-second waits for somebody else's turn would fill the file for no use
		const result = exchange.result as { yourTurn?: boolean; battle?: boolean; gameOver?: boolean } | undefined;
		if(exchange.cmd === "wait_for_turn" && exchange.ok && !result?.yourTurn && !result?.battle && !result?.gameOver)
			return;
		appendFileSync(path, JSON.stringify(exchange) + "\n");
	};
}
