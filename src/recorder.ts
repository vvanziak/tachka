import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Exchange } from "./bridge.js";

/** Appends every bridge exchange as one JSON line, so a game can be inspected or replayed offline. */
export function jsonlRecorder(path: string): (exchange: Exchange) => void {
	mkdirSync(dirname(path), { recursive: true });
	return exchange => appendFileSync(path, JSON.stringify(exchange) + "\n");
}
