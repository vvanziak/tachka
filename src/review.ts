import type { Brief, Decision } from "./king.js";
import type { Site } from "./missions.js";

export interface Finding {
	code: string;
	text: string;
}

const bare = (key: string) => key.replace(/^[^:]+:/, "");
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tiles: number) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= tiles;

const THREAT_TILES = 16;
const IDLE_GOLD = 4000;
const IDLE_COMMON = 30;
const IDLE_RARE = 12;
const MAX_FINDINGS = 5;

/** Known failure patterns checked against the king's decision before it is carried out. Facts only, no model. */
export function reviewDecision(brief: Brief, decision: Decision): Finding[] {
	const { facts } = brief;
	const found: Finding[] = [];
	const plan = decision.plan ?? brief.plan;
	const leaving = new Set(decision.missions.map(m => m.hero));
	const closeEnemies = facts.threats.filter(t => t.type === "hero" && t.ownerColor !== "neutral" && Number(t.tilesToNearestOwnTown) <= THREAT_TILES);

	for(const town of facts.towns) {
		const staying = facts.heroes.filter(h => near(h.pos, town.pos, 0) && !leaving.has(h.id)).length;
		const townPlan = plan?.towns.find(t => t.town === town.id);
		const recruiting = townPlan !== undefined && townPlan.recruit.mode !== "none" && town.recruitable.some(r => r.available > 0);
		if(staying === 0 && town.garrison === 0 && !recruiting) {
			const enemy = closeEnemies[0];
			found.push(enemy
				? { code: "empty_town_threat", text: `${town.name} (${town.id}) would be left with no hero, no garrison and no recruiting while an enemy hero (${String(enemy.name ?? enemy.id)}) is ${enemy.tilesToNearestOwnTown} tiles from your nearest town. A town with no defender falls to the first hero that arrives.` }
				: { code: "empty_town", text: `${town.name} (${town.id}) would have no hero, no garrison and no recruiting this turn. Say why that is safe, or leave a defender.` });
		}
	}

	// units bought while no hero stood in the town wait in the garrison until a merge order moves them to a hero
	for(const town of facts.towns) {
		const strongest = [...facts.heroes].sort((a, b) => b.army.reduce((n, x) => n + x.count, 0) - a.army.reduce((n, x) => n + x.count, 0))[0];
		const carried = strongest ? strongest.army.reduce((n, x) => n + x.count, 0) : 0;
		const merging = decision.merge.some(m => m.from === town.id);
		if(town.garrison >= 10 && town.garrison > 1.5 * carried && !merging && strongest) {
			const here = near(strongest.pos, town.pos, 0) || decision.missions.some(m => m.hero === strongest.id && near(m.target, town.pos, 0));
			found.push({ code: "army_at_home", text: `${town.name} holds ${town.garrison} units in its garrison while your strongest hero ${strongest.name} (${strongest.id}) carries ${carried}. Garrison units do not fight for a hero until you order the merge. ${here ? `The hero is in or going to the town: add merge: [{ "from": ${town.id}, "to": ${strongest.id} }].` : `Send ${strongest.name} to ${town.name} at ${town.pos.x},${town.pos.y},${town.pos.z}, then add merge: [{ "from": ${town.id}, "to": ${strongest.id} }] (merges run after the walks).`} Keep a few units back only if an enemy is near.` });
		}
	}

	// a trip home for a few fresh units costs a day of movement and leaves the map to the enemy
	for(const town of facts.towns) {
		for(const mission of decision.missions) {
			const hero = facts.heroes.find(h => h.id === mission.hero);
			if(!hero || !near(mission.target, town.pos, 0) || near(hero.pos, town.pos, 0) || mission.allowFight)
				continue;
			const carried = hero.army.reduce((n, a) => n + a.count, 0);
			if(town.garrison < Math.max(10, 0.4 * carried))
				found.push({ code: "small_restock_trip", text: `${hero.name} (${hero.id}) goes back to ${town.name} for ${town.garrison} garrison units while carrying ${carried}. That is a day of movement for a small gain. Recruit in one batch later, merge when the hero passes the town anyway, and use this turn to fight the easiest stack in FIGHT CANDIDATES or to explore.` });
		}
	}

	const newHeroes = facts.heroes.length + decision.hire.length;
	if(decision.hire.length > 0 && newHeroes > 2) {
		const sizes = facts.heroes.map(h => `${h.name} ${h.army.reduce((n, a) => n + a.count, 0)} units`).join(", ");
		found.push({ code: "many_heroes", text: `The hire would give you ${newHeroes} heroes (now: ${sizes}). Heroes with small armies are targets, not an army. Is the stated job really one the heroes you have cannot do?` });
	}

	const idle: string[] = [];
	for(const [resource, amount] of Object.entries(facts.resources)) {
		const limit = resource === "gold" ? Infinity : resource === "wood" || resource === "ore" ? IDLE_COMMON : IDLE_RARE;
		const planned = brief.memory?.deferred.some(d => `${d.what} ${d.unlock}`.toLowerCase().includes(resource)) || brief.memory?.next.toLowerCase().includes(resource);
		if(amount >= limit && !planned)
			idle.push(`${amount} ${resource}`);
	}
	if(idle.length)
		found.push({ code: "idle_resources", text: `Unspent: ${idle.join(", ")}. What is each of these for? If nothing uses it, trade it or build toward a use, and write the intended use in your strategy memory.` });

	if(facts.resources.gold >= IDLE_GOLD && decision.hire.length === 0 && plan) {
		const gold = facts.resources.gold;
		const canSpend = plan.towns.some(tp => {
			const town = facts.towns.find(t => t.id === tp.town);
			if(!town)
				return false;
			const build = tp.build.some(step => town.options.some(o => bare(o.building) === bare(step.building) && o.state === "allowed" && o.missing.length === 0 && o.cost.gold <= gold));
			const recruit = tp.recruit.mode !== "none" && town.recruitable.some(r => r.available > 0 && r.cost.gold <= gold);
			return build || recruit;
		});
		if(!canSpend)
			found.push({ code: "idle_gold", text: `${gold} gold and nothing in the plan can spend it this turn (no affordable planned building, no recruiting). Idle gold is a symptom: what blocks the dwellings or units, and what will you do about it?` });
	}

	for(const hero of facts.heroes) {
		const sites = brief.sites[hero.id] ?? [];
		const free = sites.filter(s => !s.threat && !s.visitedByHero && !s.visitedByUs);
		if(hero.movement >= 300 && !leaving.has(hero.id) && free.length > 0 && !facts.towns.some(t => near(t.pos, hero.pos, 0) && t.garrison === 0))
			found.push({ code: "idle_hero", text: `${hero.name} (${hero.id}) has ${hero.movement} movement and ${free.length} reachable unvisited sites but no mission. If it is meant to stay, say what it is guarding or waiting for.` });
	}

	const monsters = new Map<string, Site>();
	for(const sites of Object.values(brief.sites))
		for(const s of sites)
			if(s.threat)
				monsters.set(`${s.pos.x},${s.pos.y},${s.pos.z}`, s);
	for(const m of decision.missions) {
		const target = monsters.get(`${m.target.x},${m.target.y},${m.target.z}`);
		if(m.allowFight && target && (target.strengthRatio ?? 0) > 1)
			found.push({ code: "bad_odds", text: `Hero ${m.hero} is ordered to fight ${target.name} (${target.size}, "${target.threat}", ratio ${target.strengthRatio}) at poor odds. Ratios above 1 mean they are stronger. Is this a deliberate sacrifice, and for what?` });
		const hero = facts.heroes.find(h => h.id === m.hero);
		const danger = hero && facts.threats.find(t => t.type === "hero" && t.ownerColor !== "neutral" && Number(t.strengthRatio) > 1.2 && t.pos && near(t.pos as { x: number; y: number }, m.target, 6));
		if(danger)
			found.push({ code: "toward_enemy", text: `Hero ${m.hero} is sent within 6 tiles of an enemy hero (${String(danger.name ?? danger.id)}) that is stronger than your strongest (ratio ${String(danger.strengthRatio)}). Pull back, or say what makes this safe.` });
	}

	return found.slice(0, MAX_FINDINGS);
}
