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
import { loadLoopState, lostHeroNotices, newLoopState, playGame, playTurn, saveLoopState } from "../src/loop.js";
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
					towns: [{ id: 11, name: "T", faction: "core:inferno", pos: { x: 0, y: 0, z: 0 }, builtThisTurn: false, visitingHero: 5, garrisonHero: -1, buildings: [], recruitable: [] }],
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
				return { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 100, status: { pendingQuestions: [] } };
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
					return { reached: false, stopped: "question pending", pos: { x: 0, y: 0, z: 0 }, movement: 100, status: { pendingQuestions: [{ id: 23, kind: "dialog" }] } };
				if(answered.length < 2)
					throw Object.assign(new Error("answer pending question 24 first (answer_question)"), { name: "BridgeError" });
				moves++;
				return { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 100, status: { pendingQuestions: [] } };
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
					? { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 100, status: { pendingQuestions: [] } }
					: { reached: false, stopped: "battle waiting for orders", pos: { x: 3, y: 3, z: 0 }, movement: 100, status: { pendingQuestions: [] } };
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
					? { reached: false, stopped: "question pending", pos: { x: 0, y: 0, z: 0 }, movement: 100, status: { pendingQuestions: [{ id: 1, kind: "dialog", text: "{Monastery}\n\nWould you like to recruit Monks?" }] } }
					: { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 100, status: { pendingQuestions: [] } };
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
		const king = { async decide() { return { note: "hire", missions: [], hire: [{ town: 1, hero: 77, why: "flag the far mines in the east" }], merge: [], trade: [], hold: [] }; } };
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

describe("review round", () => {
  it("asks the king to revise when the checks find a problem and carries out the revised decision", async () => {
    const calls: string[] = [];
    const server = await startFakeBridge(cmd => {
      calls.push(cmd);
      switch(cmd) {
      case "get_state":
        return { day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 100 }), towns: [{ id: 1, name: "Home", faction: "core:inferno", pos: { x: 5, y: 5, z: 0 }, builtThisTurn: false, visitingHero: -1, garrisonHero: -1, buildings: [], recruitable: [], army: [] }], heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 5, y: 5, z: 0 }, movement: 1500, army: [], primarySkills: {} }] };
      case "targets":
        return [site(62, "mine", "sawmill", "Sawmill", 0)];
      case "get_buildable":
        return [];
      case "status":
        return { pendingQuestions: [] };
      case "wait_for_turn":
        return { yourTurn: true, battle: false };
      default:
        return { reached: true, pos: { x: 62, y: 62, z: 0 }, movement: 1, status: { pendingQuestions: [] } };
      }
    });
    const tachka = new Tachka({ port: server.port });
    const reviews: boolean[] = [];
    tachka.subscribe(e => e.type === "review" && reviews.push(e.revised));
    const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
    cleanup.push(() => tachka.bridge.close(), server.close);
    const leave = { note: "go", missions: [{ hero: 5, target: { x: 62, y: 62, z: 0 }, intent: "sawmill" }], hire: [], merge: [], trade: [], hold: [] };
    const king = { decide: async () => leave, revise: async () => ({ note: "stay and recruit", missions: [], hire: [], merge: [], trade: [], hold: [] }) };
    await playTurn({ tachka, king, journal, memoryDays: 5 }, newLoopState());
    expect(reviews).toEqual([true]);
    expect(calls).not.toContain("move_hero");
    expect(journal.tail(3, 1)[0]?.review).toEqual({ findings: ["empty_town"], revised: true });
  });
});

describe("leftover movement", () => {
	async function turn(hold: number[]) {
		const walked: Array<{ x: number; y: number }> = [];
		const server = await startFakeBridge((cmd, args: any) => {
			switch(cmd) {
			case "get_state":
				return {
					day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 100 }), towns: [],
					heroes: [{ id: 5, name: "H", class: "", level: 1, pos: { x: 0, y: 0, z: 0 }, movement: 1500, movementLimit: 1500, army: [], primarySkills: {} }],
				};
			case "targets":
				return [site(10, "campfire", "", "Campfire", 0), site(11, "resource", "", "Wood", 0, { visitedByUs: true }), site(12, "mine", "sawmill", "Sawmill", 1)];
			case "move_hero":
				walked.push({ x: args.x, y: args.y });
				return { reached: true, pos: { x: args.x, y: args.y, z: 0 }, movement: walked.length === 1 ? 1200 : walked.length === 2 ? 700 : 100, status: { pendingQuestions: [] } };
			case "status":
				return { pendingQuestions: [] };
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			default:
				return {};
			}
		});
		const tachka = new Tachka({ port: server.port });
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);
		const king = { decide: async () => ({ note: "go", missions: [{ hero: 5, target: { x: 9, y: 9, z: 0 }, intent: "to the east gate" }], hire: [], merge: [], trade: [], hold }) };
		await playTurn({ tachka, king, journal, memoryDays: 5 }, newLoopState());
		return { walked, entry: journal.tail(3, 1)[0] };
	}

	it("keeps walking to the nearest unvisited site while a quarter of the day is left", async () => {
		const { walked, entry } = await turn([]);
		expect(walked).toEqual([{ x: 9, y: 9 }, { x: 10, y: 10 }, { x: 12, y: 12 }]);
		expect(entry?.moves.map(m => m.intent.startsWith("(automatic"))).toEqual([false, true, true]);
	});

	it("leaves a held hero where it is", async () => {
		const { walked } = await turn([5]);
		expect(walked).toEqual([{ x: 9, y: 9 }]);
	});
});

describe("commands that would make the server complain", () => {
	async function turnWith(decisionExtra: object, handler: (cmd: string, args: any, calls: string[]) => unknown) {
		const calls: string[] = [];
		const fixed: Record<string, unknown> = { get_buildable: [], get_tavern: [], threats: { enemies: [] } };
		const server = await startFakeBridge((cmd, args) => { calls.push(cmd); return cmd in fixed ? fixed[cmd] : handler(cmd, args, calls); });
		const tachka = new Tachka({ port: server.port });
		const journal = new Journal(join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl"));
		cleanup.push(() => tachka.bridge.close(), server.close);
		const king = { decide: async () => ({ note: "n", missions: [], hire: [], merge: [], trade: [], hold: [], ...decisionExtra }) };
		await playTurn({ tachka, king, journal, memoryDays: 5 }, newLoopState());
		return { calls, entry: journal.tail(3, 1)[0] };
	}
	const state = (heroPos: { x: number; y: number; z: number }) => ({
		day: 3, week: 1, dayOfWeek: 3, resources: res({ gold: 100 }),
		towns: [{ id: 1, name: "Home", faction: "core:inferno", pos: { x: 5, y: 5, z: 0 }, builtThisTurn: false, visitingHero: -1, garrisonHero: -1, buildings: [], recruitable: [], army: [] }],
		heroes: [{ id: 9, name: "H", class: "", level: 1, pos: heroPos, movement: 0, army: [], primarySkills: {} }],
	});

	it("does not send a merge between a town and a hero that is away, and tells the king", async () => {
		const { calls, entry } = await turnWith({ merge: [{ from: 1, to: 9 }] }, cmd => cmd === "get_state" ? state({ x: 20, y: 20, z: 0 }) : cmd === "status" ? { pendingQuestions: [] } : cmd === "wait_for_turn" ? { yourTurn: true, battle: false } : {});
		expect(calls).not.toContain("move_army");
		expect(entry?.deviations).toContainEqual(expect.objectContaining({ kind: "merge_not_together", from: 1, to: 9 }));
	});

	it("sends a merge when the hero stands in the town", async () => {
		const { calls } = await turnWith({ merge: [{ from: 1, to: 9 }] }, cmd => cmd === "get_state" ? state({ x: 5, y: 5, z: 0 }) : cmd === "status" ? { pendingQuestions: [] } : cmd === "wait_for_turn" ? { yourTurn: true, battle: false } : {});
		expect(calls).toContain("move_army");
	});

	it("fights the battle an answered dialog started before sending any walk", async () => {
		let answered = false;
		let fought = false;
		let moved = false;
		const order: string[] = [];
		await turnWith({ missions: [{ hero: 9, target: { x: 9, y: 9, z: 0 }, intent: "go" }] }, (cmd, args) => {
			order.push(cmd);
			switch(cmd) {
			case "get_state": return state({ x: 5, y: 5, z: 0 });
			case "targets": return [];
			case "move_hero": moved = true; return fought
				? { reached: true, pos: { x: 9, y: 9, z: 0 }, movement: 0, status: { pendingQuestions: [] } }
				: { reached: false, stopped: "question pending", pos: { x: 8, y: 8, z: 0 }, movement: 100, status: { pendingQuestions: [{ id: 3, kind: "dialog", text: "Do you want to attack?" }] } };
			case "status": return { pendingQuestions: !moved || answered || fought ? [] : [{ id: 3, kind: "dialog", text: "Do you want to attack?" }], battle: moved && answered && !fought };
			case "answer_question": answered = true; return {};
			case "battle_act": fought = true; return { battleOver: true };
			case "wait_for_turn": return { yourTurn: true, battle: false };
			default: return {};
			}
		});
		const walks = order.map((c, i) => c === "move_hero" ? i : -1).filter(i => i >= 0);
		expect(order.indexOf("battle_act")).toBeGreaterThan(-1);
		expect(walks[1]).toBeGreaterThan(order.indexOf("battle_act"));
	});
});

describe("lostHeroNotices", () => {
	it("names a hero that vanished between turns and the enemy heroes near its last position", () => {
		const before = [{ id: 1, name: "Damacon", level: 4, units: 23, pos: { x: 6, y: 19, z: 0 } }, { id: 2, name: "Ajit", level: 4, units: 39, pos: { x: 30, y: 30, z: 0 } }];
		const facts = {
			heroes: [{ id: 2 }],
			threats: [{ type: "hero", name: "Cuthbert", ownerColor: "orange", pos: { x: 9, y: 20, z: 0 } }, { type: "hero", name: "Far", ownerColor: "blue", pos: { x: 60, y: 60, z: 0 } }],
		} as unknown as EconomyFacts;
		const notices = lostHeroNotices(before, facts);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Damacon");
		expect(notices[0]).toContain("Cuthbert (orange) at 9,20");
		expect(notices[0]).not.toContain("Far");
		expect(lostHeroNotices(undefined, facts)).toEqual([]);
	});
});

describe("trade orders", () => {
	it("trades before the plan builds and reports a refused trade", async () => {
		const calls: Array<{ cmd: string; args: any }> = [];
		const server = await startFakeBridge((cmd, args: any) => {
			calls.push({ cmd, args });
			switch(cmd) {
			case "get_state":
				return {
					day: 4, week: 1, dayOfWeek: 4, resources: res({ gold: 3000, wood: 40, ore: 10 }),
					towns: [{ id: 11, name: "T", faction: "core:stronghold", pos: { x: 0, y: 0, z: 0 }, builtThisTurn: false, visitingHero: -1, garrisonHero: -1, buildings: ["core:marketplace"], recruitable: [] }],
					heroes: [],
				};
			case "market_rates":
				return { marketplace: true, rates: [{ give: "wood", get: "crystal", giveAmount: 4, getAmount: 1 }] };
			case "trade":
				if(args.give === "ore")
					throw Object.assign(new Error("the rate is 4 ore for 1 crystal"), { name: "BridgeError" });
				return { rate: { give: 4, get: 1 }, resources: {} };
			case "wait_for_turn":
				return { yourTurn: true, battle: false };
			default:
				return [];
			}
		});
		const tachka = new Tachka({ port: server.port });
		const file = join(mkdtempSync(join(tmpdir(), "tachka-")), "journal.jsonl");
		cleanup.push(() => tachka.bridge.close(), server.close);
		const king = {
			decide: async () => ({
				note: "buy crystal", missions: [], hire: [], merge: [], hold: [],
				trade: [{ town: 11, give: "wood" as const, get: "crystal" as const, amount: 40, why: "crystal for the lvl 5 dwelling" }, { town: 11, give: "ore" as const, get: "crystal" as const, amount: 10, why: "crystal for the lvl 5 dwelling" }],
			}),
		};

		await playTurn({ tachka, king, journal: new Journal(file), memoryDays: 5 }, newLoopState());

		const trades = calls.filter(c => c.cmd === "trade");
		expect(trades[0]?.args).toEqual({ town: 11, give: "wood", get: "crystal", amount: 40 });
		const entry = JSON.parse(readFileSync(file, "utf8").trim());
		expect(entry.orders.trade).toEqual([expect.objectContaining({ give: "wood", get: "crystal", amount: 40, rate: { give: 4, get: 1 } })]);
		expect(entry.deviations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "trade_failed", error: expect.stringContaining("4 ore") })]));
	});
});
