import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Notes on our own faction and on the factions of the opponents seen so far, one sheet per faction. */
export function factionNotes(own: string[], threats: Array<Record<string, unknown>>): string {
	const mine = [...new Set(own.map(bare))].filter(f => sheet(f));
	const lines: string[] = ["YOUR FACTION" + (mine.length > 1 ? "S" : "")];
	for(const f of mine)
		lines.push(sheet(f)!);
	const seen = new Map<string, Set<string>>();
	for(const t of threats) {
		const owner = String(t.ownerColor ?? "");
		const faction = factionOfThreat(t);
		if(!faction || owner === "neutral" || owner === "")
			continue;
		seen.set(faction, (seen.get(faction) ?? new Set()).add(owner));
	}
	lines.push("", "OPPONENTS' FACTIONS (known only once their heroes or towns have been seen)");
	if(!seen.size)
		lines.push("none seen yet: the notes appear here when an opponent's hero or town is seen");
	for(const [faction, owners] of seen)
		lines.push(`${[...owners].join(", ")}:`, sheet(faction)!);
	return lines.join("\n");
}
