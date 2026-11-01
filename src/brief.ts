import type { Brief } from "./king.js";
import { fightCandidates, isArmed } from "./missions.js";
import { PLAYER_COLORS } from "./protocol.js";
import type { Resources } from "./state.js";

const short = (key: string) => key.replace(/^core:/, "");
const money = (r: Partial<Resources>) => Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k}${v}`).join(" ") || "0";

/** The brief as compact text for a model; JSON only where the king must copy structure back. */
export function renderBrief(brief: Brief): string {
	const { facts } = brief;
	const lines: string[] = [];
	lines.push("OBJECTIVES");
	lines.push("global (set by the map; unless it says otherwise): eliminate every opponent, so take their towns and defeat their heroes while keeping ours.");
	lines.push("mid-term (yours, found while exploring the map; keep them in `memory.objectives`):");
	const objectives = brief.memory?.objectives ?? [];
	for(const o of objectives)
		lines.push(`  [${o.status}] ${o.what}${o.where ? ` (${o.where})` : ""}`);
	if(!objectives.length)
		lines.push("  none yet: add one whenever the map shows something worth a plan");
	lines.push("");
	if(brief.memory) {
		const m = brief.memory;
		lines.push("YOUR STRATEGY MEMORY (you wrote it earlier; rewrite it in `memory` whenever it changes)");
		lines.push(`goal: ${m.goal}`);
		lines.push(`next: ${m.next}`);
		for(const d of m.deferred)
			lines.push(`deferred: ${d.what} -- unlocks when: ${d.unlock}`);
		if(m.watch)
			lines.push(`watch: ${m.watch}`);
		lines.push("");
	}
	else
		lines.push("YOUR STRATEGY MEMORY: none yet. Write it in `memory` on this turn.\n");
	lines.push(`DAY ${facts.day} (week ${facts.week}, day ${facts.dayOfWeek} of the week). You are ${facts.game.player ?? "?"}${facts.game.mapSize ? `, map ${facts.game.mapSize.x}x${facts.game.mapSize.y}, ${facts.game.mapSize.z} level(s)` : ""}.`);
	lines.push(`Treasury: ${money(facts.resources)}`);
	if(facts.incomeSinceLastTurn)
		lines.push(`Change since our last turn ended: ${money(facts.incomeSinceLastTurn)}`);

	lines.push("\nTOWNS");
	for(const t of facts.towns) {
		lines.push(`- town ${t.id} ${t.name} [${short(t.faction)}] at ${t.pos.x},${t.pos.y},${t.pos.z} ${t.builtThisTurn ? "(already built today)" : ""} visiting hero: ${t.hasVisitingHero}, garrison hero: ${t.hasGarrisonHero}`);
		lines.push(`  garrison (units standing in the town, NOT with any hero): ${t.garrisonArmy.map(a => `${a.count} ${short(a.creature)}`).join(", ") || "none"}${t.garrison > 0 ? ` = ${t.garrison} units; they join a hero only through a merge order with the hero in the town` : ""}`);
		lines.push(`  built: ${t.buildings.map(short).join(", ")}`);
		const options = t.options.map(o => `${short(o.building)}[${o.state}${o.missing.length ? " lacks " + o.missing.join("+") : ""}; ${money(o.cost)}]`);
		lines.push(`  can build: ${options.join("; ") || "nothing"}`);
		if(t.tavern.length) {
			const best = [...t.recruitable].filter(r => r.cost.gold > 0).sort((a, b) => b.level - a.level)[0];
			const worth = best ? ` (about ${Math.floor(2500 / best.cost.gold)} ${short(best.creature)} at ${best.cost.gold} gold each)` : "";
			lines.push(`  tavern (hire with \`hire\`; a hero costs 2500 gold${worth}): ${t.tavern.map(h => `hero ${h.id} ${h.name} (${short(h.class)}; army ${h.army.map(a => a.count + " " + short(a.creature)).join(", ") || "none"})`).join("; ")}`);
		}
		lines.push(`  stock: ${t.recruitable.map(r => `${short(r.creature)}(lvl${r.level}) ${r.available} @${money(r.cost)}`).join("; ") || "none"}`);
	}

	lines.push("\nHEROES");
	for(const h of facts.heroes) {
		const skills = (h.secondarySkills ?? []).map(k => `${short(k.skill)} ${k.level}`).join(", ");
		lines.push(`- hero ${h.id} ${h.name} (${short(h.class)}, lvl ${h.level}${h.combatValue !== undefined ? `, combat value ${h.combatValue}` : ""}) at ${h.pos.x},${h.pos.y},${h.pos.z} movement ${h.movement}${h.movementLimit ? "/" + h.movementLimit : ""}; army: ${h.army.map(a => `${a.count} ${short(a.creature)}`).join(", ") || "none"}; ${Object.entries(h.primarySkills).map(([k, v]) => `${k} ${v}`).join(" ")}${skills ? "; skills: " + skills : ""}${h.mana !== undefined ? `; mana ${h.mana}` : ""}${h.spells?.length ? `; spells: ${h.spells.map(short).join(", ")}` : ""}`);
	}

	lines.push("\nREACHABLE SITES (nearest first; threat/ratio only for monsters; ratio is their strength against this hero)");
	for(const h of facts.heroes) {
		const sites = (brief.sites[h.id] ?? []).slice(0, 14);
		lines.push(`hero ${h.id}:`);
		for(const s of sites)
			lines.push(`  ${s.id} ${s.name} [${s.type}${s.subtype ? "/" + s.subtype : ""}] at ${s.pos.x},${s.pos.y},${s.pos.z} turns ${s.turns} steps ${s.steps}${s.threat ? ` threat "${s.threat}" size ${s.size} ratio ${s.strengthRatio}` : ""}${isArmed(s) ? " [ARMED: holds an army with no strength shown; walking onto it starts a fight, so inspect it first]" : ""}${s.visitedByHero ? " [this hero has visited]" : s.visitedByUs ? " [we have visited]" : ""}`);
		if(!sites.length)
			lines.push("  (nothing reachable and unvisited is known)");
	}

	lines.push("\nFIGHT CANDIDATES (monster stacks each hero can reach, easiest first; ratio is their strength against that hero, below 1 means the hero is stronger; \"behind\" is what stands next to the stack)");
	for(const h of facts.heroes) {
		const fights = fightCandidates(brief.sites[h.id] ?? []).slice(0, 6);
		if(!fights.length)
			continue;
		lines.push(`hero ${h.id}:`);
		for(const { guard: g, behind } of fights)
			lines.push(`  ${g.id} ${g.name} size ${g.size} threat "${g.threat}" ratio ${g.strengthRatio} turns ${g.turns} at ${g.pos.x},${g.pos.y}; behind: ${behind.map(b => `${b.name}${b.visitedByUs ? " (visited)" : ""}`).join(", ") || "nothing seen"}`);
	}

	lines.push("\nVISIBLE OTHER PLAYERS' HEROES AND TOWNS (ratio = their strength against our strongest hero; a town with no hero in it and no army is empty and can be taken)");
	for(const t of facts.threats)
		lines.push(`- ${JSON.stringify(t)}`);
	if(!facts.threats.length)
		lines.push("none seen");

	if(facts.rankings) {
		lines.push("\nWHERE EVERYONE STANDS (Guild of Thieves; each list is first place first, tied players together)");
		lines.push(JSON.stringify(facts.rankings));
	}

	lines.push("\nMINES");
	lines.push(`owned: ${facts.mines.owned.map(m => `${m.name} at ${m.pos.x},${m.pos.y}`).join("; ") || "none"}`);
	lines.push(`others known: ${facts.mines.others.slice(0, 20).map(m => `${m.name} at ${m.pos.x},${m.pos.y} (${m.owner < 0 ? "unowned" : PLAYER_COLORS[m.owner] ?? m.owner})`).join("; ") || "none"}`);

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

	if(brief.events.length) {
		lines.push("\nWHAT THE GAME REPORTED SINCE YOUR LAST BRIEF");
		for(const e of brief.events.slice(-30))
			lines.push(`- ${e}`);
	}

	lines.push("\nTHINGS THAT WENT WRONG OR NEED YOU LAST TURN");
	lines.push(brief.deviations.length ? brief.deviations.map(d => JSON.stringify(d)).join("\n") : "none");

	if(brief.messages.length)
		lines.push("\nMESSAGES FROM THE HUMAN (answer in `reply`)\n" + brief.messages.map(m => `- ${m}`).join("\n"));
	return lines.join("\n");
}
