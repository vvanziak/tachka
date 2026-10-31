import { BridgeError, type BridgeClient } from "./bridge.js";
import { RESOURCES, type Buildable, type GameState, type Hero, type Recruitable, type Resources, type Town } from "./state.js";

export interface BuildOption extends Buildable {
	/** Resources the treasury lacks for this building right now. */
	missing: Array<keyof Resources>;
}

export interface TavernHero {
	id: number;
	name: string;
	class: string;
	army: Array<{ creature: string; count: number }>;
}

export interface TownFacts {
	id: number;
	name: string;
	faction: string;
	pos: { x: number; y: number; z: number };
	builtThisTurn: boolean;
	hasVisitingHero: boolean;
	hasGarrisonHero: boolean;
	buildings: string[];
	options: BuildOption[];
	recruitable: Recruitable[];
	/** Heroes that can be hired here (empty without a tavern). */
	tavern: TavernHero[];
}

export interface EconomyFacts {
	day: number;
	week: number;
	dayOfWeek: number;
	resources: Resources;
	/** Treasury now minus treasury at the end of our previous turn; undefined on the first turn. */
	incomeSinceLastTurn: Resources | undefined;
	towns: TownFacts[];
	heroes: Hero[];
	/** Visible heroes and towns of other players with their strength against our strongest hero. */
	threats: Array<Record<string, unknown>>;
}

interface StateWithCalendar extends GameState {
	week: number;
	dayOfWeek: number;
	towns: Town[];
}

export function missingResources(have: Resources, cost: Resources): Array<keyof Resources> {
	return RESOURCES.filter(r => have[r] < cost[r]);
}

/** Gathers what the king needs to decide: no choices are made here. */
export async function collectFacts(bridge: BridgeClient, previousEnd?: Resources): Promise<EconomyFacts> {
	const state = await bridge.call<StateWithCalendar>("get_state", { radius: 0 });
	const towns: TownFacts[] = [];
	for(const town of state.towns) {
		const options = await bridge.call<Buildable[]>("get_buildable", { town: town.id });
		const tavern = town.buildings.includes("core:tavern") ? await bridge.call<TavernHero[]>("get_tavern", { town: town.id }).catch(e => {
			if(e instanceof BridgeError)
				return [];
			throw e;
		}) : [];
		towns.push({
			id: town.id,
			name: town.name,
			faction: town.faction,
			pos: town.pos,
			builtThisTurn: town.builtThisTurn,
			hasVisitingHero: town.visitingHero >= 0,
			hasGarrisonHero: town.garrisonHero >= 0,
			buildings: town.buildings,
			options: options.map(o => ({ ...o, missing: missingResources(state.resources, o.cost) })),
			recruitable: town.recruitable,
			tavern,
		});
	}

	const income = previousEnd && Object.fromEntries(RESOURCES.map(r => [r, state.resources[r] - previousEnd[r]])) as Resources;
	return { day: state.day, week: state.week, dayOfWeek: state.dayOfWeek, resources: state.resources, incomeSinceLastTurn: income, towns, heroes: state.heroes, threats: await collectThreats(bridge, state.heroes[0]?.id) };
}

async function collectThreats(bridge: BridgeClient, hero: number | undefined): Promise<Array<Record<string, unknown>>> {
	try {
		const reply = await bridge.call<{ enemies?: Array<Record<string, unknown>> }>("threats", hero === undefined ? {} : { hero });
		return (reply.enemies ?? []).filter(e => JSON.stringify(e).length < 1500);
	}
	catch(e) {
		if(e instanceof BridgeError)
			return [];
		throw e;
	}
}
