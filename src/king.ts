import { z } from "zod";
import { defaultPlan } from "./defaultPlan.js";
import type { Blocker } from "./blockers.js";
import type { EconomyFacts } from "./facts.js";
import type { JournalEntry } from "./journal.js";
import type { Pos, Site } from "./missions.js";
import { planSchema, type Plan } from "./plan.js";
import type { Finding } from "./review.js";
import { defaultAnswer, type AnswerContext, type Question } from "./questions.js";
import type { KingUsage } from "./core.js";

const pos = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export const memorySchema = z.object({
	/** What wins this game against these opponents, in one sentence. */
	goal: z.string().max(400),
	/** The next few moves and what each depends on. */
	next: z.string().max(600),
	/** Valuable things that cannot be taken now, each with what unlocks it. */
	deferred: z.array(z.object({ what: z.string().max(140), unlock: z.string().max(180) }).strict()).max(12).default([]),
	/** The opponent, the risks, what to watch. */
	watch: z.string().max(500).optional(),
}).strict();

export type Memory = z.infer<typeof memorySchema>;

export const QUERY_COMMANDS = ["inspect", "lookup", "find_path", "tile_info", "get_buildable", "artifacts", "targets"] as const;

/** A read-only question the king may put to the game before it decides; the fields each command uses are in the prompt. */
export const querySchema = z.object({
	cmd: z.enum(QUERY_COMMANDS),
	id: z.number().int().optional(),
	hero: z.number().int().optional(),
	town: z.number().int().optional(),
	x: z.number().int().optional(),
	y: z.number().int().optional(),
	z: z.number().int().optional(),
	radius: z.number().int().optional(),
	kind: z.string().optional(),
	name: z.string().optional(),
}).strict();

export type Query = z.infer<typeof querySchema>;

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
	/** Heroes that stay where they are this turn; every other hero uses up its movement. */
	hold: z.array(z.number().int()).default([]),
	/** Rewrites the strategy memory that is shown to you at the top of every brief. */
	memory: memorySchema.optional(),
}).strict();

/** What a model answers: questions for the game first, the decision once it has what it needs. */
export const replySchema = z.object({
	ask: z.array(querySchema).max(4).default([]),
	decision: decisionSchema.optional(),
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
	/** The strategy memory the king wrote earlier. */
	memory: Memory | undefined;
}

export interface King {
	decide(brief: Brief): Promise<Decision>;
	/** Choice for a dialog; undefined stops the game loop. */
	answer?(question: Question, context?: AnswerContext): number | undefined;
	/** One more look at a decision after the checks in review.ts found problems; returns the decision to carry out. */
	revise?(brief: Brief, decision: Decision, findings: Finding[]): Promise<Decision>;
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
			const sites = (brief.sites[hero.id] ?? []).filter(s => !s.threat && !s.visitedByHero && !s.visitedByUs && !taken.has(s.id) && !visited.has(`${s.pos.x},${s.pos.y},${s.pos.z}`));
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
			missions, hire: [], merge: [], hold: [],
		};
	}

	answer(question: Question, context?: AnswerContext): number | undefined {
		return defaultAnswer(question, context);
	}
}
