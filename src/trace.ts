import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain, BrainReply } from "./brain.js";
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
	private requests = 0;
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
		this.requests = 0;
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

	/** One model request exactly as sent (system prompt, schema, user text) and what came back. */
	request(label: string, sent: { system: string; user: string; schema?: object }, received: { reply?: unknown; usage?: unknown; ms: number; error?: string }): void {
		const base = this.day === undefined || label === "talker" ? `${label}-${Date.now()}` : `${String(this.day).padStart(3, "0")}.${TRACE_STEPS.decision}.${++this.requests}-${label}`;
		const text = [`# ${label} request (${sent.system.length} + ${sent.user.length} characters)`, "## SYSTEM PROMPT", sent.system, ...(sent.schema ? ["## RESPONSE SCHEMA", JSON.stringify(sent.schema)] : []), "## USER MESSAGE", sent.user].join("\n\n");
		writeFileSync(join(this.dir, `${base}-request.md`), text);
		writeFileSync(join(this.dir, `${base}-response.json`), JSON.stringify(received, null, 1));
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

/** Wraps a brain and writes every request and answer to the trace. */
export class TracedBrain implements Brain {
	readonly name: string;

	constructor(private readonly inner: Brain, private readonly trace: Trace, private readonly label: string) {
		this.name = inner.name;
	}

	async complete(system: string, user: string, schema: object): Promise<BrainReply> {
		const started = Date.now();
		try {
			const reply = await this.inner.complete(system, user, schema);
			this.trace.request(this.label, { system, user, schema }, { reply: reply.json, usage: reply.usage, ms: Date.now() - started });
			return reply;
		}
		catch(e) {
			this.trace.request(this.label, { system, user, schema }, { error: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
			throw e;
		}
	}

	async say(system: string, user: string): Promise<{ text: string; usage: BrainReply["usage"] }> {
		const started = Date.now();
		try {
			const reply = await this.inner.say(system, user);
			this.trace.request(this.label, { system, user }, { reply: reply.text, usage: reply.usage, ms: Date.now() - started });
			return reply;
		}
		catch(e) {
			this.trace.request(this.label, { system, user }, { error: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
			throw e;
		}
	}
}
