import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Brain } from "./brain.js";
import { renderBrief } from "./brief.js";
import type { KingUsage } from "./core.js";
import { parseDecision, replySchema, type Brief, type Decision, type King, type Query } from "./king.js";
import type { Finding } from "./review.js";
import { defaultAnswer, type AnswerContext, type Question } from "./questions.js";

const SYSTEM = readFileSync(join(import.meta.dirname, "..", "prompts", "king.md"), "utf8");
const MAX_ASK_ROUNDS = 3;
const MAX_ANSWER_CHARS = 2500;

export interface LlmKingOptions {
	onProblem?: (text: string) => void;
	/** Runs a read-only game command for a question of the king. */
	query?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
	/** Called with a one-line description of each question asked. */
	onQuery?: (text: string) => void;
}

/** Turns a question into the bridge command and its arguments; only the fields the command takes are sent. */
export function queryArgs(q: Query): { cmd: string; args: Record<string, unknown> } {
	const pick = (...keys: Array<keyof Query>) => Object.fromEntries(keys.filter(k => q[k] !== undefined).map(k => [k, q[k]]));
	switch(q.cmd) {
	case "inspect": return { cmd: q.cmd, args: pick("id", "hero") };
	case "lookup": return { cmd: q.cmd, args: pick("kind", "name") };
	case "find_path": return { cmd: q.cmd, args: pick("hero", "x", "y", "z") };
	case "tile_info": return { cmd: q.cmd, args: pick("x", "y", "z", "radius") };
	case "get_buildable": return { cmd: q.cmd, args: { ...pick("town"), all: true } };
	case "artifacts": return { cmd: q.cmd, args: pick("hero") };
	case "targets": return { cmd: q.cmd, args: { ...pick("hero"), limit: 30 } };
	}
}

/** A king that asks a language model; falls back to "carry on" when the model fails, and says so. */
export class LlmKing implements King {
	readonly total: KingUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	private last: KingUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	private ms = 0;
	// the CLI's validator does not know the draft 2020-12 meta-schema that zod names in `$schema`
	private readonly schema = (({ $schema, ...rest }) => rest)(z.toJSONSchema(replySchema) as Record<string, unknown>);

	constructor(private readonly brain: Brain, private readonly options: LlmKingOptions = {}) {}

	async decide(brief: Brief): Promise<Decision> {
		const prompt = renderBrief(brief);
		const started = Date.now();
		this.last = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
		let answers = "";
		let lastError = "";
		let asked = 0;
		for(let attempt = 0; attempt < MAX_ASK_ROUNDS + 2; attempt++) {
			try {
				const last = asked >= MAX_ASK_ROUNDS;
				const user = `${prompt}${answers}${last ? "\n\nYou have no more questions left: decide now." : ""}${lastError ? `\n\nYour previous answer was rejected: ${lastError}\nAnswer again with a valid object.` : ""}`;
				const reply = await this.brain.complete(SYSTEM, user, this.schema);
				for(const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
					this.last[key] += reply.usage[key];
					this.total[key] += reply.usage[key];
				}
				const parsed = replySchema.parse(reply.json);
				lastError = "";
				if(parsed.ask.length > 0 && !last && this.options.query) {
					asked++;
					answers += await this.answerQueries(parsed.ask, asked);
					continue;
				}
				if(!parsed.decision)
					throw new Error("neither questions nor a decision were given");
				this.ms = Date.now() - started;
				return parseDecision(parsed.decision);
			}
			catch(e) {
				lastError = e instanceof Error ? e.message : String(e);
				this.options.onProblem?.(`king attempt ${attempt + 1} failed: ${lastError}`);
			}
		}
		this.ms = Date.now() - started;
		return { note: `The king could not decide (${lastError.slice(0, 200)}); the current plan keeps running and heroes stand still.`, missions: [], hire: [], merge: [] };
	}

	async revise(brief: Brief, decision: Decision, findings: Finding[]): Promise<Decision> {
		const prompt = `${renderBrief(brief)}\n\nYOUR DECISION SO FAR\n${JSON.stringify(decision)}\n\nCHECKS FOUND THESE PROBLEMS WITH IT\n${findings.map(f => `- ${f.text}`).join("\n")}\n\nFix what is real. If a finding does not apply, keep the decision and say in \`note\` why. Leave \`ask\` empty and answer with the full decision.`;
		try {
			const reply = await this.brain.complete(SYSTEM, prompt, this.schema);
			for(const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
				this.last[key] += reply.usage[key];
				this.total[key] += reply.usage[key];
			}
			const parsed = replySchema.parse(reply.json);
			return parsed.decision ? parseDecision(parsed.decision) : decision;
		}
		catch(e) {
			this.options.onProblem?.(`the king could not revise its decision, keeping it: ${e instanceof Error ? e.message : String(e)}`);
			return decision;
		}
	}

	private async answerQueries(queries: Query[], round: number): Promise<string> {
		let text = `\n\nANSWERS TO YOUR QUESTIONS (round ${round})`;
		for(const q of queries) {
			const { cmd, args } = queryArgs(q);
			this.options.onQuery?.(`${cmd} ${JSON.stringify(args)}`);
			let answer: string;
			try {
				answer = JSON.stringify(await this.options.query?.(cmd, args));
			}
			catch(e) {
				answer = `error: ${e instanceof Error ? e.message : String(e)}`;
			}
			text += `\n- ${cmd} ${JSON.stringify(args)} -> ${answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) + " ...(cut)" : answer}`;
		}
		return text;
	}

	answer(question: Question, context?: AnswerContext): number | undefined {
		return defaultAnswer(question, context);
	}

	usage() {
		return { last: { ...this.last }, total: { ...this.total }, ms: this.ms };
	}
}
