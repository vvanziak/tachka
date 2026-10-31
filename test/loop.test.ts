import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBlockers, siteResource } from "../src/blockers.js";
import { Tachka } from "../src/core.js";
import type { EconomyFacts } from "../src/facts.js";
import { defaultAnswer } from "../src/questions.js";
import { Journal } from "../src/journal.js";
import { ScriptedKing } from "../src/king.js";
import { nextTurn } from "../src/turn.js";
import { loadLoopState, newLoopState, playGame, playTurn, saveLoopState } from "../src/loop.js";
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

describe("loop state", () => {
	it("survives a restart: plan, treasury and turn counter", () => {
		const path = join(mkdtempSync(join(tmpdir(), "tachka-")), "state.json");
		const state = newLoopState();
		state.turn = 12;
		state.previousEnd = res({ gold: 900 });
		state.plan = { madeOnDay: 3, reviewByDay: 9, reserves: [], towns: [{ town: 1, build: [{ building: "core:tavern", onShortage: "wait" }], recruit: { mode: "all" } }] };
		saveLoopState(path, state);
		expect(loadLoopState(path)).toEqual({ ...state, deviations: [] });
		expect(loadLoopState(join(tmpdir(), "does-not-exist.json")).turn).toBe(0);
	});
});

describe("a fight during a mission", () => {
	it("is fought out and the walk resumes before the turn ends", async () => {
		const calls: string[] = [];
		let fought = false;
		const server = await startFakeBridge((cmd, args: any) => {
			calls.push(cmd);
			switch(cmd) {
			case "get_state":
				return {
					day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 100 }), towns: [],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, army: [], primarySkills: {} }],
				};
			case "targets":
				return [site(62, "mine", "sawmill", "Sawmill", 0)];
			case "status":
				return { pendingQuestions: [] };
			case "move_hero":
				return fought
					? { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 800, status: { pendingQuestions: [] } }
					: { reached: false, stopped: "battle waiting for orders", pos: { x: 3, y: 3, z: 0 }, movement: 900, status: { pendingQuestions: [] } };
			case "battle_act":
				fought = true;
				return { battleOver: true };
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			default:
				return {};
			}
		});
		const tachka = new Tachka({ port: server.port });
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);

		await playTurn({ tachka, king: new ScriptedKing(), journal, memoryDays: 5 }, newLoopState());
		expect(calls.indexOf("battle_act")).toBeGreaterThan(calls.indexOf("move_hero"));
		expect(calls.indexOf("battle_act")).toBeLessThan(calls.indexOf("end_turn"));
		expect(calls.filter(c => c === "move_hero")).toHaveLength(2);
	});
});

describe("nextTurn", () => {
	it("fights a running battle when end_turn is refused, then ends the turn", async () => {
		const calls: string[] = [];
		let battle = true;
		const server = await startFakeBridge(cmd => {
			calls.push(cmd);
			if(cmd === "end_turn" && battle)
				throw new Error("a battle is in progress: finish it first (battle_act)");
			if(cmd === "battle_act")
				battle = false;
			return cmd === "wait_for_turn" ? { yourTurn: true, battle: false } : {};
		});
		const tachka = new Tachka({ port: server.port });
		cleanup.push(() => tachka.bridge.close(), server.close);
		await nextTurn(tachka.bridge);
		expect(calls).toEqual(["end_turn", "battle_act", "end_turn", "wait_for_turn"]);
	});
});

describe("defaultAnswer", () => {
	it("declines unrequested fights and paid experience, accepts recruit prompts; fights when the mission says so", () => {
		const dialog = (text: string) => ({ id: 1, kind: "dialog", text });
		expect(defaultAnswer(dialog("Much to your dismay, the Monastery is guarded by several Monks.\n\nDo you wish to fight the guards?"))).toBe(0);
		expect(defaultAnswer(dialog("Much to your dismay, the Monastery is guarded by several Monks.\n\nDo you wish to fight the guards?"), { allowFight: true })).toBe(1);
		expect(defaultAnswer(dialog("{Monastery}\n\nWould you like to recruit Monks?"))).toBe(1);
		expect(defaultAnswer(dialog("{Tree of Knowledge}\n\nUpon your approach, the tree opens its eyes in delight."))).toBe(0);
		expect(defaultAnswer(dialog("{Chest}\n\nYou may take the gold or distribute it to the peasants for experience."))).toBe(1);
	});
});

describe("recruiting at a dwelling on the map", () => {
	async function visit(armyCreatures: string[], gold: number) {
		const calls: Array<{ cmd: string; args: any }> = [];
		let phase = 0;
		const server = await startFakeBridge((cmd, args: any) => {
			calls.push({ cmd, args });
			switch(cmd) {
			case "get_state":
				return {
					day: 3, week: 1, dayOfWeek: 3, resources: res({ gold }), towns: [],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, army: armyCreatures.map((creature, slot) => ({ creature, count: 5, slot })), primarySkills: {} }],
				};
			case "targets":
				return [site(62, "creatureGeneratorCommon", "", "Monastery", 0)];
			case "move_hero":
				return phase === 0
					? { reached: false, stopped: "question pending", pos: { x: 0, y: 0, z: 0 }, movement: 900, status: { pendingQuestions: [{ id: 1, kind: "dialog", text: "{Monastery}\n\nWould you like to recruit Monks?" }] } }
					: { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 800, status: { pendingQuestions: [] } };
			case "status":
				return { pendingQuestions: phase === 0 && calls.some(c => c.cmd === "move_hero")
					? [{ id: 1, kind: "dialog", text: "{Monastery}\n\nWould you like to recruit Monks?" }]
					: phase === 1 ? [{ id: 2, kind: "recruitment", object: 90, recruitable: [
						{ level: 1, creature: "core:monk", name: "Monk", available: 10, cost: res({ gold: 100 }) },
					] }] : [] };
			case "answer_question":
				phase++;
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
		await playTurn({ tachka, king: new ScriptedKing(), journal, memoryDays: 5 }, newLoopState());
		return { calls, journal };
	}

	it("buys as many as the gold allows for the visiting hero and closes the window", async () => {
		const { calls } = await visit(["core:pikeman"], 450);
		expect(calls.find(c => c.cmd === "recruit")?.args).toEqual({ object: 90, hero: 5, creature: "core:monk", count: 4 });
		expect(calls.filter(c => c.cmd === "answer_question").map(c => c.args)).toEqual([{ id: 1, choice: 1 }, { id: 2, choice: 0 }]);
	});

	it("leaves a new creature alone when all seven slots hold other creatures, and says so", async () => {
		const full = ["a", "b", "c", "d", "e", "f", "g"].map(x => `core:${x}`);
		const { calls, journal } = await visit(full, 5000);
		expect(calls.some(c => c.cmd === "recruit")).toBe(false);
		expect(journal.tail(3, 1)[0]?.deviations).toContainEqual({ kind: "army_full", hero: 5, creature: "core:monk", available: 10 });
	});
});

describe("playGame failures", () => {
	it("ends the turn after a failed one and gives up after three in a row", async () => {
		const calls: string[] = [];
		const server = await startFakeBridge(cmd => {
			calls.push(cmd);
			if(cmd === "get_state")
				throw new Error("state unavailable");
			return cmd === "wait_for_turn" ? { yourTurn: true, battle: false } : cmd === "status" ? { pendingQuestions: [] } : {};
		});
		const tachka = new Tachka({ port: server.port });
		const problems: string[] = [];
		tachka.subscribe(e => e.type === "problem" && problems.push(e.text));
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);

		const state = await playGame({ tachka, king: new ScriptedKing(), journal, memoryDays: 5 });
		expect(state.turn).toBe(3);
		expect(problems).toHaveLength(3);
		expect(calls.filter(c => c === "end_turn")).toHaveLength(2);
	});
});

describe("the end of the game", () => {
	const quietKing = new ScriptedKing();
	const newJournal = () => new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));

	it("stops cleanly when the bridge reports game over, without a problem message", async () => {
		const server = await startFakeBridge(cmd => cmd === "wait_for_turn" ? { yourTurn: false, battle: false, gameOver: true } : {});
		const tachka = new Tachka({ port: server.port });
		const problems: string[] = [];
		tachka.subscribe(e => e.type === "problem" && problems.push(e.text));
		cleanup.push(() => tachka.bridge.close(), server.close);
		const state = await playGame({ tachka, king: quietKing, journal: newJournal(), memoryDays: 5 });
		expect(state.ended).toBe("game over");
		expect(problems).toEqual([]);
	});

	it("treats a closed client as the end, not as three failed turns", async () => {
		const server = await startFakeBridge(() => ({}));
		await server.close();
		const tachka = new Tachka({ port: server.port });
		const problems: string[] = [];
		tachka.subscribe(e => e.type === "problem" && problems.push(e.text));
		const state = await playGame({ tachka, king: quietKing, journal: newJournal(), memoryDays: 5 });
		expect(state.ended).toBe("connection lost");
		expect(problems).toEqual([]);
	});
});

describe("Talker", () => {
	it("answers a human message at once, shows typing, and leaves a note for the king", async () => {
		const { Talker } = await import("../src/talker.js");
		const brain = {
			name: "fake",
			complete: async () => { throw new Error("not used"); },
			say: async (_system: string, user: string) => ({ text: user.includes("Spider Hill") ? "Heading there next." : "?", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }),
		};
		const tachka = new Tachka({ port: 1 });
		const events: string[] = [];
		tachka.subscribe(e => events.push(e.type === "chat" ? `${e.from}:${e.text}` : e.type === "typing" ? `typing:${e.on}` : e.type));
		new Talker(tachka, brain, () => "Phase: waiting for the other players' turn.");
		tachka.say("what about Spider Hill?");
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(events).toEqual(["human:what about Spider Hill?", "typing:true", "king:Heading there next.", "typing:false"]);
		expect(tachka.drainInbox()).toEqual(["what about Spider Hill?", "(already answered in chat: Heading there next.)"]);
	});
});

describe("hiring", () => {
	it("reports a hire the server did not carry out", async () => {
		const server = await startFakeBridge(cmd => {
			switch(cmd) {
			case "get_state":
				return { day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 5000 }), towns: [], heroes: [] };
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			case "status":
				return { pendingQuestions: [] };
			default:
				return {};
			}
		});
		const tachka = new Tachka({ port: server.port });
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);
		const king = { async decide() { return { note: "hire", missions: [], hire: [{ town: 1, hero: 77, why: "flag the far mines in the east" }], merge: [] }; } };
		await playTurn({ tachka, king, journal, memoryDays: 5 }, newLoopState());
		const entry = journal.tail(3, 1)[0];
		expect(entry?.deviations).toContainEqual({ kind: "hire_failed", hero: 77, town: 1 });
		expect(entry?.orders?.hire).toEqual([{ town: 1, hero: 77, why: "flag the far mines in the east" }]);
	});
});

describe("nextTurn at the end of the game", () => {
	it("returns instead of waiting forever when the bridge reports game over", async () => {
		let waits = 0;
		const server = await startFakeBridge(cmd => {
			if(cmd === "wait_for_turn") {
				waits++;
				return { yourTurn: false, battle: false, gameOver: true };
			}
			return {};
		});
		const tachka = new Tachka({ port: server.port });
		cleanup.push(() => tachka.bridge.close(), server.close);
		expect(await nextTurn(tachka.bridge)).toBe(false);
		expect(waits).toBe(1);
	});
});
