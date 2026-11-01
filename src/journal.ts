import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
	day: number;
	turn: number;
	/** What the king decided and why, in its own words. */
	note: string;
	built: Array<{ town: number; building: string }>;
	recruited: Array<{ town: number; creature: string; count: number }>;
	moves: Array<{ hero: number; target: { x: number; y: number; z: number }; intent: string; reached: boolean; stopped?: string }>;
	deviations: unknown[];
	/** What the king ordered besides the economy plan and the walks. */
	orders?: { hire: unknown[]; merge: unknown[]; trade?: unknown[] };
	/** What the checks found in the first decision and whether the king changed it. */
	review?: { findings: string[]; revised: boolean };
}

/** One JSON line per turn. The king sees only the last few days; the file keeps everything. */
export class Journal {
	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
	}

	append(entry: JournalEntry): void {
		appendFileSync(this.path, JSON.stringify(entry) + "\n");
	}

	/** Entries of the last `days` game days up to and including `day`. */
	tail(day: number, days: number): JournalEntry[] {
		if(!existsSync(this.path))
			return [];
		return readFileSync(this.path, "utf8").split("\n").filter(Boolean)
			.map(line => JSON.parse(line) as JournalEntry)
			.filter(e => e.day > day - days && e.day <= day);
	}
}
