import type { EconomyFacts } from "./facts.js";
import type { Decision } from "./king.js";
import type { Pos } from "./missions.js";

export type ManualOrder =
	| { kind: "retreat" }
	| { kind: "hold"; hero?: string }
	| { kind: "go"; hero: string; target: Pos; fight: boolean };

export const MANUAL_HELP = "Orders for the next turn: !retreat (every hero goes to the nearest town), !hold (nobody walks), !hold <hero>, !go <hero> <x> <y> [fight]. A hero is its name or id.";

/** Reads an emergency order the human typed; undefined when the text is not one. */
export function parseManual(text: string): ManualOrder | undefined {
	const words = text.trim().replace(/^!/, "").split(/\s+/);
	const [command, ...args] = words;
	if(command === "retreat")
		return { kind: "retreat" };
	if(command === "hold")
		return { kind: "hold", hero: args.join(" ") || undefined };
	if(command === "go" && args.length >= 3) {
		const fight = args.at(-1) === "fight";
		const nums = (fight ? args.slice(0, -1) : args).slice(-2).map(Number);
		const hero = (fight ? args.slice(0, -1) : args).slice(0, -2).join(" ");
		if(hero && nums.length === 2 && nums.every(Number.isInteger))
			return { kind: "go", hero, target: { x: nums[0]!, y: nums[1]!, z: 0 }, fight };
	}
	return undefined;
}

const findHero = (facts: EconomyFacts, who: string) => facts.heroes.find(h => String(h.id) === who || h.name.toLowerCase() === who.toLowerCase())
	?? facts.heroes.find(h => h.name.toLowerCase().startsWith(who.toLowerCase()));

/** The decision with the human's orders on top: they replace the king's missions for the heroes they name. Returns what was done, for the chat. */
export function applyManual(decision: Decision, orders: ManualOrder[], facts: EconomyFacts): { decision: Decision; done: string[] } {
	let missions = [...decision.missions];
	const hold = new Set(decision.hold);
	const done: string[] = [];
	const take = (id: number) => { missions = missions.filter(m => m.hero !== id); };
	for(const order of orders) {
		if(order.kind === "hold") {
			const targets = order.hero ? [findHero(facts, order.hero)] : facts.heroes;
			if(order.hero && !targets[0]) { done.push(`no hero called "${order.hero}"`); continue; }
			for(const h of targets) if(h) { take(h.id); hold.add(h.id); done.push(`${h.name} holds`); }
		}
		else if(order.kind === "retreat") {
			for(const h of facts.heroes) {
				const town = [...facts.towns].sort((a, b) => Math.max(Math.abs(a.pos.x - h.pos.x), Math.abs(a.pos.y - h.pos.y)) - Math.max(Math.abs(b.pos.x - h.pos.x), Math.abs(b.pos.y - h.pos.y)))[0];
				take(h.id);
				hold.add(h.id);
				if(!town) { done.push(`${h.name} has no town to retreat to`); continue; }
				if(town.pos.x !== h.pos.x || town.pos.y !== h.pos.y)
					missions.push({ hero: h.id, target: town.pos, intent: "retreat to town (human's order)" });
				done.push(`${h.name} retreats to ${town.name}`);
			}
		}
		else {
			const h = findHero(facts, order.hero);
			if(!h) { done.push(`no hero called "${order.hero}"`); continue; }
			take(h.id);
			missions.push({ hero: h.id, target: { ...order.target, z: h.pos.z }, intent: "human's order", ...(order.fight ? { allowFight: true } : {}) });
			hold.add(h.id);
			done.push(`${h.name} goes to ${order.target.x},${order.target.y}${order.fight ? " and fights" : ""}`);
		}
	}
	return { decision: { ...decision, missions, hold: [...hold] }, done };
}
