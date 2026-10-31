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
