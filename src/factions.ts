import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "./king.js";

const DIR = join(import.meta.dirname, "..", "prompts", "factions");

const CLASS_FACTION: Record<string, string> = {
	knight: "castle", cleric: "castle", ranger: "rampart", druid: "rampart", alchemist: "tower", wizard: "tower",
	demoniac: "inferno", heretic: "inferno", deathknight: "necropolis", necromancer: "necropolis",
	overlord: "dungeon", warlock: "dungeon", barbarian: "stronghold", battlemage: "stronghold",
	beastmaster: "fortress", witch: "fortress", planeswalker: "conflux", elementalist: "conflux",
};

const bare = (key: string) => key.replace(/^[^:]+:/, "");

function sheet(faction: string): string | undefined {
	const path = join(DIR, `${faction}.md`);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/** The faction of an enemy hero or town as `threats` reports it, when it is one the notes cover. */
export function factionOfThreat(threat: Record<string, unknown>): string | undefined {
	const faction = threat.type === "town" ? String(threat.subtype ?? "") : CLASS_FACTION[bare(String(threat.class ?? ""))];
	return faction && sheet(faction) ? faction : undefined;
}

const DIFFICULTY = ["easy", "normal", "hard", "expert", "impossible"];

/** The scenario information as a human reads it: map, texts, difficulty and who plays which faction. */
export function scenarioText(scenario: Scenario): string {
	const lines = [`SCENARIO (the same information the scenario window shows a human)`, `map: ${scenario.name}, ${scenario.size.x}x${scenario.size.y}${scenario.size.z > 1 ? `, ${scenario.size.z} levels` : ""}; difficulty ${DIFFICULTY[scenario.difficulty] ?? scenario.difficulty}; you are ${scenario.you}`];
	if(scenario.description.trim())
		lines.push(`description: ${scenario.description.trim().slice(0, 600)}`);
	if(scenario.victory.trim() || scenario.defeat.trim())
		lines.push(`victory: ${scenario.victory.trim() || "standard"}; defeat: ${scenario.defeat.trim() || "standard"}`);
	lines.push("players:");
	for(const p of scenario.players)
		lines.push(`  ${p.color}${p.color === scenario.you ? " (you)" : p.human ? " (human)" : ""}: ${p.faction ? bare(p.faction) : "random faction"}${p.team !== undefined ? `, team ${p.team}` : ""}`);
	return lines.join("\n");
}

/** Notes on our own faction and on the opponents' factions: all of them when the scenario is known, else the ones seen so far. */
export function factionNotes(own: string[], threats: Array<Record<string, unknown>>, scenario?: Scenario): string {
	const mine = [...new Set(own.map(bare))].filter(f => sheet(f));
	const lines: string[] = ["YOUR FACTION" + (mine.length > 1 ? "S" : "")];
	for(const f of mine)
		lines.push(sheet(f)!);
	const seen = new Map<string, Set<string>>();
	if(scenario)
		for(const p of scenario.players) {
			const faction = p.faction ? bare(p.faction) : undefined;
			if(p.color !== scenario.you && faction && sheet(faction))
				seen.set(faction, (seen.get(faction) ?? new Set()).add(p.color));
		}
	else
		for(const t of threats) {
			const owner = String(t.ownerColor ?? "");
			const faction = factionOfThreat(t);
			if(!faction || owner === "neutral" || owner === "")
				continue;
			seen.set(faction, (seen.get(faction) ?? new Set()).add(owner));
		}
	lines.push("", scenario ? "OPPONENTS' FACTIONS" : "OPPONENTS' FACTIONS (known only once their heroes or towns have been seen)");
	if(!seen.size)
		lines.push("none seen yet: the notes appear here when an opponent's hero or town is seen");
	for(const [faction, owners] of seen)
		lines.push(`${[...owners].join(", ")}:`, sheet(faction)!);
	return lines.join("\n");
}
