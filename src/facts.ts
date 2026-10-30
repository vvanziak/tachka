import type { BridgeClient } from "./bridge.js";
import { RESOURCES, type Buildable, type GameState, type Recruitable, type Resources, type Town } from "./state.js";

export interface BuildOption extends Buildable {
	/** Resources the treasury lacks for this building right now. */
	missing: Array<keyof Resources>;
}

export interface TownFacts {
	id: number;
	name: string;
	faction: string;
	builtThisTurn: boolean;
	hasVisitingHero: boolean;
	hasGarrisonHero: boolean;
	buildings: string[];
	options: BuildOption[];
	recruitable: Recruitable[];
}

export interface EconomyFacts {
	day: number;
	week: number;
	dayOfWeek: number;
	resources: Resources;
	/** Treasury now minus treasury at the end of our previous turn; undefined on the first turn. */
	incomeSinceLastTurn: Resources | undefined;
	towns: TownFacts[];
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
		towns.push({
			id: town.id,
			name: town.name,
			faction: town.faction,
			builtThisTurn: town.builtThisTurn,
			hasVisitingHero: town.visitingHero >= 0,
			hasGarrisonHero: town.garrisonHero >= 0,
			buildings: town.buildings,
			options: options.map(o => ({ ...o, missing: missingResources(state.resources, o.cost) })),
			recruitable: town.recruitable,
		});
	}

	const income = previousEnd && Object.fromEntries(RESOURCES.map(r => [r, state.resources[r] - previousEnd[r]])) as Resources;
	return { day: state.day, week: state.week, dayOfWeek: state.dayOfWeek, resources: state.resources, incomeSinceLastTurn: income, towns };
}
