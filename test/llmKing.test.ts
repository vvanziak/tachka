import { describe, expect, it } from "vitest";
import type { Brain } from "../src/brain.js";
import type { Brief } from "../src/king.js";
import { LlmKing, queryArgs } from "../src/llmKing.js";

const usage = { inputTokens: 100, outputTokens: 10, costUsd: 0.01 };
const res = { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0 };
const brief = {
	facts: { day: 2, week: 1, dayOfWeek: 2, resources: res, incomeSinceLastTurn: undefined, towns: [], heroes: [], threats: [], game: { player: "red", mapSize: undefined }, mines: { owned: [], others: [] }, rankings: undefined },
	plan: undefined, sites: {}, blockers: [], journal: [], deviations: [], messages: [], events: [], memory: undefined,
} as Brief;

function scripted(replies: unknown[]): { brain: Brain; prompts: string[] } {
	const prompts: string[] = [];
	let i = 0;
	return {
		prompts,
		brain: { name: "fake", complete: async (_s, user) => { prompts.push(user); return { json: replies[Math.min(i++, replies.length - 1)], usage }; }, say: async () => ({ text: "", usage }) },
	};
}

describe("LlmKing", () => {
	it("asks the game, shows the answers on the next round and returns the decision with the memory", async () => {
		const memory = { goal: "take the east mines", next: "scout east", deferred: [{ what: "gold mine at 20,5", unlock: "army of 40" }] };
		const { brain, prompts } = scripted([
			{ ask: [{ cmd: "inspect", id: 77, hero: 3 }] },
			{ ask: [], decision: { note: "guard is weak, go", memory } },
		]);
		const asked: string[] = [];
		const king = new LlmKing(brain, { query: async (cmd, args) => { asked.push(`${cmd} ${JSON.stringify(args)}`); return { threat: "weak" }; } });
		const decision = await king.decide(brief);
		expect(asked).toEqual(['inspect {"id":77,"hero":3}']);
		expect(prompts[1]).toContain('ANSWERS TO YOUR QUESTIONS (round 1)');
		expect(prompts[1]).toContain('"threat":"weak"');
		expect(decision.memory).toEqual({ ...memory, objectives: [] });
		expect(king.usage().last.inputTokens).toBe(200);
	});

	it("tells the model to decide after three rounds of questions", async () => {
		const ask = { ask: [{ cmd: "tile_info", x: 1, y: 2, z: 0 }] };
		const { brain, prompts } = scripted([ask, ask, ask, { ask: [], decision: { note: "enough" } }]);
		const king = new LlmKing(brain, { query: async () => "map" });
		const decision = await king.decide(brief);
		expect(decision.note).toBe("enough");
		expect(prompts[3]).toContain("no more questions left");
	});

	it("reports a failed question to the model instead of failing the turn", async () => {
		const { brain, prompts } = scripted([{ ask: [{ cmd: "lookup", kind: "creature", name: "x" }] }, { decision: { note: "ok" } }]);
		const king = new LlmKing(brain, { query: async () => { throw new Error("no such creature"); } });
		await king.decide(brief);
		expect(prompts[1]).toContain("error: no such creature");
	});

	it("sends only the fields a command takes", () => {
		expect(queryArgs({ cmd: "get_buildable", town: 5, hero: 9 })).toEqual({ cmd: "get_buildable", args: { town: 5, all: true } });
		expect(queryArgs({ cmd: "find_path", hero: 1, x: 2, y: 3, z: 0, name: "ignored" })).toEqual({ cmd: "find_path", args: { hero: 1, x: 2, y: 3, z: 0 } });
	});
});
