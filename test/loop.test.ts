import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBlockers, siteResource } from "../src/blockers.js";
import { Tachka } from "../src/core.js";
import type { EconomyFacts } from "../src/facts.js";
import { Journal } from "../src/journal.js";
import { ScriptedKing } from "../src/king.js";
import { newLoopState, playTurn } from "../src/loop.js";
import type { Site } from "../src/missions.js";
import type { Resources } from "../src/state.js";
import { startFakeBridge } from "./fakeBridge.js";

const res = (r: Partial<Resources> = {}): Resources => ({ wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0, ...r });
const site = (id: number, type: string, subtype: string, name: string, turns: number, extra: Partial<Site> = {}): Site =>
	({ id, type, subtype, name, pos: { x: id, y: id, z: 0 }, owner: -1, steps: turns * 10, turns, ...extra });

let cleanup: Array<() => unknown> = [];
afterEach(async () => { for(const fn of cleanup.reverse()) await fn(); cleanup = []; });

describe("siteResource", () => {
	it("reads a mine by subtype and a pile by name", () => {
		expect(siteResource(site(1, "mine", "sawmill", "Sawmill", 0))).toBe("wood");
		expect(siteResource(site(2, "resource", "", "Ore", 0))).toBe("ore");
		expect(siteResource(site(3, "magicWell", "", "Magic Well", 0))).toBeUndefined();
	});
});

describe("collectBlockers", () => {
	it("lists the missing amount and the nearest supplier first", () => {
		const facts = {
			resources: res({ gold: 5000, wood: 0, ore: 10 }),
			towns: [{ id: 1, options: [
				{ building: "core:mageGuild1", name: "", state: "no_resources", cost: res({ gold: 2000, wood: 5, ore: 5 }), missing: ["wood"] },
				{ building: "core:tavern", name: "", state: "allowed", cost: res({ gold: 500 }), missing: [] },
			] }],
		} as unknown as EconomyFacts;
		const far = site(7, "resource", "", "Wood", 2);
		const near = site(8, "mine", "sawmill", "Sawmill", 0);
		const [blocker] = collectBlockers(facts, [far, near, site(9, "magicWell", "", "Magic Well", 0)]);
		expect(blocker).toMatchObject({ town: 1, building: "core:mageGuild1", short: { wood: 5 } });
		expect(blocker?.suppliers.map(s => s.site.id)).toEqual([8, 7]);
	});
});

describe("playTurn", () => {
	it("builds, sends the hero to the supplier of a blocked resource, journals the turn and ends it", async () => {
		const calls: string[] = [];
		const server = await startFakeBridge((cmd, args) => {
			calls.push(cmd);
			switch(cmd) {
			case "get_state":
				return {
					day: 2, week: 1, dayOfWeek: 2, resources: res({ gold: 3000, ore: 10 }),
					towns: [{ id: 11, name: "T", faction: "core:inferno", builtThisTurn: false, visitingHero: 5, garrisonHero: -1, buildings: [], recruitable: [] }],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, army: [], primarySkills: {} }],
				};
			case "get_buildable":
				return [
					{ building: "core:mageGuild1", name: "", state: "no_resources", cost: res({ gold: 2000, wood: 5 }) },
					{ building: "core:marketplace", name: "", state: "allowed", cost: res({ gold: 500 }) },
				];
			case "targets":
				return [site(62, "mine", "sawmill", "Sawmill", 0), site(70, "monster", "familiar", "Familiars", 0, { threat: "weak" })];
			case "move_hero":
				return { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 900, status: { pendingQuestions: [] } };
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			default:
				return {};
			}
		});
		const tachka = new Tachka({ port: server.port });
		const file = join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl");
		const journal = new Journal(file);
		cleanup.push(() => tachka.bridge.close(), server.close);

		const state = newLoopState();
		expect(await playTurn({ tachka, king: new ScriptedKing(), journal, memoryDays: 5 }, state)).toBe(true);

		expect(calls).toContain("build");
		expect(calls).toContain("move_hero");
		expect(calls.at(-1)).toBe("wait_for_turn");
		const entry = JSON.parse(readFileSync(file, "utf8").trim());
		expect(entry.built).toEqual([{ town: 11, building: "core:marketplace" }]);
		expect(entry.moves).toEqual([{ hero: 5, target: { x: 62, y: 62, z: 0 }, intent: "Sawmill: wood for a blocked building", reached: true }]);
	});
});

describe("dialogs during a mission", () => {
	it("answers a dialog and the level-up it opens, then resumes the walk", async () => {
		const answered: number[] = [];
		let moves = 0;
		const server = await startFakeBridge((cmd, args: any) => {
			switch(cmd) {
			case "get_state":
				return {
					day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 100 }), towns: [],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, army: [], primarySkills: {} }],
				};
			case "targets":
				return [site(62, "treeOfKnowledge", "", "Tree of Knowledge", 0)];
			case "status":
				return { pendingQuestions: [[{ id: 23, kind: "dialog" }], [{ id: 24, kind: "level_up", choices: ["core:necromancy", "core:wisdom"] }], []][Math.min(answered.length, 2)] };
			case "end_turn":
				return {};
			case "move_hero":
				if(answered.length === 0)
					return { reached: false, stopped: "question pending", pos: { x: 0, y: 0, z: 0 }, movement: 900, status: { pendingQuestions: [{ id: 23, kind: "dialog" }] } };
				if(answered.length < 2)
					throw Object.assign(new Error("answer pending question 24 first (answer_question)"), { name: "BridgeError" });
				moves++;
				return { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 800, status: { pendingQuestions: [] } };
			case "answer_question":
				answered.push(args.id);
				return {};
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			default:
				return {};
			}
		});
		const tachka = new Tachka({ port: server.port });
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);

		const king = new ScriptedKing();
		expect(await playTurn({ tachka, king, journal, memoryDays: 5 }, newLoopState())).toBe(true);
		expect(answered).toEqual([23, 24]);
		expect(moves).toBe(1);
	});
});
