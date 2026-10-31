import { BridgeError, type BridgeClient } from "./bridge.js";
import { PLAYER_COLORS } from "./protocol.js";
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
	/** Units standing in the town's own garrison. */
	garrison: number;
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
	/** Our colour and the map size. */
	game: { player: string | undefined; mapSize: { x: number; y: number; z: number } | undefined };
	/** Mines we own and the other mines we know of. */
	mines: { owned: MineInfo[]; others: MineInfo[] };
	/** Guild of Thieves intel on every player (rankings by towns, heroes, gold, army, income...), when a tavern exists. */
	rankings: unknown;
}

export interface MineInfo {
	name: string;
	subtype: string;
	pos: { x: number; y: number; z: number };
	owner: number;
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
			garrison: (town.army ?? []).reduce((n, a) => n + a.count, 0),
		});
	}

	const income = previousEnd && Object.fromEntries(RESOURCES.map(r => [r, state.resources[r] - previousEnd[r]])) as Resources;
	return { day: state.day, week: state.week, dayOfWeek: state.dayOfWeek, resources: state.resources, incomeSinceLastTurn: income, towns, heroes: state.heroes, threats: await collectThreats(bridge, state.heroes[0]?.id),
		game: { player: state.player, mapSize: state.mapSize }, mines: minesOf(state), rankings: await collectRankings(bridge, state.towns.find(t => t.buildings.includes("core:tavern"))?.id) };
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

function minesOf(state: StateWithCalendar): { owned: MineInfo[]; others: MineInfo[] } {
	const me = state.player ? PLAYER_COLORS.indexOf(state.player as (typeof PLAYER_COLORS)[number]) : -99;
	const mines = (state.visibleObjects ?? []).filter(o => o.type === "mine").map(o => ({ name: o.name, subtype: o.subtype, pos: o.pos, owner: o.owner }));
	return { owned: mines.filter(m => m.owner === me), others: mines.filter(m => m.owner !== me) };
}

async function collectRankings(bridge: BridgeClient, town: number | undefined): Promise<unknown> {
	if(town === undefined)
		return undefined;
	try {
		return await bridge.call("thieves_guild", { town });
	}
	catch(e) {
		if(e instanceof BridgeError)
			return undefined;
		throw e;
	}
}
