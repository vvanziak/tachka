import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeClient, BridgeError } from "../src/bridge.js";
import { Tachka } from "../src/core.js";
import { jsonlRecorder } from "../src/recorder.js";
import { startFakeBridge } from "./fakeBridge.js";

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
	for(const fn of cleanup.reverse())
		await fn();
	cleanup = [];
});

async function connect(handler: Parameters<typeof startFakeBridge>[0], onExchange?: ConstructorParameters<typeof BridgeClient>[0]["onExchange"]) {
	const server = await startFakeBridge(handler);
	const client = new BridgeClient({ port: server.port, onExchange });
	cleanup.push(() => client.close(), server.close);
	return client;
}

describe("BridgeClient", () => {
	it("returns the result of an ok reply", async () => {
		const client = await connect((cmd, args) => ({ cmd, args }));
		expect(await client.call("move_hero", { hero: 3 })).toEqual({ cmd: "move_hero", args: { hero: 3 } });
	});

	it("rejects with BridgeError carrying the server's message", async () => {
		const client = await connect(() => { throw new Error("town must be one of ours"); });
		await expect(client.call("build", {})).rejects.toThrow(BridgeError);
		await expect(client.call("build", {})).rejects.toThrow("town must be one of ours");
	});

	it("keeps concurrent calls in order, one at a time", async () => {
		let active = 0;
		let maxActive = 0;
		const client = await connect(async cmd => {
			maxActive = Math.max(maxActive, ++active);
			await new Promise(r => setTimeout(r, 10));
			active--;
			return cmd;
		});
		const replies = await Promise.all(["a", "b", "c"].map(cmd => client.call(cmd)));
		expect(replies).toEqual(["a", "b", "c"]);
		expect(maxActive).toBe(1);
	});

	it("fails on timeout and works again on a fresh connection", async () => {
		const client = await connect(async cmd => {
			if(cmd === "slow")
				await new Promise(r => setTimeout(r, 200));
			return cmd;
		});
		await expect(client.call("slow", {}, 30)).rejects.toThrow("no reply to slow");
		expect(await client.call("fast")).toBe("fast");
	});

	it("rejects when nothing listens on the port", async () => {
		const server = await startFakeBridge(() => null);
		await server.close();
		const client = new BridgeClient({ port: server.port });
		await expect(client.call("ping")).rejects.toThrow();
	});

	it("records each exchange as a JSON line", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "tachka-")), "game.jsonl");
		const client = await connect(cmd => cmd, jsonlRecorder(file));
		await client.call("ping");
		const lines = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
		expect(lines).toMatchObject([{ cmd: "ping", ok: true, result: "ping" }]);
	});
});

describe("Tachka", () => {
	it("queues human messages until drained and reports them to subscribers", () => {
		const tachka = new Tachka({ port: 1 });
		const seen: string[] = [];
		tachka.subscribe(e => e.type === "chat" && seen.push(e.text));
		tachka.say("take the sawmill first");
		tachka.say("and keep a garrison");
		expect(seen).toEqual(["take the sawmill first", "and keep a garrison"]);
		expect(tachka.drainInbox()).toEqual(["take the sawmill first", "and keep a garrison"]);
		expect(tachka.drainInbox()).toEqual([]);
	});
});
