import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/plan.js";

const dir = join(import.meta.dirname, "..", "plans");

describe("hand-written plans", () => {
	for(const file of readdirSync(dir).filter(f => f.endsWith(".json")))
		it(`${file} parses`, () => {
			expect(() => parsePlan(JSON.parse(readFileSync(join(dir, file), "utf8")))).not.toThrow();
		});
});
