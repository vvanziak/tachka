import { BridgeError } from "./bridge.js";
import { collectBlockers } from "./blockers.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parsePlan } from "./plan.js";
import { defaultPlan } from "./defaultPlan.js";
import { executePlan, type ExecutionReport } from "./executor.js";
import { collectFacts } from "./facts.js";
import type { Journal, JournalEntry } from "./journal.js";
import { parseDecision, type Brief, type King } from "./king.js";
import { collectSites, goTo, type MoveOutcome, type Pos, type Site } from "./missions.js";
import type { Plan } from "./plan.js";
import type { Resources } from "./state.js";
import type { Tachka } from "./core.js";
import type { AnswerContext, Question } from "./questions.js";
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the game has started and the bridge answers; the bridge only listens once the match begins. */
export async function waitForBridge(tachka: Tachka, port: number, signal?: AbortSignal): Promise<boolean> {
	let told = false;
	while(!signal?.aborted) {
		try {
			await tachka.bridge.call("ping", {}, 5_000);
			tachka.publish({ type: "status", text: "connected to the game" });
			return true;
		}
		catch(e) {
			if(!(e as NodeJS.ErrnoException).code && !(e instanceof Error && e.message.startsWith("no reply")))
				throw e;
			if(!told) {
				tachka.publish({ type: "status", text: `waiting for the game (nothing listens on port ${port} yet)` });
				told = true;
			}
			await sleep(2_000);
		}
	}
	return false;
}

/** Blocks until it is our turn; battles that need orders are fought by BattleAI meanwhile. */
export async function awaitTurn(tachka: Tachka, signal?: AbortSignal): Promise<boolean> {
	for(;;) {
		if(signal?.aborted)
			return false;
		const wait = await tachka.bridge.call<{ yourTurn: boolean; battle: boolean }>("wait_for_turn", { timeoutMs: 15_000 }, 60_000);
		if(wait.yourTurn)
			return true;
		if(wait.battle)
			await tachka.bridge.call("battle_act", { action: "autofight" });
	}
}

async function answerQuestions(deps: LoopDeps, questions: Question[], deviations: unknown[], context: AnswerContext = {}): Promise<boolean> {
	for(const question of questions) {
		const choice = deps.king.answer?.(question, context);
		if(choice === undefined) {
			deps.tachka.publish({ type: "problem", text: `a dialog the king cannot answer is open: ${JSON.stringify(question).slice(0, 300)}` });
			deviations.push({ kind: "unanswered_question", question });
			return false;
		}
		await deps.tachka.bridge.call("answer_question", { id: question.id, choice });
	}
	return true;
}

/** Answers dialogs until none is open: an answer can open the next one (a Tree of Knowledge level-up, for instance). */
async function settleQuestions(deps: LoopDeps, deviations: unknown[], context: AnswerContext = {}): Promise<boolean> {
	for(let round = 0; round < 8; round++) {
		const status = await deps.tachka.bridge.call<{ pendingQuestions?: Question[] }>("status");
		const open = status.pendingQuestions ?? [];
		if(open.length === 0)
			return true;
		if(!await answerQuestions(deps, open, deviations, context))
			return false;
	}
	deviations.push({ kind: "questions_keep_coming" });
	return true;
}

export function newLoopState(): LoopState {
	return { plan: undefined, previousEnd: undefined, deviations: [], turn: 0 };
}

/** What must outlive a restart besides the journal: the plan, the treasury at the end of our last turn, the turn counter. */
export function saveLoopState(path: string, state: LoopState): void {
	writeFileSync(path, JSON.stringify({ plan: state.plan, previousEnd: state.previousEnd, deviations: state.deviations, turn: state.turn }));
}

export function loadLoopState(path: string): LoopState {
	if(!existsSync(path))
		return newLoopState();
	const saved = JSON.parse(readFileSync(path, "utf8"));
	return { plan: saved.plan ? parsePlan(saved.plan) : undefined, previousEnd: saved.previousEnd, deviations: saved.deviations ?? [], turn: saved.turn ?? 0 };
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
	while(tachka.isPaused)
		await sleep(300);

	const carried: unknown[] = [];
	if(!await settleQuestions(deps, carried)) {
		state.deviations = carried;
		return false;
	}

	const facts = await collectFacts(bridge, state.previousEnd);
	const sites: Record<number, Site[]> = {};
	for(const hero of facts.heroes)
		sites[hero.id] = await collectSites(bridge, hero.id, 40);

	const brief: Brief = {
		facts, plan: state.plan, sites, blockers: collectBlockers(facts, mergeSites(sites)),
		journal: journal.tail(facts.day, deps.memoryDays), deviations: state.deviations, messages: tachka.drainInbox(),
	};
	tachka.publish({ type: "facts", facts: { day: facts.day, week: facts.week, dayOfWeek: facts.dayOfWeek, resources: facts.resources, income: facts.incomeSinceLastTurn, towns: facts.towns.map(t => ({ id: t.id, name: t.name, faction: t.faction, buildings: t.buildings, stock: t.recruitable })), heroes: facts.heroes, blockers: brief.blockers, plan: state.plan } });
	const decision = parseDecision(await king.decide(brief));
	const usage = king.usage?.();
	tachka.publish({ type: "king", note: decision.note, usage: usage?.last ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }, total: usage?.total ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }, ms: usage?.ms ?? 0 });
	if(decision.reply)
		tachka.publish({ type: "chat", from: "king", text: decision.reply });
	if(decision.plan)
		state.plan = decision.plan;
	else if(!state.plan) {
		state.plan = defaultPlan(facts);
		tachka.publish({ type: "problem", text: "the king sent no economy plan and none exists; the default chain is running until it sends one" });
	}

	const deviations: unknown[] = [];
	const rejected = async (action: string, run: () => Promise<unknown>) => {
		try { await run(); }
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "rejected", action, error: e.message });
		}
	};

	let economy: ExecutionReport | undefined;
	if(state.plan) {
		economy = await executePlan(bridge, state.plan, await collectFacts(bridge, state.previousEnd));
		deviations.push(...economy.deviations);
		state.previousEnd = economy.treasuryAfter;
	}

	const moves: JournalEntry["moves"] = [];
	for(const mission of decision.missions) {
		// a dialog (chest, level-up) interrupts the walk; after answering it the same mission resumes
		let outcome: MoveOutcome;
		try {
			outcome = await goTo(bridge, mission.hero, mission.target, { allowFight: mission.allowFight });
			const interrupted = (o: MoveOutcome) => o.pendingQuestions.length > 0 || o.stopped === "battle waiting for orders";
			for(let resume = 0; resume < 4 && interrupted(outcome); resume++) {
				// a fight that started during the walk is fought out now so the mission and the rest of the turn go on
				if(outcome.stopped === "battle waiting for orders")
					await bridge.call("battle_act", { action: "autofight" });
				if(!await settleQuestions(deps, deviations, { allowFight: mission.allowFight })) {
					state.deviations = deviations;
					return false;
				}
				// the hero already stands on the target (a visit that opened a dialog): walking there again would only repeat the visit
				const here = (await bridge.call<{ heroes?: Array<{ id: number; pos: Pos }> }>("get_state", { radius: 0 })).heroes?.find(h => h.id === mission.hero)?.pos;
				if(here && here.x === mission.target.x && here.y === mission.target.y && here.z === mission.target.z) {
					outcome = { ...outcome, reached: true, stopped: undefined, pendingQuestions: [] };
					break;
				}
				outcome = await goTo(bridge, mission.hero, mission.target, { allowFight: mission.allowFight });
			}
		}
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "rejected", action: `move hero ${mission.hero}`, error: e.message });
			continue;
		}
		moves.push({ hero: mission.hero, target: mission.target, intent: mission.intent, reached: outcome.reached || outcome.visited === true, stopped: outcome.stopped });
		if(outcome.stopped === "guarded")
			deviations.push({ kind: "guarded", hero: mission.hero, guard: outcome.guard, intent: mission.intent });
	}

	// after the walks: a town with a hero standing in it cannot hire, so heroes leave first
	for(const h of decision.hire)
		await rejected(`hire ${h.hero} in ${h.town}`, () => bridge.call("buy_hero", h));
	for(const m of decision.merge)
		await rejected(`merge ${m.from} into ${m.to}`, () => bridge.call("move_army", m));

	journal.append({
		day: facts.day, turn: state.turn, note: decision.note,
		built: economy?.built ?? [], recruited: economy?.recruited ?? [], moves, deviations,
	});
	state.deviations = deviations;
	const entry = journal.tail(facts.day, 1).at(-1);
	tachka.publish({
		type: "turn", day: facts.day, journal: entry,
		line: `built ${economy?.built.map(b => b.building.replace("core:", "")).join(", ") || "nothing"}; recruited ${economy?.recruited.reduce((n, r) => n + r.count, 0) ?? 0}; ${moves.map(m => `${m.intent}${m.reached ? " (done)" : m.stopped ? ` (${m.stopped})` : ""}`).join("; ") || "no moves"}`,
	});
	if(!await settleQuestions(deps, deviations)) {
		state.deviations = deviations;
		return false;
	}
	await nextTurn(bridge);
	return true;
}

/** Plays until the turn limit, an unanswerable question, or the signal aborts. */
export async function playGame(deps: LoopDeps, options: { maxTurns?: number; signal?: AbortSignal; statePath?: string; resume?: boolean } = {}): Promise<LoopState> {
	const state = options.statePath && options.resume ? loadLoopState(options.statePath) : newLoopState();
	const first = state.turn;
	while(state.turn - first < (options.maxTurns ?? Infinity)) {
		if(!await awaitTurn(deps.tachka, options.signal))
			break;
		const more = await playTurn(deps, state);
		if(options.statePath)
			saveLoopState(options.statePath, state);
		if(!more)
			break;
	}
	return state;
}
