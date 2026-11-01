import type { BridgeClient } from "./bridge.js";

export interface Pos {
	x: number;
	y: number;
	z: number;
}

/** A reachable object as `targets` reports it; monsters carry the guard's size, threat band and strength ratio. */
export interface Site {
	id: number;
	type: string;
	subtype: string;
	name: string;
	pos: Pos;
	owner: number;
	steps: number;
	turns: number;
	size?: string;
	threat?: string;
	strengthRatio?: number;
	/** The game's own visited status: per hero for places like a Learning Stone, per player for weekly ones; both reset by the game. */
	visitedByHero?: boolean;
	visitedByUs?: boolean;
}

/** A site that holds an army without being a monster stack (a garrison): walking onto it starts a fight, and `targets` gives it no threat label. */
export const isArmed = (site: Pick<Site, "type" | "subtype" | "name">): boolean => /garrison/i.test(`${site.type} ${site.subtype} ${site.name}`);

/** Objects that are free to visit and cannot start a fight; anything not listed is left to the king. */
const HARMLESS_TYPES = new Set([
	"resource", "treasureChest", "campfire", "artifact", "windmill", "waterWheel", "mysticalGarden", "learningStone", "fountainOfFortune", "fountainOfYouth",
	"magicWell", "faerieRing", "temple", "stables", "redwoodObservatory", "starAxis", "shrineOfMagicLevel1", "shrineOfMagicLevel2", "shrineOfMagicLevel3",
	"obelisk", "idolOfFortune", "rallyFlag", "swanPond", "gardenOfRevelation", "marlettoTower", "witchHut", "mercenaryCamp", "mine", "creatureGeneratorCommon",
]);

/** A place automatic walking may go to: a harmless object that no player owns. */
export const isSafeToWalk = (site: Pick<Site, "type" | "subtype" | "name" | "owner" | "threat">): boolean =>
	HARMLESS_TYPES.has(site.type) && !site.threat && !isArmed(site) && site.owner < 0;

export interface FightCandidate {
	guard: Site;
	/** Other objects within two tiles of the stack: what it most likely guards. */
	behind: Site[];
}

/** Monster stacks the hero can reach, easiest first (lowest strength ratio), each with the objects standing next to it. */
export function fightCandidates(sites: Site[]): FightCandidate[] {
	const near = (a: Pos, b: Pos) => a.z === b.z && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 2;
	return sites
		.filter(s => s.type === "monster" && s.strengthRatio !== undefined)
		.map(guard => ({ guard, behind: sites.filter(o => o.type !== "monster" && near(o.pos, guard.pos)) }))
		.sort((a, b) => (a.guard.strengthRatio ?? 0) - (b.guard.strengthRatio ?? 0));
}

export interface MoveOutcome {
	reached: boolean;
	pos: Pos;
	movement: number;
	visited?: boolean;
	/** Why the hero stopped short: "guarded", "question pending", "not enough movement points this turn", ... */
	stopped?: string;
	guard?: { id: number; name: string; pos: Pos };
	pendingQuestions: unknown[];
}

interface MoveReply extends Omit<MoveOutcome, "pendingQuestions"> {
	status?: { pendingQuestions?: unknown[] };
}

export async function collectSites(bridge: BridgeClient, hero: number, limit = 30): Promise<Site[]> {
	const reply = await bridge.call<{ targets?: Site[] } | Site[]>("targets", { hero, limit });
	return Array.isArray(reply) ? reply : reply.targets ?? [];
}

/**
 * Walks a hero toward a tile and stops in front of any guarded tile, so a fight is never started by walking. The
 * outcome says why it stopped; the king decides what to do. `allowFight` is for a deliberate attack on the guard.
 */
export async function goTo(bridge: BridgeClient, hero: number, target: Pos, options: { allowFight?: boolean } = {}): Promise<MoveOutcome> {
	const args: Record<string, unknown> = { hero, ...target };
	if(!options.allowFight)
		args.avoidGuards = true;
	const { status, ...move } = await bridge.call<MoveReply>("move_hero", args);
	return { ...move, pendingQuestions: status?.pendingQuestions ?? [] };
}
