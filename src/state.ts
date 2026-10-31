export const RESOURCES = ["wood", "mercury", "ore", "sulfur", "crystal", "gems", "gold"] as const;
export type Resources = Record<(typeof RESOURCES)[number], number>;

export interface Recruitable {
	level: number;
	creature: string;
	name: string;
	available: number;
	cost: Resources;
}

export interface Town {
	id: number;
	name: string;
	faction: string;
	pos: { x: number; y: number; z: number };
	builtThisTurn: boolean;
	visitingHero: number;
	garrisonHero: number;
	buildings: string[];
	recruitable: Recruitable[];
	army?: Array<{ creature: string; count: number }>;
}

export interface Buildable {
	building: string;
	name: string;
	state: string;
	cost: Resources;
}

export interface Hero {
	id: number;
	name: string;
	class: string;
	level: number;
	pos: { x: number; y: number; z: number };
	movement: number;
	army: Array<{ creature: string; count: number; slot: number }>;
	primarySkills: Record<string, number>;
	secondarySkills?: Array<{ skill: string; level: number }>;
	spells?: string[];
	mana?: number;
	exp?: number;
	/** The engine's combat value of the hero with its army. */
	combatValue?: number;
	movementLimit?: number;
}

export interface MapObject {
	id: number;
	type: string;
	subtype: string;
	name: string;
	pos: { x: number; y: number; z: number };
	owner: number;
	size?: string;
}

export interface GameState {
	day: number;
	resources: Resources;
	towns: Town[];
	heroes: Hero[];
	player?: string;
	mapSize?: { x: number; y: number; z: number };
	visibleObjects?: MapObject[];
}

export function canAfford(have: Resources, cost: Resources): boolean {
	return RESOURCES.every(r => have[r] >= cost[r]);
}

export function subtract(have: Resources, cost: Resources, times = 1): Resources {
	const rest = { ...have };
	for(const r of RESOURCES)
		rest[r] -= cost[r] * times;
	return rest;
}
