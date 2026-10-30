import type { EconomyFacts } from "./facts.js";
import type { Site } from "./missions.js";
import { RESOURCES, type Resources } from "./state.js";

export interface Blocker {
	town: number;
	building: string;
	/** How much of each resource the treasury lacks for this building. */
	short: Partial<Resources>;
	/** Known sites that supply a missing resource, nearest first. */
	suppliers: Array<{ resource: keyof Resources; site: Site }>;
}

const MINE_RESOURCE: Record<string, keyof Resources> = {
	sawmill: "wood", oreMine: "ore", alchemistLab: "mercury", sulfurDune: "sulfur", crystalCavern: "crystal", gemPond: "gems", goldMine: "gold",
};

/** The resource a site yields: a mine by its subtype, a pile by its name. */
export function siteResource(site: Site): keyof Resources | undefined {
	const mine = MINE_RESOURCE[site.subtype];
	if(mine)
		return mine;
	if(site.type !== "resource")
		return undefined;
	const name = site.name.toLowerCase();
	return RESOURCES.find(r => name.includes(r));
}

/** Buildings a town could build if it had the resources, joined with the sites that could supply them. */
export function collectBlockers(facts: EconomyFacts, sites: Site[]): Blocker[] {
	const blockers: Blocker[] = [];
	for(const town of facts.towns) {
		for(const option of town.options) {
			if(option.state !== "no_resources" || option.missing.length === 0)
				continue;
			const short: Partial<Resources> = {};
			for(const r of option.missing)
				short[r] = option.cost[r] - facts.resources[r];

			const suppliers = sites
				.map(site => ({ site, resource: siteResource(site) }))
				.filter((s): s is { site: Site; resource: keyof Resources } => s.resource !== undefined && option.missing.includes(s.resource))
				.sort((a, b) => a.site.turns - b.site.turns || a.site.steps - b.site.steps)
				.map(({ site, resource }) => ({ resource, site }));
			blockers.push({ town: town.id, building: option.building, short, suppliers });
		}
	}
	return blockers;
}
