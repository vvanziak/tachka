import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { chooseBuilding, economyRoutine } from "../src/routines.js";
import type { Buildable, Resources } from "../src/state.js";
import { startFakeBridge } from "./fakeBridge.js";

const res = (r: Partial<Resources> = {}): Resources => ({ wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0, ...r });
const option = (building: string, state: string, cost: Partial<Resources>): Buildable => ({ building, name: building, state, cost: res(cost) });

describe("chooseBuilding", () => {
	it("takes the first affordable chain building", () => {
		const options = [option("core:citadel", "allowed", { gold: 2500 }), option("core:marketplace", "allowed", { gold: 500 })];
		expect(chooseBuilding(options, res({ gold: 5000 }))?.building).toBe("core:marketplace");
	});

	it("saves gold instead of buying a lower-priority building", () => {
		const options = [option("core:marketplace", "no_resources", { gold: 500 }), option("core:dwellingLvl1", "allowed", { gold: 300 })];
		expect(chooseBuilding(options, res({ gold: 400 }))).toBeUndefined();
	});

	it("does not wait for a rare resource that gold cannot buy", () => {
		const options = [option("core:blacksmith", "no_resources", { gold: 1000, ore: 5 }), option("core:dwellingLvl1", "allowed", { gold: 300 })];
		expect(chooseBuilding(options, res({ gold: 5000 }))?.building).toBe("core:dwellingLvl1");
	});

	it("falls back to the lowest-level affordable dwelling when the chain is done", () => {
		const options = [option("core:dwellingLvl3", "allowed", { gold: 800 }), option("core:dwellingLvl1", "allowed", { gold: 300 })];
		expect(chooseBuilding(options, res({ gold: 5000 }))?.building).toBe("core:dwellingLvl1");
	});
});

describe("economyRoutine", () => {
	it("builds, then recruits the highest level first within the remaining gold", async () => {
		let gold = 1000;
		const calls: Array<[string, unknown]> = [];
		const server = await startFakeBridge((cmd, args) => {
			calls.push([cmd, args]);
			if(cmd === "get_state")
				return {
					day: 1, resources: res({ gold }),
					towns: [{
						id: 11, name: "T", faction: "core:inferno", builtThisTurn: calls.some(c => c[0] === "build"), visitingHero: -1, garrisonHero: -1, buildings: [],
						recruitable: [
							{ level: 0, creature: "core:imp", name: "Imp", available: 10, cost: res({ gold: 50 }) },
							{ level: 1, creature: "core:gog", name: "Gog", available: 5, cost: res({ gold: 100 }) },
						],
					}],
				};
			if(cmd === "get_buildable")
				return [option("core:marketplace", "allowed", { gold: 500 })];
			if(cmd === "build") { gold -= 500; return {}; }
			return {};
		});
		const bridge = new BridgeClient({ port: server.port });
		const report = await economyRoutine(bridge);
		bridge.close();
		await server.close();

		expect(report.built).toEqual([{ town: 11, building: "core:marketplace" }]);
		expect(report.recruited).toEqual([{ town: 11, creature: "core:gog", count: 5 }]);
	});
});
