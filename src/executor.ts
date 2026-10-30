import { BridgeError, type BridgeClient } from "./bridge.js";
import type { EconomyFacts, TownFacts } from "./facts.js";
import type { Plan, TownPlan } from "./plan.js";
import { RESOURCES, subtract, type Resources } from "./state.js";

/** Things the executor could not do or does not know how to judge; the king reads these. */
export type Deviation =
	| { kind: "plan_expired"; reviewByDay: number }
	| { kind: "town_without_plan"; town: number }
	| { kind: "plan_town_missing"; town: number }
	| { kind: "blocked_by_resource"; town: number; building: string; missing: string[] }
	| { kind: "rejected"; town: number; action: string; error: string };

export interface ExecutionReport {
	day: number;
	built: Array<{ town: number; building: string }>;
	recruited: Array<{ town: number; creature: string; count: number }>;
	deviations: Deviation[];
	treasuryAfter: Resources;
}

function reservedTotal(reserves: Plan["reserves"]): Resources {
	const total = Object.fromEntries(RESOURCES.map(r => [r, 0])) as Resources;
	for(const reserve of reserves)
		for(const r of RESOURCES)
			total[r] += reserve.amount[r] ?? 0;
	return total;
}

function affordable(have: Resources, cost: Resources, times = 1): boolean {
	return RESOURCES.every(r => have[r] >= cost[r] * times);
}

async function attempt(report: ExecutionReport, town: number, action: string, run: () => Promise<unknown>): Promise<boolean> {
	try {
		await run();
		return true;
	}
	catch(e) {
		if(!(e instanceof BridgeError))
			throw e;
		report.deviations.push({ kind: "rejected", town, action, error: e.message });
		return false;
	}
}

async function buildStep(bridge: BridgeClient, plan: TownPlan, town: TownFacts, treasury: Resources, reserves: Plan["reserves"], report: ExecutionReport, released: Set<string>): Promise<Resources> {
	if(town.builtThisTurn)
		return treasury;

	for(const step of plan.build) {
		const option = town.options.find(o => o.building === step.building);
		if(!option)
			continue;

		if(option.state !== "allowed" && option.state !== "no_resources")
			continue;

		// a reserve protects its amount from every spend except the step that names it
		const held = reservedTotal(reserves.filter(r => !released.has(r.label) && r.label !== step.usesReserve));
		const spendable = Object.fromEntries(RESOURCES.map(r => [r, Math.max(0, treasury[r] - held[r])])) as Resources;
		if(affordable(spendable, option.cost)) {
			if(await attempt(report, town.id, `build ${option.building}`, () => bridge.call("build", { town: town.id, building: option.building }))) {
				report.built.push({ town: town.id, building: option.building });
				if(step.usesReserve)
					released.add(step.usesReserve);
				return subtract(treasury, option.cost);
			}
			return treasury;
		}

		const missing = RESOURCES.filter(r => spendable[r] < option.cost[r]);
		if(missing.some(r => r !== "gold"))
			report.deviations.push({ kind: "blocked_by_resource", town: town.id, building: option.building, missing: missing.filter(r => r !== "gold") });
		else if(step.onShortage === "wait")
			return treasury;
	}
	return treasury;
}

async function recruitStep(bridge: BridgeClient, plan: TownPlan, town: TownFacts, treasury: Resources, reserved: Resources, report: ExecutionReport): Promise<Resources> {
	const { mode, levels } = plan.recruit;
	if(mode === "none")
		return treasury;

	let rest = treasury;
	for(const entry of [...town.recruitable].sort((a, b) => b.level - a.level)) {
		if(mode === "levels" && !levels?.includes(entry.level))
			continue;
		const budget = Object.fromEntries(RESOURCES.map(r => [r, Math.max(0, rest[r] - reserved[r])])) as Resources;
		const counts = RESOURCES.map(r => entry.cost[r] > 0 ? Math.floor(budget[r] / entry.cost[r]) : Infinity);
		const count = Math.min(entry.available, ...counts);
		if(count <= 0)
			continue;
		if(await attempt(report, town.id, `recruit ${count} ${entry.creature}`, () => bridge.call("recruit", { town: town.id, creature: entry.creature, count }))) {
			report.recruited.push({ town: town.id, creature: entry.creature, count });
			rest = subtract(rest, entry.cost, count);
		}
	}
	return rest;
}

/** Carries out the king's plan against the facts. It never picks a building or a creature the plan does not name. */
export async function executePlan(bridge: BridgeClient, plan: Plan, facts: EconomyFacts): Promise<ExecutionReport> {
	const report: ExecutionReport = { day: facts.day, built: [], recruited: [], deviations: [], treasuryAfter: facts.resources };
	if(facts.day > plan.reviewByDay)
		report.deviations.push({ kind: "plan_expired", reviewByDay: plan.reviewByDay });

	const planned = new Set(plan.towns.map(t => t.town));
	for(const town of facts.towns)
		if(!planned.has(town.id))
			report.deviations.push({ kind: "town_without_plan", town: town.id });

	const released = new Set<string>();
	let treasury = facts.resources;

	// builds first, in town priority order, so planned buildings get the gold before any recruiting does
	const present: Array<{ plan: TownPlan; town: TownFacts }> = [];
	for(const townPlan of plan.towns) {
		const town = facts.towns.find(t => t.id === townPlan.town);
		if(!town) {
			report.deviations.push({ kind: "plan_town_missing", town: townPlan.town });
			continue;
		}
		present.push({ plan: townPlan, town });
		treasury = await buildStep(bridge, townPlan, town, treasury, plan.reserves, report, released);
	}
	const reserved = reservedTotal(plan.reserves.filter(r => !released.has(r.label)));
	for(const { plan: townPlan, town } of present)
		treasury = await recruitStep(bridge, townPlan, town, treasury, reserved, report);

	report.treasuryAfter = treasury;
	return report;
}
