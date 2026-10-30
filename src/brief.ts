import type { Brief } from "./king.js";
import type { Resources } from "./state.js";

const short = (key: string) => key.replace(/^core:/, "");
const money = (r: Partial<Resources>) => Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join(" ") || "0";

/** The brief as compact text for a model; JSON only where the king must copy structure back. */
export function renderBrief(brief: Brief): string {
	const { facts } = brief;
	const lines: string[] = [];
	lines.push(`DAY ${facts.day} (week ${facts.week}, day ${facts.dayOfWeek} of the week)`);
	lines.push(`Treasury: ${money(facts.resources)}`);
	if(facts.incomeSinceLastTurn)
		lines.push(`Change since our last turn ended: ${money(facts.incomeSinceLastTurn)}`);

	lines.push("\nTOWNS");
	for(const t of facts.towns) {
		lines.push(`- town ${t.id} ${t.name} [${short(t.faction)}] ${t.builtThisTurn ? "(already built today)" : ""} visiting hero: ${t.hasVisitingHero}, garrison hero: ${t.hasGarrisonHero}`);
		lines.push(`  built: ${t.buildings.map(short).join(", ")}`);
		const options = t.options.map(o => `${short(o.building)}[${o.state}${o.missing.length ? " lacks " + o.missing.join("+") : ""}; ${money(o.cost)}]`);
		lines.push(`  can build: ${options.join("; ") || "nothing"}`);
		lines.push(`  stock: ${t.recruitable.map(r => `${short(r.creature)}(lvl${r.level}) ${r.available} @${money(r.cost)}`).join("; ") || "none"}`);
	}

	lines.push("\nHEROES");
	for(const h of facts.heroes)
		lines.push(`- hero ${h.id} ${h.name} (${short(h.class)}, lvl ${h.level}) at ${h.pos.x},${h.pos.y},${h.pos.z} movement ${h.movement}; army: ${h.army.map(a => `${a.count} ${short(a.creature)}`).join(", ") || "none"}; ${Object.entries(h.primarySkills).map(([k, v]) => `${k} ${v}`).join(" ")}`);

	lines.push("\nREACHABLE SITES (nearest first; threat/ratio only for monsters; ratio is their strength against this hero)");
	for(const h of facts.heroes) {
		const sites = (brief.sites[h.id] ?? []).slice(0, 14);
		lines.push(`hero ${h.id}:`);
		for(const s of sites)
			lines.push(`  ${s.id} ${s.name} [${s.type}${s.subtype ? "/" + s.subtype : ""}] at ${s.pos.x},${s.pos.y},${s.pos.z} turns ${s.turns} steps ${s.steps}${s.threat ? ` threat "${s.threat}" size ${s.size} ratio ${s.strengthRatio}` : ""}`);
		if(!sites.length)
			lines.push("  (nothing reachable and unvisited is known)");
	}

	lines.push("\nBLOCKED BUILDINGS");
	for(const b of brief.blockers)
		lines.push(`- town ${b.town} ${short(b.building)} short ${money(b.short)}; suppliers: ${b.suppliers.map(s => `${s.resource} at ${s.site.name} (${s.site.id}, ${s.site.turns} turns)`).join(", ") || "NONE KNOWN"}`);
	if(!brief.blockers.length)
		lines.push("none");

	lines.push("\nCURRENT ECONOMY PLAN");
	lines.push(brief.plan ? JSON.stringify(brief.plan) : "none yet");

	lines.push("\nRECENT JOURNAL (your own earlier turns)");
	for(const e of brief.journal)
		lines.push(`- day ${e.day}: ${e.note} | built ${e.built.map(b => short(b.building)).join(",") || "-"} | moves ${e.moves.map(m => `hero ${m.hero} ${m.intent}${m.reached ? " (done)" : m.stopped ? ` (${m.stopped})` : ""}`).join("; ") || "-"}`);
	if(!brief.journal.length)
		lines.push("(first turn)");

	lines.push("\nTHINGS THAT WENT WRONG OR NEED YOU LAST TURN");
	lines.push(brief.deviations.length ? brief.deviations.map(d => JSON.stringify(d)).join("\n") : "none");

	if(brief.messages.length)
		lines.push("\nMESSAGES FROM THE HUMAN (answer in `reply`)\n" + brief.messages.map(m => `- ${m}`).join("\n"));
	return lines.join("\n");
}
