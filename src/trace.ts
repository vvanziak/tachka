import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exchange } from "./bridge.js";

/** The steps of a turn in the order they happen; the number is part of the file name. */
export const TRACE_STEPS = { dialogs: 1, facts: 2, brief: 3, decision: 4, review: 5, orders: 6, record: 7, end: 8 } as const;
export type TraceStep = keyof typeof TRACE_STEPS;

const MAX_RESULT_CHARS = 1500;

/**
 * Debug trace: one file per step of every turn, named `<day>.<step>-<name>` (the day is zero-padded so the files sort),
 * each holding what the step produced and the game commands it sent.
 */
export class Trace {
	private day: number | undefined;
	private calls: Array<Record<string, unknown>> = [];
	private pending: Array<{ step: TraceStep; data: unknown }> = [];

	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	/** Fed with every bridge exchange; the ones since the last step go into the next step's file. */
	exchange(x: Exchange): void {
		const status = x.result as { yourTurn?: boolean; battle?: boolean; gameOver?: boolean } | undefined;
		if(x.cmd === "wait_for_turn" && x.ok && !status?.yourTurn && !status?.battle && !status?.gameOver)
			return;
		const text = x.ok ? JSON.stringify(x.result) : "";
		this.calls.push({ cmd: x.cmd, args: x.args, ms: x.ms, ...(x.ok ? { result: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)} ...(${text.length} chars)` : x.result } : { error: x.error }) });
	}

	/** Steps that happen before the day is known (settling dialogs) wait here and are written by `begin`. */
	begin(day: number): void {
		this.day = day;
		for(const p of this.pending)
			this.write(p.step, p.data);
		this.pending = [];
	}

	step(step: TraceStep, data: unknown): void {
		if(this.day === undefined) {
			this.pending.push({ step, data: { data, calls: this.take() } });
			return;
		}
		this.write(step, { data, calls: this.take() });
	}

	/** Called when a turn is over, so the next one starts without a day. */
	finish(): void {
		this.day = undefined;
	}

	private take(): Array<Record<string, unknown>> {
		const calls = this.calls;
		this.calls = [];
		return calls;
	}

	private write(step: TraceStep, content: unknown): void {
		const name = `${String(this.day).padStart(3, "0")}.${TRACE_STEPS[step]}-${step}`;
		const wrapped = content as { data: unknown; calls: unknown[] };
		if(typeof wrapped.data === "string") {
			const calls = wrapped.calls.length ? `\n\n---\n\nGame commands sent in this step:\n\n${JSON.stringify(wrapped.calls, null, 1)}\n` : "";
			writeFileSync(join(this.dir, `${name}.md`), wrapped.data + calls);
		}
		else
			writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(content, null, 1));
	}
}
