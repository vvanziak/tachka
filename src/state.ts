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
	builtThisTurn: boolean;
	visitingHero: number;
	garrisonHero: number;
	buildings: string[];
	recruitable: Recruitable[];
}

export interface Buildable {
	building: string;
	name: string;
	state: string;
	cost: Resources;
}

export interface GameState {
	day: number;
	resources: Resources;
	towns: Town[];
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
