import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Tachka } from "../src/core.js";
import { Journal } from "../src/journal.js";
import { ScriptedKing } from "../src/king.js";
import { newLoopState, playTurn } from "../src/loop.js";
import { TracedBrain, Trace } from "../src/trace.js";
import { startFakeBridge } from "./fakeBridge.js";

let cleanup: Array<() => unknown> = [];
afterEach(async () => { for(const fn of cleanup.reverse()) await fn(); cleanup = []; });

describe("Trace", () => {
	it("writes one file per step of a turn, named by day and step", async () => {
		const server = await startFakeBridge(cmd => {
			switch(cmd) {
			case "get_state":
				return {
					day: 7, week: 1, dayOfWeek: 7, resources: { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 100 },
					towns: [{ id: 11, name: "T", faction: "core:inferno", pos: { x: 0, y: 0, z: 0 }, builtThisTurn: false, visitingHero: 5, garrisonHero: -1, buildings: [], recruitable: [] }],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, army: [], primarySkills: {} }],
				};
			case "get_buildable": return [];
			case "targets": return [];
			case "wait_for_turn": return { yourTurn: true, battle: false };
			default: return {};
			}
		});
		const dir = mkdtempSync(join(tmpdir(), "tachka-trace-"));
		const trace = new Trace(join(dir, "turns"));
		const tachka = new Tachka({ port: server.port, onExchange: x => trace.exchange(x) });
		cleanup.push(() => tachka.bridge.close(), server.close);

		await playTurn({ tachka, king: new ScriptedKing(), journal: new Journal(join(dir, "journal.jsonl")), memoryDays: 5, trace }, newLoopState());

		expect(readdirSync(join(dir, "turns"))).toEqual([
			"007.1-dialogs.json", "007.2-facts.json", "007.3-brief.md", "007.4-decision.json",
			"007.5-review.json", "007.6-orders.json", "007.7-record.json", "007.8-end.json",
		]);
		const facts = JSON.parse(readFileSync(join(dir, "turns", "007.2-facts.json"), "utf8"));
		expect(facts.data.facts.day).toBe(7);
		expect(facts.calls.map((c: { cmd: string }) => c.cmd)).toContain("get_state");
		expect(readFileSync(join(dir, "turns", "007.3-brief.md"), "utf8")).toContain("REACHABLE SITES");
	});
});

describe("TracedBrain", () => {
	it("writes the full request and the answer of every model call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tachka-trace-"));
		const trace = new Trace(dir);
		trace.begin(12);
		const brain = new TracedBrain({
			name: "fake",
			complete: async () => ({ json: { ask: [] }, usage: { inputTokens: 5, outputTokens: 1, costUsd: 0 } }),
			say: async () => ({ text: "hi", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }),
		}, trace, "king");
		await brain.complete("SYS", "USER TEXT", { type: "object" });
		expect(readdirSync(dir)).toEqual(["012.4.1-king-request.md", "012.4.1-king-response.json"]);
		const request = readFileSync(join(dir, "012.4.1-king-request.md"), "utf8");
		expect(request).toContain("SYS");
		expect(request).toContain("USER TEXT");
		expect(JSON.parse(readFileSync(join(dir, "012.4.1-king-response.json"), "utf8")).usage.inputTokens).toBe(5);
	});
});
