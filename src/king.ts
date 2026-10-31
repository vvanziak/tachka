import { z } from "zod";
import { defaultPlan } from "./defaultPlan.js";
import type { Blocker } from "./blockers.js";
import type { EconomyFacts } from "./facts.js";
import type { JournalEntry } from "./journal.js";
import type { Pos, Site } from "./missions.js";
import { planSchema, type Plan } from "./plan.js";
import { defaultAnswer, type AnswerContext, type Question } from "./questions.js";
import type { KingUsage } from "./core.js";

const pos = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export const decisionSchema = z.object({
	/** The king's reasoning in its own words; goes to the journal. */
	note: z.string(),
	/** Message to the human, shown in the chat. */
	reply: z.string().optional(),
	/** Replaces the economy plan when present. */
	plan: planSchema.optional(),
	missions: z.array(z.object({ hero: z.number().int(), target: pos, intent: z.string(), allowFight: z.boolean().optional() }).strict()).default([]),
	/** `why` is the job the hero will do that nobody else can; it goes to the journal. */
	hire: z.array(z.object({ town: z.number().int(), hero: z.number().int(), why: z.string().min(15) }).strict()).default([]),
	merge: z.array(z.object({ from: z.number().int(), to: z.number().int() }).strict()).default([]),
}).strict();

export type Decision = z.infer<typeof decisionSchema>;

export function parseDecision(json: unknown): Decision {
	const result = decisionSchema.safeParse(json);
	if(!result.success)
		throw new Error("invalid decision: " + result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
	return result.data;
}

/** Everything the king sees when it decides. */
export interface Brief {
	facts: EconomyFacts;
	plan: Plan | undefined;
	/** Reachable sites per hero id. */
	sites: Record<number, Site[]>;
	blockers: Blocker[];
	journal: JournalEntry[];
	deviations: unknown[];
	messages: string[];
	/** What the game reported since the last brief. */
	events: string[];
}

export interface King {
	decide(brief: Brief): Promise<Decision>;
	/** Choice for a dialog; undefined stops the game loop. */
	answer?(question: Question, context?: AnswerContext): number | undefined;
	/** Cost of the last decision and the running total, for kings that call a model. */
	usage?(): { last: KingUsage; total: KingUsage; ms: number };
}

/** Test double for the loop, not a player: default economy plan, heroes go to the nearest unguarded supplier or site. */
export class ScriptedKing implements King {
	async decide(brief: Brief): Promise<Decision> {
		const { facts, plan, blockers } = brief;
		const stale = !plan || facts.day > plan.reviewByDay;
		const missions: Decision["missions"] = [];
		const taken = new Set<number>();
		const visited = new Set(brief.journal.flatMap(e => e.moves.filter(m => m.reached).map(m => `${m.target.x},${m.target.y},${m.target.z}`)));

		for(const hero of facts.heroes) {
			if(hero.movement <= 0)
				continue;
			const sites = (brief.sites[hero.id] ?? []).filter(s => !s.threat && !taken.has(s.id) && !visited.has(`${s.pos.x},${s.pos.y},${s.pos.z}`));
			const supplier = blockers.flatMap(b => b.suppliers).find(s => sites.some(x => x.id === s.site.id));
			const target: { site: Site; why: string } | undefined = supplier
				? { site: supplier.site, why: `${supplier.resource} for a blocked building` }
				: sites[0] && { site: sites[0], why: "explore the nearest site" };
			if(!target)
				continue;
			taken.add(target.site.id);
			missions.push({ hero: hero.id, target: target.site.pos as Pos, intent: `${target.site.name}: ${target.why}` });
		}

		return {
			note: stale ? "default economy plan; heroes visit supply sites first, then the nearest site" : "keep the plan; heroes continue",
			plan: stale ? defaultPlan(facts) : undefined,
			missions, hire: [], merge: [],
		};
	}

	answer(question: Question, context?: AnswerContext): number | undefined {
		return defaultAnswer(question, context);
	}
}
