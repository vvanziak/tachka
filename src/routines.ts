import type { BridgeClient } from "./bridge.js";
import { canAfford, RESOURCES, subtract, type Buildable, type GameState, type Resources, type Town } from "./state.js";

/** Economy chain in priority order; keys missing from the town (faction differences, unmet requirements) are skipped. */
export const BUILD_ORDER = [
	"core:townHall", "core:marketplace", "core:blacksmith", "core:mageGuild1",
	"core:cityHall", "core:citadel", "core:castle", "core:capitol",
];

const DWELLING = /^core:dwellingLvl(\d+)/;

/** Gold shortfall means waiting pays off; a missing rare resource cannot be fixed by saving gold. */
function onlyGoldMissing(have: Resources, cost: Resources): boolean {
	return RESOURCES.every(r => r === "gold" || have[r] >= cost[r]) && have.gold < cost.gold;
}

export function chooseBuilding(options: Buildable[], have: Resources): Buildable | undefined {
	const byKey = new Map(options.map(o => [o.building, o]));
	for(const key of BUILD_ORDER) {
		const option = byKey.get(key);
		if(!option)
			continue;
		if(option.state === "allowed" && canAfford(have, option.cost))
			return option;
		if(onlyGoldMissing(have, option.cost))
			return undefined;
	}

	const dwellings = options
		.filter(o => DWELLING.test(o.building) && o.state === "allowed" && canAfford(have, o.cost))
		.sort((a, b) => Number(DWELLING.exec(a.building)?.[1]) - Number(DWELLING.exec(b.building)?.[1]));
	return dwellings[0];
}

/** Builds at most one structure in the town (the game allows one per day). Returns the building key built, if any. */
export async function buildRoutine(bridge: BridgeClient, town: Town, have: Resources): Promise<string | undefined> {
	if(town.builtThisTurn)
		return undefined;
	const options = await bridge.call<Buildable[]>("get_buildable", { town: town.id });
	const choice = chooseBuilding(options, have);
	if(!choice)
		return undefined;
	await bridge.call("build", { town: town.id, building: choice.building });
	return choice.building;
}

/** Buys the available stock, highest creature level first, with the gold and resources that are left. */
export async function recruitRoutine(bridge: BridgeClient, town: Town, have: Resources): Promise<Array<{ creature: string; count: number }>> {
	const bought: Array<{ creature: string; count: number }> = [];
	let rest = have;
	for(const entry of [...town.recruitable].sort((a, b) => b.level - a.level)) {
		const affordable = Math.min(...RESOURCES.map(r => entry.cost[r] > 0 ? Math.floor(rest[r] / entry.cost[r]) : Infinity));
		const count = Math.min(entry.available, affordable);
		if(count <= 0)
			continue;
		await bridge.call("recruit", { town: town.id, creature: entry.creature, count });
		rest = subtract(rest, entry.cost, count);
		bought.push({ creature: entry.creature, count });
	}
	return bought;
}

export interface TurnReport {
	day: number;
	built: Array<{ town: number; building: string }>;
	recruited: Array<{ town: number; creature: string; count: number }>;
}

/** The deterministic part of a turn: build in every town, then recruit with what is left. */
export async function economyRoutine(bridge: BridgeClient): Promise<TurnReport> {
	const state = await bridge.call<GameState>("get_state", { radius: 0 });
	const report: TurnReport = { day: state.day, built: [], recruited: [] };

	for(const town of state.towns) {
		const building = await buildRoutine(bridge, town, state.resources);
		if(building)
			report.built.push({ town: town.id, building });
	}

	const after = await bridge.call<GameState>("get_state", { radius: 0 });
	let have = after.resources;
	for(const town of after.towns) {
		const bought = await recruitRoutine(bridge, town, have);
		for(const b of bought) {
			report.recruited.push({ town: town.id, ...b });
			const entry = town.recruitable.find(r => r.creature === b.creature);
			if(entry)
				have = subtract(have, entry.cost, b.count);
		}
	}
	return report;
}
