import { BridgeError } from "./bridge.js";
import { collectBlockers } from "./blockers.js";
import { reviewDecision } from "./review.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parsePlan } from "./plan.js";
import { defaultPlan } from "./defaultPlan.js";
import { Trace } from "./trace.js";
import { renderBrief } from "./brief.js";
import { executePlan, reservedTotal, type ExecutionReport } from "./executor.js";
import { collectFacts, type EconomyFacts } from "./facts.js";
import type { Journal, JournalEntry } from "./journal.js";
import { parseDecision, type Decision, type Brief, type King, type Memory, type Scenario } from "./king.js";
import { collectSites, goTo, isSafeToWalk, type MoveOutcome, type Pos, type Site } from "./missions.js";
import type { Plan } from "./plan.js";
import { RESOURCES, type Hero, type Recruitable, type Resources } from "./state.js";
import type { Tachka } from "./core.js";
import type { AnswerContext, Question } from "./questions.js";
import { nextTurn } from "./turn.js";

export interface LoopState {
	plan: Plan | undefined;
	previousEnd: Resources | undefined;
	deviations: unknown[];
	turn: number;
	/** The king's strategy memory, rewritten by its decisions. */
	memory?: Memory;
	/** The scenario information, asked once. */
	scenario?: Scenario;
	/** Our heroes as of the last turn, to notice one that vanished between turns. */
	heroesSeen?: HeroSeen[];
	/** Why the loop stopped: "game over", "connection lost", "failed turns", or undefined while running or when aborted. */
	ended?: string;
}

export interface HeroSeen {
	id: number;
	name: string;
	level: number;
	units: number;
	pos: Pos;
}

const NEAR_LOST_HERO_TILES = 14;

/** Heroes that were ours at the last turn and are gone now: the king must be told, a death in the opponents' turn leaves no other trace. */
export function lostHeroNotices(before: HeroSeen[] | undefined, facts: EconomyFacts): string[] {
	const now = new Set(facts.heroes.map(h => h.id));
	return (before ?? []).filter(h => !now.has(h.id)).map(h => {
		const near = facts.threats
			.filter(t => t.type === "hero" && t.ownerColor !== "neutral" && t.pos && Math.max(Math.abs((t.pos as Pos).x - h.pos.x), Math.abs((t.pos as Pos).y - h.pos.y)) <= NEAR_LOST_HERO_TILES)
			.map(t => `${String(t.name)} (${String(t.ownerColor)}) at ${(t.pos as Pos).x},${(t.pos as Pos).y}`);
		return `YOUR HERO ${h.name} (level ${h.level}, ${h.units} units, last seen at ${h.pos.x},${h.pos.y}) IS GONE since your last turn: it died or was captured, most likely attacked by an enemy hero during the opponents' turn. ${near.length ? `Enemy heroes visible near there now: ${near.join(", ")}.` : "No enemy hero is visible near there now."} Count it as a lost fight and take it into your plan.`;
	});
}

const DANGER_TILES = 10;
const DANGER_RATIO = 0.8;

/** Enemy heroes that are about as strong as ours or stronger and close to one of our heroes: what can still go wrong before the turn ends. */
export function dangerAlerts(facts: EconomyFacts): Array<{ text: string; heroes: number[] }> {
	const out: Array<{ text: string; heroes: number[] }> = [];
	for(const t of facts.threats) {
		const pos = t.pos as Pos | undefined;
		if(t.type !== "hero" || t.ownerColor === "neutral" || !pos || !(Number(t.strengthRatio) > DANGER_RATIO))
			continue;
		const close = facts.heroes.filter(h => h.pos.z === pos.z && Math.max(Math.abs(h.pos.x - pos.x), Math.abs(h.pos.y - pos.y)) <= DANGER_TILES);
		if(close.length > 0)
			out.push({ text: `${String(t.name)} (${String(t.ownerColor)}, ratio ${String(t.strengthRatio)} against your strongest hero) is at ${pos.x},${pos.y}, within ${DANGER_TILES} tiles of ${close.map(h => `${h.name} (${h.id}) at ${h.pos.x},${h.pos.y}`).join(", ")}`, heroes: close.map(h => h.id) });
	}
	return out;
}

export interface LoopDeps {
	tachka: Tachka;
	king: King;
	journal: Journal;
	/** Days of journal shown to the king. */
	memoryDays: number;
	/** Debug mode: every step of a turn is written to its own file. */
	trace?: Trace;
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
export async function awaitTurn(tachka: Tachka, signal?: AbortSignal): Promise<"turn" | "over" | "aborted"> {
	for(;;) {
		if(signal?.aborted)
			return "aborted";
		const startedWaiting = Date.now();
		const wait = await tachka.bridge.call<{ yourTurn: boolean; battle: boolean; gameOver?: boolean }>("wait_for_turn", { timeoutMs: 15_000 }, 60_000);
		if(wait.gameOver)
			return "over";
		if(wait.yourTurn)
			return "turn";
		if(wait.battle)
			await tachka.bridge.call("battle_act", { action: "autofight" });
		// a wait that returns at once with nothing to do must not turn into a busy loop
		else if(Date.now() - startedWaiting < 200)
			await sleep(1_000);
	}
}

/** The game ended or the client was closed: the connection is gone, which is not a failure of the turn. */
export function connectionLost(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException).code;
	return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || (e instanceof Error && e.message.includes("closed the connection"));
}

/** Where a dialog came up: the hero on a mission, whether the mission may fight, and what the plan keeps back. */
interface AnswerEnv extends AnswerContext {
	hero?: number;
	reserved?: Resources;
}

const ARMY_SLOTS = 7;
const HERO_PRICE = 2500;

/** Buys what the hero can pay for and carry at a dwelling on the map: best level first, within what the plan keeps back. */
async function recruitAtDwelling(deps: LoopDeps, question: Question & { object?: number; recruitable?: Recruitable[] }, deviations: unknown[], env: AnswerEnv): Promise<void> {
	if(env.hero === undefined || question.object === undefined)
		return;
	const bridge = deps.tachka.bridge;
	const state = await bridge.call<{ resources: Resources; heroes: Hero[] }>("get_state", { radius: 0 });
	const hero = state.heroes.find(h => h.id === env.hero);
	if(!hero)
		return;

	let budget = Object.fromEntries(RESOURCES.map(r => [r, Math.max(0, state.resources[r] - (env.reserved?.[r] ?? 0))])) as Resources;
	const army = new Set(hero.army.map(a => a.creature));
	for(const entry of [...(question.recruitable ?? [])].sort((a, b) => b.level - a.level)) {
		const count = Math.min(entry.available, ...RESOURCES.map(r => entry.cost[r] > 0 ? Math.floor(budget[r] / entry.cost[r]) : Infinity));
		if(count <= 0)
			continue;
		// a new creature needs a free slot; an existing stack takes more of the same
		if(!army.has(entry.creature) && army.size >= ARMY_SLOTS) {
			deviations.push({ kind: "army_full", hero: env.hero, creature: entry.creature, available: count });
			continue;
		}
		try {
			await bridge.call("recruit", { object: question.object, hero: env.hero, creature: entry.creature, count });
			army.add(entry.creature);
			budget = Object.fromEntries(RESOURCES.map(r => [r, budget[r] - entry.cost[r] * count])) as Resources;
		}
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "rejected", action: `recruit ${count} ${entry.creature} at ${question.object}`, error: e.message });
		}
	}
}

/** Answers every open dialog. A dialog nobody has a rule for is answered anyway (no, if it can be declined) and reported. */
async function answerQuestions(deps: LoopDeps, questions: Question[], deviations: unknown[], env: AnswerEnv = {}): Promise<boolean> {
	for(const question of questions) {
		if(question.kind === "recruitment")
			await recruitAtDwelling(deps, question, deviations, env);
		let choice = question.kind === "recruitment" ? 0 : deps.king.answer?.(question, env);
		if(choice === undefined) {
			choice = (question as { cancel?: boolean }).cancel ? 0 : 1;
			deps.tachka.publish({ type: "problem", text: `no rule for this dialog, answered ${choice}: ${JSON.stringify(question).slice(0, 300)}` });
			deviations.push({ kind: "unknown_dialog", question, answered: choice });
		}
		await deps.tachka.bridge.call("answer_question", { id: question.id, choice });
	}
	return true;
}

/** Answers dialogs until none is open: an answer can open the next one (a Tree of Knowledge level-up, for instance). */
async function settleQuestions(deps: LoopDeps, deviations: unknown[], env: AnswerEnv = {}): Promise<boolean> {
	for(let round = 0; round < 8; round++) {
		const status = await deps.tachka.bridge.call<{ pendingQuestions?: Question[]; battle?: boolean }>("status");
		const open = status.pendingQuestions ?? [];
		// answering a dialog can start a fight; no command may be sent until it is fought out
		if(status.battle) {
			await deps.tachka.bridge.call("battle_act", { action: "autofight" });
			continue;
		}
		if(open.length === 0)
			return true;
		if(!await answerQuestions(deps, open, deviations, env))
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
	writeFileSync(path, JSON.stringify({ plan: state.plan, previousEnd: state.previousEnd, deviations: state.deviations, turn: state.turn, ended: state.ended, memory: state.memory, heroesSeen: state.heroesSeen, scenario: state.scenario }));
}

export function loadLoopState(path: string): LoopState {
	if(!existsSync(path))
		return newLoopState();
	const saved = JSON.parse(readFileSync(path, "utf8"));
	return { plan: saved.plan ? parsePlan(saved.plan) : undefined, previousEnd: saved.previousEnd, deviations: saved.deviations ?? [], turn: saved.turn ?? 0, ended: saved.ended, memory: saved.memory, heroesSeen: saved.heroesSeen, scenario: saved.scenario };
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

const MOVEMENT_LEFT_TO_KEEP_GOING = 0.25;
const MAX_EXTRA_WALKS = 4;

/**
 * Movement points do not carry over to the next day, so a hero that stops with most of them left wastes the day.
 * Unless the king holds it, it walks on to the nearest unvisited, unguarded site for as long as a quarter of the day remains.
 */
async function useLeftoverMovement(deps: LoopDeps, state: LoopState, facts: EconomyFacts, decision: Decision, remaining: Map<number, { movement: number; pos: Pos; blocked: boolean }>, moves: JournalEntry["moves"], deviations: unknown[]): Promise<boolean> {
	const bridge = deps.tachka.bridge;
	const visitedNow = new Set<string>();
	for(const hero of facts.heroes) {
		if(decision.hold.includes(hero.id))
			continue;
		let at = remaining.get(hero.id) ?? { movement: hero.movement, pos: hero.pos, blocked: false };
		const limit = hero.movementLimit ?? hero.movement;
		for(let walk = 0; walk < MAX_EXTRA_WALKS && !at.blocked && at.movement >= MOVEMENT_LEFT_TO_KEEP_GOING * limit; walk++) {
			// a hero alone in an undefended town is its defender
			if(facts.towns.some(t => t.pos.x === at.pos.x && t.pos.y === at.pos.y && t.pos.z === at.pos.z && t.garrison === 0 && !facts.heroes.some(h => h.id !== hero.id && h.pos.x === t.pos.x && h.pos.y === t.pos.y)))
				break;
			const sites = (await collectSites(bridge, hero.id, 25)).filter(s => isSafeToWalk(s) && !s.visitedByHero && !s.visitedByUs && s.turns <= 1 && !visitedNow.has(`${s.pos.x},${s.pos.y},${s.pos.z}`));
			const next = sites[0];
			if(!next)
				break;
			visitedNow.add(`${next.pos.x},${next.pos.y},${next.pos.z}`);
			let outcome: MoveOutcome;
			try {
				outcome = await goTo(bridge, hero.id, next.pos);
				for(let resume = 0; resume < 3 && outcome.pendingQuestions.length > 0; resume++) {
					if(!await settleQuestions(deps, deviations, { hero: hero.id, reserved: state.plan ? reservedTotal(state.plan.reserves) : undefined }))
						return false;
					outcome = await goTo(bridge, hero.id, next.pos);
				}
			}
			catch(e) {
				if(!(e instanceof BridgeError))
					throw e;
				deviations.push({ kind: "rejected", action: `extra walk of hero ${hero.id}`, error: e.message });
				break;
			}
			moves.push({ hero: hero.id, target: next.pos, intent: `(automatic, movement left) ${next.name}`, reached: outcome.reached || outcome.visited === true, stopped: outcome.stopped });
			if(outcome.stopped === "guarded")
				deviations.push({ kind: "guarded", hero: hero.id, guard: outcome.guard, intent: `(automatic) ${next.name}` });
			at = { movement: outcome.movement, pos: outcome.pos, blocked: outcome.stopped !== undefined && outcome.stopped !== "not enough movement points this turn" };
		}
	}
	return true;
}

/** Walks the missions in order; a dialog or a fight on the way is settled and the walk resumes. Returns false when the loop must stop. */
async function runMissions(deps: LoopDeps, state: LoopState, missions: Decision["missions"], remaining: Map<number, { movement: number; pos: Pos; blocked: boolean }>, moves: JournalEntry["moves"], deviations: unknown[]): Promise<boolean> {
	const bridge = deps.tachka.bridge;
	for(const mission of missions) {
		// a dialog (chest, level-up) interrupts the walk; after answering it the same mission resumes
		let outcome: MoveOutcome;
		try {
			outcome = await goTo(bridge, mission.hero, mission.target, { allowFight: mission.allowFight });
			const interrupted = (o: MoveOutcome) => o.pendingQuestions.length > 0 || o.stopped === "battle waiting for orders";
			for(let resume = 0; resume < 4 && interrupted(outcome); resume++) {
				// a fight that started during the walk is fought out now so the mission and the rest of the turn go on
				if(outcome.stopped === "battle waiting for orders")
					await bridge.call("battle_act", { action: "autofight" });
				// walking onto a tile where our own hero stands opens an exchange instead of moving: the meeting is the visit
				const met = outcome.pendingQuestions.some(q => (q as { kind?: string }).kind === "hero_exchange");
				if(!await settleQuestions(deps, deviations, { allowFight: mission.allowFight, hero: mission.hero, reserved: state.plan ? reservedTotal(state.plan.reserves) : undefined })) {
					return false;
				}
				if(met) {
					outcome = { ...outcome, reached: true, stopped: undefined, pendingQuestions: [] };
					break;
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
		remaining.set(mission.hero, { movement: outcome.movement, pos: outcome.pos, blocked: outcome.stopped !== undefined && outcome.stopped !== "not enough movement points this turn" });
		if(outcome.stopped === "guarded")
			deviations.push({ kind: "guarded", hero: mission.hero, guard: outcome.guard, intent: mission.intent });
	}
	return true;
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
	deps.trace?.step("dialogs", { deviations: carried });

	if(!state.scenario)
		state.scenario = await bridge.call<Scenario>("scenario").then(r => Array.isArray(r?.players) ? r : undefined).catch(e => {
			if(e instanceof BridgeError)
				return undefined; // an older client does not know the command
			throw e;
		});
	const facts = await collectFacts(bridge, state.previousEnd);
	const sites: Record<number, Site[]> = {};
	for(const hero of facts.heroes)
		sites[hero.id] = await collectSites(bridge, hero.id, 40);
	deps.trace?.begin(facts.day);
	deps.trace?.step("facts", { facts, sites });

	const brief: Brief = {
		scenario: state.scenario, facts, plan: state.plan, sites, blockers: collectBlockers(facts, mergeSites(sites)),
		journal: journal.tail(facts.day, deps.memoryDays), deviations: state.deviations, messages: tachka.drainInbox(), events: [...lostHeroNotices(state.heroesSeen, facts), ...tachka.drainEvents()], memory: state.memory,
	};
	state.heroesSeen = facts.heroes.map(h => ({ id: h.id, name: h.name, level: h.level, units: h.army.reduce((n, a) => n + a.count, 0), pos: h.pos }));
	tachka.publish({ type: "facts", facts: { day: facts.day, week: facts.week, dayOfWeek: facts.dayOfWeek, resources: facts.resources, income: facts.incomeSinceLastTurn, towns: facts.towns.map(t => ({ id: t.id, name: t.name, faction: t.faction, buildings: t.buildings, stock: t.recruitable, garrisonArmy: t.garrisonArmy, hasVisitingHero: t.hasVisitingHero, hasGarrisonHero: t.hasGarrisonHero })), heroes: facts.heroes, blockers: brief.blockers, plan: state.plan, memory: state.memory } });
	deps.trace?.step("brief", renderBrief(brief));
	let decision = parseDecision(await king.decide(brief));
	deps.trace?.step("decision", { decision, model: king.trace?.() });
	// the checks run on the first decision; the king gets one round to fix it or to say why the finding does not apply
	const findings = reviewDecision(brief, decision);
	let revised = false;
	const firstDecision = decision;
	if(findings.length > 0 && king.revise) {
		const before = JSON.stringify(decision);
		decision = parseDecision(await king.revise(brief, decision, findings));
		revised = JSON.stringify(decision) !== before;
	}
	deps.trace?.step("review", { findings, revised, decisionBeforeRevise: revised ? firstDecision : undefined, decision, model: (king.trace?.() ?? []).filter(r => (r as { kind?: string }).kind === "revise") });
	if(findings.length > 0)
		tachka.publish({ type: "review", findings: findings.map(f => f.text), revised });
	const usage = king.usage?.();
	tachka.publish({ type: "king", note: decision.note, usage: usage?.last ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }, total: usage?.total ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }, ms: usage?.ms ?? 0 });
	if(decision.reply)
		tachka.publish({ type: "chat", from: "king", text: decision.reply });
	if(decision.memory)
		state.memory = decision.memory;
	if(decision.plan)
		state.plan = decision.plan;
	else if(!state.plan) {
		state.plan = defaultPlan(facts);
		tachka.publish({ type: "problem", text: "the king sent no economy plan and none exists; the default chain is running until it sends one" });
	}

	const deviations: unknown[] = [];
	const trades: Array<Record<string, unknown>> = [];
	const rejected = async (action: string, run: () => Promise<unknown>) => {
		try { await run(); }
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "rejected", action, error: e.message });
		}
	};

	// trades come first: the plan builds with what they bring
	for(const t of decision.trade) {
		const have = facts.resources[t.give];
		const amount = Math.min(t.amount, have);
		if(amount <= 0) {
			deviations.push({ kind: "trade_failed", trade: t, error: `no ${t.give} to give` });
			continue;
		}
		try {
			const result = await bridge.call<{ rate: { give: number; get: number } }>("trade", { town: t.town, give: t.give, get: t.get, amount });
			trades.push({ ...t, amount, rate: result.rate });
		}
		catch(e) {
			if(!(e instanceof BridgeError))
				throw e;
			deviations.push({ kind: "trade_failed", trade: t, error: e.message });
		}
	}

	let economy: ExecutionReport | undefined;
	if(state.plan) {
		const hold = Object.fromEntries(RESOURCES.map(r => [r, r === "gold" ? HERO_PRICE * decision.hire.length : 0])) as Resources;
		economy = await executePlan(bridge, state.plan, await collectFacts(bridge, state.previousEnd), hold);
		deviations.push(...economy.deviations);
		state.previousEnd = economy.treasuryAfter;
	}

	// the server refuses stack changes between objects that are not together; a merge only runs when they are
	const mergedEarly = new Set<string>();
	const doMerges = async (list: Decision["merge"], quiet: boolean) => {
		if(list.length === 0)
			return;
		const now = await bridge.call<{ heroes: Hero[]; towns: Array<{ id: number; pos: Pos }> }>("get_state", { radius: 0 });
		const where = new Map<number, Pos>([...now.heroes.map(h => [h.id, h.pos] as const), ...now.towns.map(t => [t.id, t.pos] as const)]);
		for(const m of list) {
			const a = where.get(m.from);
			const b = where.get(m.to);
			if(!a || !b || a.z !== b.z || Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1) {
				if(!quiet)
					deviations.push({ kind: "merge_not_together", from: m.from, to: m.to, fromPos: a, toPos: b, hint: "a hero must be in the town, or two heroes on adjacent tiles; walk there first" });
				continue;
			}
			await rejected(`merge ${m.from} into ${m.to}`, () => bridge.call("move_army", m));
			mergedEarly.add(`${m.from}>${m.to}`);
		}
	};
	// a merge between two objects that stand together now runs before anyone walks away: "merge the garrison and head north" means in that order
	await doMerges(decision.merge, true);

	const moves: JournalEntry["moves"] = [];
	const remaining = new Map<number, { movement: number; pos: Pos; blocked: boolean }>();
	if(!await runMissions(deps, state, decision.missions, remaining, moves, deviations)) {
		state.deviations = deviations;
		return false;
	}

	// a mission can end with a dialog still open, and the server refuses stack changes until it is answered
	if(!await settleQuestions(deps, deviations)) {
		state.deviations = deviations;
		return false;
	}
	// merges that were not possible before the walks (the hero had to arrive first) run now
	await doMerges(decision.merge.filter(m => !mergedEarly.has(`${m.from}>${m.to}`)), false);

	let followUpTrace: unknown;
	if(king.followUp) {
		// the king sees what the missions left and decides about the heroes that still have movement; nothing walks on its own
		const fresh = await collectFacts(bridge, state.previousEnd);
		const idle = fresh.heroes.filter(h => !decision.hold.includes(h.id) && !remaining.get(h.id)?.blocked && h.movement >= MOVEMENT_LEFT_TO_KEEP_GOING * (h.movementLimit ?? h.movement));
		// the missions may have brought a hero into the reach of an enemy hero: the king gets a last look before the turn ends
		const alerts = dangerAlerts(fresh);
		if(idle.length > 0 || alerts.length > 0) {
			const freshSites: Record<number, Site[]> = {};
			for(const hero of fresh.heroes)
				freshSites[hero.id] = await collectSites(bridge, hero.id, 40);
			const report = [
				...moves.map(m => `- hero ${m.hero}: ${m.intent} -> ${m.reached ? "done" : m.stopped ?? "not reached"}`),
				...(deviations.length ? [`problems so far: ${JSON.stringify(deviations).slice(0, 800)}`] : []),
				...alerts.map(a => `ALERT: ${a.text}`),
				`heroes with movement left: ${idle.map(h => `${h.name} (${h.id}) at ${h.pos.x},${h.pos.y} with ${h.movement}/${h.movementLimit ?? h.movement}`).join("; ") || "none"}`,
			].join("\n");
			const followBrief: Brief = { ...brief, facts: fresh, sites: freshSites, blockers: collectBlockers(fresh, mergeSites(freshSites)), deviations, events: tachka.drainEvents(), messages: [] };
			const more = parseDecision(await king.followUp(followBrief, report));
			const mayMove = new Set([...idle.map(h => h.id), ...alerts.flatMap(a => a.heroes)]);
			const missions = more.missions.filter(m => mayMove.has(m.hero));
			followUpTrace = { report, decision: more, used: missions.length };
			const rest = new Map<number, { movement: number; pos: Pos; blocked: boolean }>();
			if(!await runMissions(deps, state, missions, rest, moves, deviations)) {
				state.deviations = deviations;
				return false;
			}
			// heroes that stand together can still join their armies, which costs no movement
			await doMerges(more.merge.filter(m => !mergedEarly.has(`${m.from}>${m.to}`)), false);
		}
	}
	else if(!await useLeftoverMovement(deps, state, facts, decision, remaining, moves, deviations)) {
		state.deviations = deviations;
		return false;
	}

	// after the walks: a town with a hero standing in it cannot hire, so heroes leave first
	for(const h of decision.hire) {
		await rejected(`hire ${h.hero} in ${h.town}`, () => bridge.call("buy_hero", { town: h.town, hero: h.hero }));
		// the bridge reports success before the server has decided; the hero must show up among ours
		const heroes = (await bridge.call<{ heroes: Hero[] }>("get_state", { radius: 0 })).heroes;
		if(!heroes.some(x => x.id === h.hero))
			deviations.push({ kind: "hire_failed", hero: h.hero, town: h.town });
	}
	deps.trace?.step("orders", { orders: { hire: decision.hire, merge: decision.merge, hold: decision.hold }, plan: state.plan, economy, moves, deviations, followUp: followUpTrace });
	journal.append({
		day: facts.day, turn: state.turn, note: decision.note,
		built: economy?.built ?? [], recruited: economy?.recruited ?? [], moves, deviations,
		orders: { hire: decision.hire, merge: decision.merge, trade: trades },
		review: findings.length ? { findings: findings.map(f => f.code), revised } : undefined,
	});
	state.deviations = deviations;
	const entry = journal.tail(facts.day, 1).at(-1);
	deps.trace?.step("record", entry);
	tachka.publish({
		type: "turn", day: facts.day, journal: entry,
		line: `built ${economy?.built.map(b => b.building.replace("core:", "")).join(", ") || "nothing"}; recruited ${economy?.recruited.reduce((n, r) => n + r.count, 0) ?? 0}; ${moves.map(m => `${m.intent}${m.reached ? " (done)" : m.stopped ? ` (${m.stopped})` : ""}`).join("; ") || "no moves"}`,
	});
	if(!await settleQuestions(deps, deviations)) {
		state.deviations = deviations;
		return false;
	}
	await nextTurn(bridge);
	deps.trace?.step("end", { turn: state.turn, day: facts.day });
	deps.trace?.finish();
	return true;
}

/** After a failed turn: answer what is open, finish a battle, end the turn, so one failure does not freeze the game. */
async function rescueTurn(deps: LoopDeps): Promise<void> {
	await settleQuestions(deps, []);
	await nextTurn(deps.tachka.bridge);
}

const MAX_FAILED_TURNS = 3;

/** Plays until the turn limit, the end of the game, a lost connection, three failed turns in a row, or the signal aborts. */
export async function playGame(deps: LoopDeps, options: { maxTurns?: number; signal?: AbortSignal; statePath?: string; resume?: boolean } = {}): Promise<LoopState> {
	const state = options.statePath && options.resume ? loadLoopState(options.statePath) : newLoopState();
	const first = state.turn;
	let failures = 0;
	while(state.turn - first < (options.maxTurns ?? Infinity)) {
		try {
			const next = await awaitTurn(deps.tachka, options.signal);
			if(next === "over") {
				state.ended = "game over";
				break;
			}
			if(next === "aborted")
				break;
			await playTurn(deps, state);
			failures = 0;
		}
		catch(e) {
			if(connectionLost(e)) {
				state.ended = "connection lost";
				break;
			}
			failures++;
			deps.tachka.publish({ type: "problem", text: `turn failed (${failures}/${MAX_FAILED_TURNS}): ${e instanceof Error ? e.message : String(e)}` });
			if(failures >= MAX_FAILED_TURNS) {
				state.ended = "failed turns";
				break;
			}
			try {
				await rescueTurn(deps);
			}
			catch(rescue) {
				if(connectionLost(rescue)) {
					state.ended = "connection lost";
					break;
				}
				deps.tachka.publish({ type: "problem", text: `could not end the turn either: ${rescue instanceof Error ? rescue.message : String(rescue)}` });
				await sleep(2_000);
			}
		}
		if(options.statePath)
			saveLoopState(options.statePath, state);
	}
	if(options.statePath)
		saveLoopState(options.statePath, state);
	return state;
}
