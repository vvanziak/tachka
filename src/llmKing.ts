import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Brain } from "./brain.js";
import { renderBrief } from "./brief.js";
import { decisionSchema, parseDecision, type Brief, type Decision, type King } from "./king.js";
import type { KingUsage } from "./core.js";
import { defaultAnswer, type AnswerContext, type Question } from "./questions.js";

const SYSTEM = readFileSync(join(import.meta.dirname, "..", "prompts", "king.md"), "utf8");

export interface LlmKingOptions {
	onProblem?: (text: string) => void;
}

/** A king that asks a language model; falls back to "carry on" when the model fails, and says so. */
export class LlmKing implements King {
	readonly total: KingUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	private last: KingUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
	private ms = 0;
	// the CLI's validator does not know the draft 2020-12 meta-schema that zod names in `$schema`
	private readonly schema = (({ $schema, ...rest }) => rest)(z.toJSONSchema(decisionSchema) as Record<string, unknown>);

	constructor(private readonly brain: Brain, private readonly options: LlmKingOptions = {}) {}

	async decide(brief: Brief): Promise<Decision> {
		const prompt = renderBrief(brief);
		const started = Date.now();
		let lastError = "";
		for(let attempt = 0; attempt < 2; attempt++) {
			try {
				const reply = await this.brain.complete(SYSTEM, attempt === 0 ? prompt : `${prompt}\n\nYour previous answer was rejected: ${lastError}\nAnswer again with a valid object.`, this.schema);
				this.total.inputTokens += reply.usage.inputTokens;
				this.total.outputTokens += reply.usage.outputTokens;
				this.total.costUsd += reply.usage.costUsd;
				const decision = parseDecision(reply.json);
				this.last = reply.usage;
				this.ms = Date.now() - started;
				return decision;
			}
			catch(e) {
				lastError = e instanceof Error ? e.message : String(e);
				this.options.onProblem?.(`king attempt ${attempt + 1} failed: ${lastError}`);
			}
		}
		return { note: `The king could not decide (${lastError.slice(0, 200)}); the current plan keeps running and heroes stand still.`, missions: [], hire: [], merge: [] };
	}

	answer(question: Question, context?: AnswerContext): number | undefined {
		return defaultAnswer(question, context);
	}

	usage() {
		return { last: this.last, total: { ...this.total }, ms: this.ms };
	}
}
