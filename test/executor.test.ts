import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { executePlan } from "../src/executor.js";
import type { EconomyFacts, TownFacts } from "../src/facts.js";
import { parsePlan } from "../src/plan.js";
import type { Resources } from "../src/state.js";
import { startFakeBridge } from "./fakeBridge.js";

const res = (r: Partial<Resources> = {}): Resources => ({ wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0, ...r });
const option = (building: string, cost: Partial<Resources>, state = "allowed") => ({ building, name: building, state, cost: res(cost), missing: [] });
const stock = (level: number, creature: string, available: number, gold: number) => ({ level, creature, name: creature, available, cost: res({ gold }) });

function town(id: number, extra: Partial<TownFacts> = {}): TownFacts {
	return { id, name: `T${id}`, faction: "core:inferno", builtThisTurn: false, hasVisitingHero: false, hasGarrisonHero: false, buildings: [], options: [], recruitable: [], ...extra };
}
function facts(towns: TownFacts[], gold: number, extra: Partial<Resources> = {}): EconomyFacts {
	return { day: 3, week: 1, dayOfWeek: 3, resources: res({ gold, ...extra }), incomeSinceLastTurn: undefined, towns, heroes: [] };
}

let cleanup: Array<() => unknown> = [];
afterEach(async () => { for(const fn of cleanup.reverse()) await fn(); cleanup = []; });

async function run(planJson: unknown, f: EconomyFacts, handler: (cmd: string, args: any) => unknown = () => ({})) {
	const calls: Array<{ cmd: string; args: any }> = [];
	const server = await startFakeBridge((cmd, args) => { calls.push({ cmd, args }); return handler(cmd, args); });
	const bridge = new BridgeClient({ port: server.port });
	cleanup.push(() => bridge.close(), server.close);
	return { report: await executePlan(bridge, parsePlan(planJson), f), calls };
}

describe("parsePlan", () => {
	it("rejects levels mode without levels and names the field", () => {
		expect(() => parsePlan({ madeOnDay: 1, reviewByDay: 8, towns: [{ town: 1, recruit: { mode: "levels" } }] })).toThrow("towns.0.recruit");
	});
});

describe("executePlan", () => {
	it("builds only what the plan names, in plan order", async () => {
		const t = town(1, { options: [option("core:citadel", { gold: 2500 }), option("core:marketplace", { gold: 500 })] });
		const { report } = await run({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, build: [{ building: "core:citadel" }, { building: "core:marketplace" }] }] }, facts([t], 5000));
		expect(report.built).toEqual([{ town: 1, building: "core:citadel" }]);
	});

	it("accepts building keys without the mod prefix and reports names that match nothing", async () => {
		const t = town(1, { buildings: ["core:fort"], options: [option("core:marketplace", { gold: 500 })] });
		const { report } = await run({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, build: [{ building: "fort" }, { building: "marketplce" }, { building: "marketplace" }] }] }, facts([t], 1000));
		expect(report.built).toEqual([{ town: 1, building: "core:marketplace" }]);
		expect(report.deviations).toEqual([{ kind: "unknown_building", town: 1, building: "marketplce" }]);
	});

	it("saves for a planned building when gold is short, unless the step says skip", async () => {
		const t = town(1, { options: [option("core:castle", { gold: 5000 }, "no_resources"), option("core:tavern", { gold: 500 })] });
		const plan = (onShortage: string) => ({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, build: [{ building: "core:castle", onShortage }, { building: "core:tavern" }] }] });
		expect((await run(plan("wait"), facts([t], 1000))).report.built).toEqual([]);
		expect((await run(plan("skip"), facts([t], 1000))).report.built).toEqual([{ town: 1, building: "core:tavern" }]);
	});

	it("reports a rare-resource block to the king and moves on", async () => {
		const t = town(1, { options: [option("core:mageGuild1", { gold: 2000, wood: 5 }, "no_resources"), option("core:tavern", { gold: 500 })] });
		const { report } = await run({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, build: [{ building: "core:mageGuild1" }, { building: "core:tavern" }] }] }, facts([t], 5000));
		expect(report.deviations).toContainEqual({ kind: "blocked_by_resource", town: 1, building: "core:mageGuild1", missing: ["wood"] });
		expect(report.built).toEqual([{ town: 1, building: "core:tavern" }]);
	});

	it("keeps reserved gold out of recruiting but lets a build use it", async () => {
		const t = town(1, { options: [option("core:capitol", { gold: 3000 })], recruitable: [stock(0, "core:imp", 100, 50)] });
		const plan = (towns: object[]) => ({ madeOnDay: 1, reviewByDay: 9, reserves: [{ label: "capitol", amount: { gold: 3000 } }], towns });
		const recruiting = await run(plan([{ town: 1, recruit: { mode: "all" } }]), facts([town(1, { recruitable: t.recruitable })], 3500));
		expect(recruiting.report.recruited).toEqual([{ town: 1, creature: "core:imp", count: 10 }]);
		const building = await run(plan([{ town: 1, build: [{ building: "core:capitol", usesReserve: "capitol" }], recruit: { mode: "all" } }]), facts([t], 3500));
		expect(building.report.built).toEqual([{ town: 1, building: "core:capitol" }]);
		expect(building.report.recruited).toEqual([{ town: 1, creature: "core:imp", count: 10 }]);
	});

	it("does not let another build spend a reserved amount", async () => {
		const t = town(1, { options: [option("core:tavern", { gold: 500 }), option("core:dwellingLvl7", { gold: 3000, sulfur: 10 })] });
		const plan = (build: object[]) => ({ madeOnDay: 1, reviewByDay: 9, reserves: [{ label: "dragons", amount: { gold: 3000, sulfur: 10 } }], towns: [{ town: 1, build }] });
		const f = facts([t], 3200, { sulfur: 10 });
		expect((await run(plan([{ building: "core:tavern", onShortage: "skip" }]), f)).report.built).toEqual([]);
		expect((await run(plan([{ building: "core:dwellingLvl7", usesReserve: "dragons" }]), f)).report.built).toEqual([{ town: 1, building: "core:dwellingLvl7" }]);
	});

	it("recruits only the listed levels, and nothing in none mode", async () => {
		const t = town(1, { recruitable: [stock(0, "core:imp", 10, 50), stock(1, "core:gog", 10, 100)] });
		const plan = (recruit: object) => ({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, recruit }] });
		expect((await run(plan({ mode: "levels", levels: [1] }), facts([t], 10000))).report.recruited).toEqual([{ town: 1, creature: "core:gog", count: 10 }]);
		expect((await run(plan({ mode: "none" }), facts([t], 10000))).report.recruited).toEqual([]);
	});

	it("serves towns in plan order from one treasury", async () => {
		const a = town(1, { options: [option("core:citadel", { gold: 2500 })] });
		const b = town(2, { options: [option("core:citadel", { gold: 2500 })] });
		const plan = (order: number[]) => ({ madeOnDay: 1, reviewByDay: 9, towns: order.map(id => ({ town: id, build: [{ building: "core:citadel" }] })) });
		expect((await run(plan([2, 1]), facts([a, b], 3000))).report.built).toEqual([{ town: 2, building: "core:citadel" }]);
	});

	it("flags an expired plan, unplanned towns and towns the plan names but we no longer own", async () => {
		const { report } = await run({ madeOnDay: 1, reviewByDay: 2, towns: [{ town: 9 }] }, facts([town(1)], 0));
		expect(report.deviations).toEqual(expect.arrayContaining([
			{ kind: "plan_expired", reviewByDay: 2 }, { kind: "town_without_plan", town: 1 }, { kind: "plan_town_missing", town: 9 },
		]));
	});

	it("turns a server rejection into a deviation instead of failing the turn", async () => {
		const t = town(1, { options: [option("core:tavern", { gold: 500 })] });
		const { report } = await run({ madeOnDay: 1, reviewByDay: 9, towns: [{ town: 1, build: [{ building: "core:tavern" }] }] }, facts([t], 1000), () => { throw new Error("built today"); });
		expect(report.built).toEqual([]);
		expect(report.deviations).toEqual([{ kind: "rejected", town: 1, action: "build core:tavern", error: "built today" }]);
	});
});
