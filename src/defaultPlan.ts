import type { EconomyFacts } from "./facts.js";
import type { Plan } from "./plan.js";

/** Economy chain used before a king has decided anything; also the baseline other plans are compared with. */
const CHAIN = [
	"core:townHall", "core:marketplace", "core:blacksmith", "core:mageGuild1",
	"core:cityHall", "core:citadel", "core:castle", "core:capitol",
];

export function defaultPlan(facts: EconomyFacts): Plan {
	return {
		madeOnDay: facts.day,
		reviewByDay: facts.day + 7,
		note: "default chain, recruit everything",
		reserves: [],
		towns: facts.towns.map(town => {
			const dwellings = town.options
				.map(o => o.building)
				.filter(b => /^core:dwellingLvl\d+/.test(b))
				.sort();
			return {
				town: town.id,
				build: [
					...CHAIN.map(building => ({ building, onShortage: "wait" as const })),
					...dwellings.map(building => ({ building, onShortage: "skip" as const })),
				],
				recruit: { mode: "all" as const },
			};
		}),
	};
}
