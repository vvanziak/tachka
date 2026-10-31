import { describe, expect, it } from "vitest";
import type { Brief, Decision } from "../src/king.js";
import { reviewDecision } from "../src/review.js";
import type { Resources } from "../src/state.js";

const res = (r: Partial<Resources> = {}): Resources => ({ wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0, ...r });
const pos = { x: 5, y: 5, z: 0 };
const hero = (id: number, army = 10, at = pos) => ({ id, name: `H${id}`, class: "", level: 1, pos: at, movement: 1500, army: [{ creature: "core:imp", count: army, slot: 0 }], primarySkills: {} });
const town = (extra: object = {}) => ({ id: 1, name: "Home", faction: "core:inferno", pos, builtThisTurn: false, hasVisitingHero: false, hasGarrisonHero: false, buildings: [], options: [], recruitable: [], tavern: [], garrison: 0, ...extra });
const decision = (extra: Partial<Decision> = {}): Decision => ({ note: "n", missions: [], hire: [], merge: [], ...extra }) as Decision;

function brief(extra: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): Brief {
	return {
		facts: { day: 5, week: 1, dayOfWeek: 5, resources: res({ gold: 500 }), incomeSinceLastTurn: undefined, towns: [town()], heroes: [hero(1)], threats: [], game: { player: "red", mapSize: undefined }, mines: { owned: [], others: [] }, rankings: undefined, ...facts },
		plan: undefined, sites: {}, blockers: [], journal: [], deviations: [], messages: [], events: [], memory: undefined, ...extra,
	} as unknown as Brief;
}

const codes = (b: Brief, d: Decision) => reviewDecision(b, d).map(f => f.code);

describe("reviewDecision", () => {
	it("flags a town left empty, more sharply when an enemy hero is near", () => {
		const leave = decision({ missions: [{ hero: 1, target: { x: 9, y: 9, z: 0 }, intent: "explore" }] });
		expect(codes(brief(), leave)).toEqual(["empty_town"]);
		const enemy = { type: "hero", ownerColor: "red", name: "Edric", tilesToNearestOwnTown: 9 };
		expect(codes(brief({}, { threats: [enemy] }), leave)).toEqual(["empty_town_threat"]);
	});

	it("accepts a town that keeps a hero, a garrison or recruiting", () => {
		expect(codes(brief(), decision())).toEqual([]);
		expect(codes(brief({}, { towns: [town({ garrison: 5 })], heroes: [] }), decision())).toEqual([]);
	});

	it("flags a trip home for a handful of garrison units", () => {
		const away = { x: 20, y: 20, z: 0 };
		const home = decision({ missions: [{ hero: 1, target: pos, intent: "restock" }] });
		const small = { heroes: [hero(1, 60, away)], towns: [town({ garrison: 6 })] };
		expect(codes(brief({}, small), home)).toContain("small_restock_trip");
		const big = { heroes: [hero(1, 60, away)], towns: [town({ garrison: 40 })] };
		expect(codes(brief({}, big), home)).not.toContain("small_restock_trip");
	});

	it("flags a hire that makes a third hero", () => {
		const b = brief({}, { heroes: [hero(1), hero(2, 3, { x: 9, y: 9, z: 0 })] });
		expect(codes(b, decision({ hire: [{ town: 1, hero: 77, why: "flag mines in the far east" }] }))).toContain("many_heroes");
		expect(codes(brief(), decision({ hire: [{ town: 1, hero: 77, why: "flag mines in the far east" }] }))).not.toContain("many_heroes");
	});

	it("flags unspent wood unless the memory says what it is for", () => {
		const rich = { resources: res({ gold: 100, wood: 161 }) };
		expect(codes(brief({}, rich), decision())).toContain("idle_resources");
		const memory = { goal: "g", next: "build the castle chain, needs wood", deferred: [] };
		expect(codes(brief({ memory }, rich), decision())).not.toContain("idle_resources");
	});

	it("flags idle gold only when the plan has nothing affordable to buy", () => {
		const plan = { madeOnDay: 1, reviewByDay: 9, reserves: [], towns: [{ town: 1, build: [{ building: "core:castle", onShortage: "wait" }], recruit: { mode: "none" } }] };
		const stuck = { resources: res({ gold: 6000 }), towns: [town({ options: [{ building: "core:castle", state: "no_resources", cost: res({ gold: 5000, wood: 10 }), missing: ["wood"] }] })] };
		expect(codes(brief({ plan }, stuck), decision())).toContain("idle_gold");
		const ok = { resources: res({ gold: 6000 }), towns: [town({ options: [{ building: "core:castle", state: "allowed", cost: res({ gold: 5000 }), missing: [] }] })] };
		expect(codes(brief({ plan }, ok), decision())).not.toContain("idle_gold");
	});

	it("flags a fight at poor odds and a walk toward a stronger enemy hero", () => {
		const target = { x: 9, y: 9, z: 0 };
		const site = { id: 5, name: "Wolf Riders", type: "monster", subtype: "", pos: target, owner: -2, steps: 5, turns: 0, size: "20-49", threat: "much stronger", strengthRatio: 1.8 };
		const b = brief({ sites: { 1: [site] } });
		expect(codes(b, decision({ missions: [{ hero: 1, target, intent: "attack", allowFight: true }] }))).toContain("bad_odds");
		const enemy = { type: "hero", ownerColor: "blue", name: "Gem", strengthRatio: 1.6, pos: { x: 11, y: 9, z: 0 }, tilesToNearestOwnTown: 30 };
		expect(codes(brief({}, { threats: [enemy] }), decision({ missions: [{ hero: 1, target, intent: "explore" }] }))).toContain("toward_enemy");
	});
});

describe("army left in the garrison", () => {
	const hero = (id: number, units: number) => ({ id, name: "Verdish", class: "", level: 6, pos: { x: 5, y: 5, z: 0 }, movement: 1500, army: [{ creature: "core:imp", count: units, slot: 0 }], primarySkills: {} });
	const home = { id: 1, name: "Home", faction: "core:inferno", pos: { x: 5, y: 5, z: 0 }, builtThisTurn: false, hasVisitingHero: false, hasGarrisonHero: false, buildings: [], options: [], recruitable: [], tavern: [], garrison: 215, garrisonArmy: [{ creature: "core:imp", count: 215 }] };
	const b = (heroes: unknown[]) => ({
		facts: { day: 40, week: 6, dayOfWeek: 5, resources: {}, incomeSinceLastTurn: undefined, towns: [home], heroes, threats: [], game: { player: "red", mapSize: undefined }, mines: { owned: [], others: [] }, rankings: undefined },
		plan: undefined, sites: {}, blockers: [], journal: [], deviations: [], messages: [], events: [], memory: undefined,
	}) as unknown as Brief;
	const d = (merge: Array<{ from: number; to: number }> = []) => ({ note: "n", missions: [], hire: [], merge }) as unknown as Decision;

	it("tells the king the exact merge order when a big garrison sits next to a small army", () => {
		const [finding] = reviewDecision(b([hero(9, 35)]), d());
		expect(finding?.code).toBe("army_at_home");
		expect(finding?.text).toContain('merge: [{ "from": 1, "to": 9 }]');
	});

	it("is quiet once the merge is ordered or the hero already carries the army", () => {
		expect(reviewDecision(b([hero(9, 35)]), d([{ from: 1, to: 9 }])).map(f => f.code)).not.toContain("army_at_home");
		expect(reviewDecision(b([hero(9, 400)]), d()).map(f => f.code)).not.toContain("army_at_home");
	});
});
