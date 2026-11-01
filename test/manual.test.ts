import { describe, expect, it } from "vitest";
import type { EconomyFacts } from "../src/facts.js";
import type { Decision } from "../src/king.js";
import { applyManual, parseManual } from "../src/manual.js";

const facts = {
	heroes: [{ id: 576, name: "Tamika", pos: { x: 4, y: 12, z: 0 } }, { id: 645, name: "Galthran", pos: { x: 7, y: 18, z: 0 } }],
	towns: [{ id: 36, name: "Haunt's Wind", pos: { x: 7, y: 18, z: 0 } }],
} as unknown as EconomyFacts;
const decision = { note: "n", missions: [{ hero: 576, target: { x: 3, y: 13, z: 0 }, intent: "fight" }, { hero: 645, target: { x: 4, y: 13, z: 0 }, intent: "walk" }], hire: [], merge: [], trade: [], hold: [] } as Decision;

describe("manual orders", () => {
	it("reads the emergency commands", () => {
		expect(parseManual("!retreat")).toEqual({ kind: "retreat" });
		expect(parseManual("!hold")).toEqual({ kind: "hold", hero: undefined });
		expect(parseManual("!hold Tamika")).toEqual({ kind: "hold", hero: "Tamika" });
		expect(parseManual("!go Sir Mullich 5 6 fight")).toEqual({ kind: "go", hero: "Sir Mullich", target: { x: 5, y: 6, z: 0 }, fight: true });
		expect(parseManual("!dance")).toBeUndefined();
	});

	it("retreat replaces the missions and holds every hero", () => {
		const { decision: d, done } = applyManual(decision, [{ kind: "retreat" }], facts);
		expect(d.missions).toEqual([{ hero: 576, target: { x: 7, y: 18, z: 0 }, intent: "retreat to town (human's order)" }]);
		expect(d.hold.sort()).toEqual([576, 645]);
		expect(done).toEqual(["Tamika retreats to Haunt's Wind", "Galthran retreats to Haunt's Wind"]);
	});

	it("holds one hero by a name prefix and sends another to a tile", () => {
		const { decision: d } = applyManual(decision, [{ kind: "hold", hero: "tam" }, { kind: "go", hero: "645", target: { x: 9, y: 9, z: 0 }, fight: false }], facts);
		expect(d.missions).toEqual([{ hero: 645, target: { x: 9, y: 9, z: 0 }, intent: "human's order" }]);
		expect(d.hold.sort()).toEqual([576, 645]);
	});
});
