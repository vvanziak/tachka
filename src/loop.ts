import { BridgeError } from "./bridge.js";
import { collectBlockers } from "./blockers.js";
import { executePlan, type ExecutionReport } from "./executor.js";
import { collectFacts } from "./facts.js";
import type { Journal, JournalEntry } from "./journal.js";
import { parseDecision, type Brief, type King } from "./king.js";
import { collectSites, goTo, type Site } from "./missions.js";
import type { Plan } from "./plan.js";
import type { Resources } from "./state.js";
import type { Tachka } from "./core.js";
import { nextTurn } from "./turn.js";

export interface LoopState {
	plan: Plan | undefined;
	previousEnd: Resources | undefined;
	deviations: unknown[];
	turn: number;
}

export interface LoopDeps {
	tachka: Tachka;
	king: King;
	journal: Journal;
	/** Days of journal shown to the king. */
	memoryDays: number;
}

export function newLoopState(): LoopState {
	return { plan: undefined, previousEnd: undefined, deviations: [], turn: 0 };
}

function mergeSites(perHero: Record<number, Site[]>): Site[] {
	const best = new Map<number, Site>();
	for(const sites of Object.values(perHero))
		for(const site of sites) {
			const known = best.get(site.id);
			if(!known || site.turns < known.turns || (site.turns === known.turns && site.steps < known.steps))
				best.set(site.id, site);
		}
	return [...best.values()];
}

/** One turn: gather facts, ask the king, carry the decision out, record it. Returns false when the loop must stop. */
export async function playTurn(deps: LoopDeps, state: LoopState): Promise<boolean> {
	const { tachka, king, journal } = deps;
	const bridge = tachka.bridge;
	state.turn++;

	const facts = await collectFacts(bridge, state.previousEnd);
	const sites: Record<number, Site[]> = {};
	for(const hero of facts.heroes)
		sites[hero.id] = await collectSites(bridge, hero.id, 40);

	const brief: Brief = {
		facts, plan: state.plan, sites, blockers: collectBlockers(facts, mergeSites(sites)),
		journal: journal.tail(facts.day, deps.memoryDays), deviations: state.deviations, messages: tachka.drainInbox(),
	};
	const decision = parseDecision(await king.decide(brief));
	if(decision.plan)
		state.plan = decision.plan;

	const deviations: unknown[] = [];
	const rejected = async (action: string, run: () => Promise<unknown>) => {
		try { await run(); }
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "rejected", action, error: e.message });
		}
	};
	for(const h of decision.hire)
		await rejected(`hire ${h.hero} in ${h.town}`, () => bridge.call("buy_hero", h));
	for(const m of decision.merge)
		await rejected(`merge ${m.from} into ${m.to}`, () => bridge.call("move_army", m));

	let economy: ExecutionReport | undefined;
	if(state.plan) {
		economy = await executePlan(bridge, state.plan, await collectFacts(bridge, state.previousEnd));
		deviations.push(...economy.deviations);
		state.previousEnd = economy.treasuryAfter;
	}

	const moves: JournalEntry["moves"] = [];
	for(const mission of decision.missions) {
		const outcome = await goTo(bridge, mission.hero, mission.target, { allowFight: mission.allowFight });
		moves.push({ hero: mission.hero, target: mission.target, intent: mission.intent, reached: outcome.reached || outcome.visited === true, stopped: outcome.stopped });
		if(outcome.stopped === "guarded")
			deviations.push({ kind: "guarded", hero: mission.hero, guard: outcome.guard, intent: mission.intent });
		for(const question of outcome.pendingQuestions as Array<{ id: number }>) {
			const choice = king.answer?.(question);
			if(choice === undefined) {
				deviations.push({ kind: "unanswered_question", question });
				state.deviations = deviations;
				return false;
			}
			await bridge.call("answer_question", { id: question.id, choice });
		}
	}

	journal.append({
		day: facts.day, turn: state.turn, note: decision.note,
		built: economy?.built ?? [], recruited: economy?.recruited ?? [], moves, deviations,
	});
	state.deviations = deviations;
	await nextTurn(bridge);
	return true;
}

export async function playGame(deps: LoopDeps, maxTurns: number, onTurn?: (state: LoopState) => void): Promise<LoopState> {
	const state = newLoopState();
	for(let i = 0; i < maxTurns; i++) {
		const more = await playTurn(deps, state);
		onTurn?.(state);
		if(!more)
			break;
	}
	return state;
}
