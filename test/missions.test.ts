import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { collectSites, fightCandidates, goTo, type Site } from "../src/missions.js";
import { startFakeBridge } from "./fakeBridge.js";

let cleanup: Array<() => unknown> = [];
afterEach(async () => { for(const fn of cleanup.reverse()) await fn(); cleanup = []; });

async function connect(handler: (cmd: string, args: any) => unknown) {
	const calls: Array<{ cmd: string; args: any }> = [];
	const server = await startFakeBridge((cmd, args) => { calls.push({ cmd, args }); return handler(cmd, args); });
	const bridge = new BridgeClient({ port: server.port });
	cleanup.push(() => bridge.close(), server.close);
	return { bridge, calls };
}

describe("goTo", () => {
	it("asks the bridge to stop in front of guards unless a fight is intended", async () => {
		const { bridge, calls } = await connect(() => ({ reached: false, pos: { x: 1, y: 1, z: 0 }, movement: 500, status: { pendingQuestions: [] } }));
		await goTo(bridge, 7, { x: 5, y: 5, z: 0 });
		await goTo(bridge, 7, { x: 5, y: 5, z: 0 }, { allowFight: true });
		expect(calls[0]?.args).toMatchObject({ hero: 7, x: 5, y: 5, z: 0, avoidGuards: true });
		expect(calls[1]?.args.avoidGuards).toBeUndefined();
	});

	it("reports the guard and pending questions the bridge returned", async () => {
		const guard = { id: 90, name: "Hell Hounds", pos: { x: 3, y: 2, z: 0 } };
		const { bridge } = await connect(() => ({
			reached: false, stopped: "guarded", guard, pos: { x: 2, y: 2, z: 0 }, movement: 800,
			status: { pendingQuestions: [{ id: 4, kind: "dialog" }] },
		}));
		expect(await goTo(bridge, 7, { x: 9, y: 2, z: 0 })).toEqual({
			reached: false, stopped: "guarded", guard, pos: { x: 2, y: 2, z: 0 }, movement: 800, pendingQuestions: [{ id: 4, kind: "dialog" }],
		});
	});
});

describe("collectSites", () => {
	it("passes the hero and limit and returns the target list", async () => {
		const sites = [{ id: 1, type: "mine", subtype: "sawmill", name: "Sawmill", pos: { x: 3, y: 3, z: 0 }, owner: -1, steps: 6, turns: 0 }];
		const { bridge, calls } = await connect(() => sites);
		expect(await collectSites(bridge, 7, 10)).toEqual(sites);
		expect(calls[0]).toEqual({ cmd: "targets", args: { hero: 7, limit: 10 } });
	});
});

describe("fightCandidates", () => {
	const site = (id: number, type: string, x: number, ratio?: number): Site => ({ id, type, subtype: type, name: `${type}${id}`, pos: { x, y: 0, z: 0 }, owner: -2, steps: x, turns: 1, strengthRatio: ratio, threat: ratio === undefined ? undefined : "t", size: "1-4" });

	it("lists the easiest stacks first and names what stands next to them", () => {
		const found = fightCandidates([site(1, "monster", 10, 0.9), site(2, "monster", 20, 0.2), site(3, "mine", 21), site(4, "chest", 40)]);
		expect(found.map(f => f.guard.id)).toEqual([2, 1]);
		expect(found[0]?.behind.map(b => b.id)).toEqual([3]);
		expect(found[1]?.behind).toEqual([]);
	});
});
