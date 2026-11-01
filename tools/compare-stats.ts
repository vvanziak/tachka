// Reads VCMI's statistics export (one row per player per day) and prints how Tachka's slot compares with the others.
// Usage: npm run stats -- <export file> [<more exports>] [--player blue]
// With several files (the same map, different runs) it also lines up Tachka's numbers day by day across the runs.
import { readFileSync } from "node:fs";

export interface StatRow {
	map: string;
	day: number;
	player: string;
	isHuman: boolean;
	status: number;
	heroes: number;
	towns: number;
	artifacts: number;
	dwellings: number;
	army: number;
	experience: number;
	income: number;
	explored: number;
	score: number;
	maxHeroLevel: number;
	battlesNeutral: number;
	battlesPlayer: number;
	winsNeutral: number;
	winsPlayer: number;
	movement: number;
	gold: number;
}

/** The export is separated by ';' (the game's own file) or by tabs (copied from the statistics window). */
export function parseStats(text: string): StatRow[] {
	const lines = text.split(/\r?\n/).filter(l => l.trim());
	const head = lines[0] ?? "";
	const sep = head.includes(";") ? ";" : "\t";
	const names = head.split(sep);
	const at = (cells: string[], name: string) => Number(cells[names.indexOf(name)] ?? 0);
	return lines.slice(1).map(line => {
		const cells = line.split(sep);
		return {
			map: cells[names.indexOf("Map")] ?? "",
			day: at(cells, "Day"),
			player: cells[names.indexOf("Player")] ?? "",
			isHuman: at(cells, "IsHuman") === 1,
			status: at(cells, "Status"),
			heroes: at(cells, "NumberHeroes"),
			towns: at(cells, "NumberTowns"),
			artifacts: at(cells, "NumberArtifacts"),
			dwellings: at(cells, "NumberDwellings"),
			army: at(cells, "ArmyStrength"),
			experience: at(cells, "TotalExperience"),
			income: at(cells, "Income"),
			explored: at(cells, "MapExploredRatio"),
			score: at(cells, "Score"),
			maxHeroLevel: at(cells, "MaxHeroLevel"),
			battlesNeutral: at(cells, "NumBattlesNeutral"),
			battlesPlayer: at(cells, "NumBattlesPlayer"),
			winsNeutral: at(cells, "NumWinBattlesNeutral"),
			winsPlayer: at(cells, "NumWinBattlesPlayer"),
			movement: at(cells, "MovementPointsUsed"),
			gold: at(cells, "gold"),
		};
	});
}

const pad = (value: string | number, width: number) => String(value).padStart(width);

function line(r: StatRow, label: string): string {
	const alive = r.status === 0 ? "" : " (out)";
	return [
		label.padEnd(10),
		pad(r.heroes, 3), pad(r.towns, 3), pad(r.artifacts, 4), pad(r.army, 7), pad(r.experience, 6), pad(r.income, 6),
		pad(`${Math.round(r.explored * 100)}%`, 5), pad(Math.round(r.movement / 1000) + "k", 5),
		pad(`${r.winsNeutral + r.winsPlayer}/${r.battlesNeutral + r.battlesPlayer}`, 6), pad(r.maxHeroLevel, 3),
	].join(" ") + alive;
}

const HEADER = `${"".padEnd(10)} ${pad("hro", 3)} ${pad("twn", 3)} ${pad("art", 4)} ${pad("army", 7)} ${pad("xp", 6)} ${pad("inc", 6)} ${pad("expl", 5)} ${pad("move", 5)} ${pad("wins", 6)} ${pad("lvl", 3)}`;

function label(r: StatRow, tachka: string): string {
	return r.player === tachka ? `${r.player}*` : r.isHuman ? `${r.player} (you)` : r.player;
}

/** Days worth printing: every tenth day and the last one. */
export function checkpoints(rows: StatRow[]): number[] {
	const last = Math.max(...rows.map(r => r.day));
	return [...new Set([...rows.map(r => r.day).filter(d => d % 10 === 0), last])].sort((a, b) => a - b);
}

export function report(rows: StatRow[], tachka: string): string {
	const out: string[] = [`${rows[0]?.map ?? "?"}, ${Math.max(...rows.map(r => r.day))} days; * is Tachka. hro heroes, twn towns, art artifacts, xp experience, inc income per day, expl map explored, move movement points used (cumulative), wins won/total battles, lvl best hero level`];
	for(const day of checkpoints(rows)) {
		out.push("", `day ${day}`, HEADER);
		for(const r of rows.filter(x => x.day === day))
			out.push(line(r, label(r, tachka)));
	}
	const mine = rows.filter(r => r.player === tachka);
	const out2 = mine.find(r => r.status !== 0);
	if(out2)
		out.push("", `${tachka} was out of the game on day ${out2.day}.`);
	return out.join("\n");
}

const METRICS: Array<[string, (r: StatRow) => number]> = [
	["heroes", r => r.heroes], ["towns", r => r.towns], ["artifacts", r => r.artifacts], ["army", r => r.army],
	["experience", r => r.experience], ["income", r => r.income], ["explored %", r => Math.round(r.explored * 100)], ["movement k", r => Math.round(r.movement / 1000)],
];

/** Tachka's numbers at the same days in several runs, one block per metric. */
export function compareRuns(runs: Array<{ name: string; rows: StatRow[] }>, tachka: string): string {
	const days = [...new Set(runs.flatMap(r => checkpoints(r.rows)))].sort((a, b) => a - b).filter(d => d % 10 === 0);
	const out: string[] = [`${tachka} by run`, ["metric".padEnd(12), "run".padEnd(24), ...days.map(d => pad(`d${d}`, 8))].join(" ")];
	for(const [name, pick] of METRICS)
		for(const run of runs) {
			const mine = new Map(run.rows.filter(r => r.player === tachka).map(r => [r.day, r] as const));
			out.push([name.padEnd(12), run.name.slice(0, 24).padEnd(24), ...days.map(d => pad(mine.has(d) ? pick(mine.get(d)!) : "-", 8))].join(" "));
		}
	return out.join("\n");
}

if(import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const player = args.includes("--player") ? args[args.indexOf("--player") + 1] ?? "blue" : "blue";
	const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--player");
	if(files.length === 0) {
		console.error("usage: npm run stats -- <export file> [more files] [--player blue]");
		process.exit(1);
	}
	const runs = files.map(f => ({ name: f.split("/").at(-1) ?? f, rows: parseStats(readFileSync(f, "utf8")) }));
	for(const run of runs)
		console.log(report(run.rows, player), "\n");
	if(runs.length > 1)
		console.log(compareRuns(runs, player));
}
