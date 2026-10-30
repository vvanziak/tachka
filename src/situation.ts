import type { Tachka, TachkaEvent } from "./core.js";
import type { Journal } from "./journal.js";

type Facts = {
	day: number; week: number; dayOfWeek: number; resources: Record<string, number>; income?: Record<string, number>;
	towns: Array<{ name: string; faction: string; buildings: string[] }>;
	heroes: Array<{ id: number; name: string; class: string; level: number; pos: { x: number; y: number }; army: Array<{ creature: string; count: number }>; primarySkills: Record<string, number> }>;
	blockers: Array<{ building: string; short: Record<string, number> }>;
	plan?: { note?: string };
};

const short = (key: string) => key.replace(/^core:/, "");

/** What the talker is allowed to know: the latest facts, what Tachka is doing right now, its journal and the final report. */
export class Situation {
	private facts: Facts | undefined;
	private phase = "starting up";
	private final: unknown;
	private lastThought = "";

	constructor(tachka: Tachka, private readonly journal: Journal) {
		tachka.subscribe((e: TachkaEvent) => {
			if(e.type === "facts") { this.facts = e.facts as Facts; this.phase = "thinking about its move"; }
			else if(e.type === "king") { this.phase = "carrying out its move"; this.lastThought = e.note; }
			else if(e.type === "turn") this.phase = "waiting for the other players' turn";
			else if(e.type === "status") this.phase = e.text;
			else if(e.type === "final") { this.final = e.final; this.phase = "the game is over"; }
		});
	}

	/** The last facts seen, for a final report when the bridge can no longer answer. */
	get lastFacts(): unknown {
		return this.facts;
	}

	describe(): string {
		const lines = [`Phase: ${this.phase}.`];
		const f = this.facts;
		if(f) {
			lines.push(`Day ${f.day} (week ${f.week}). Treasury: ${Object.entries(f.resources).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
			for(const h of f.heroes)
				lines.push(`Hero ${h.name} (${short(h.class)}, level ${h.level}) at ${h.pos.x},${h.pos.y}: ${h.army.map(a => `${a.count} ${short(a.creature)}`).join(", ") || "no army"}; attack ${h.primarySkills.attack}, defense ${h.primarySkills.defense}, spell power ${h.primarySkills.spellPower}, knowledge ${h.primarySkills.knowledge}.`);
			for(const t of f.towns)
				lines.push(`Town ${t.name} (${short(t.faction)}), ${t.buildings.length} buildings.`);
			if(f.blockers.length)
				lines.push(`Blocked buildings: ${f.blockers.map(b => `${short(b.building)} short ${Object.entries(b.short).map(([k, v]) => `${v} ${k}`).join(", ")}`).join("; ")}.`);
			if(f.plan?.note)
				lines.push(`Economy plan: ${f.plan.note}`);
		}
		if(this.lastThought)
			lines.push(`Latest thought: ${this.lastThought}`);

		const recent = this.journal.tail(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).slice(-14);
		if(recent.length) {
			lines.push("Journal (my notes, oldest first):");
			for(const e of recent)
				lines.push(`- day ${e.day}: ${e.note} [built ${e.built.map(b => short(b.building)).join(", ") || "-"}; moves ${e.moves.map(m => `${m.intent}${m.reached ? " done" : m.stopped ? ` (${m.stopped})` : ""}`).join("; ") || "-"}]`);
		}
		if(this.final)
			lines.push(`FINAL REPORT: ${JSON.stringify(this.final).slice(0, 6000)}`);
		return lines.join("\n");
	}
}
