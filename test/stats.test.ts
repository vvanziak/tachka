import { describe, expect, it } from "vitest";
import { checkpoints, compareRuns, parseStats, report } from "../tools/compare-stats.js";

const HEAD = ["Map", "Timestamp", "Day", "Player", "PlayerName", "Team", "IsHuman", "Status", "NumberHeroes", "NumberTowns", "NumberArtifacts", "NumberDwellings", "ArmyStrength", "TotalExperience", "Income", "MapExploredRatio", "ObeliskVisitedRatio", "TownBuiltRatio", "HasGrail", "Score", "MaxHeroLevel", "NumBattlesNeutral", "NumBattlesPlayer", "NumWinBattlesNeutral", "NumWinBattlesPlayer", "NumHeroSurrendered", "NumHeroEscaped", "EventCapturedTown", "EventDefeatedStrongestHero", "MovementPointsUsed", "gold"];
const row = (day: number, player: string, human: number, status: number, heroes: number, towns: number, explored: number, movement: number) =>
	["Sands", "t", day, player, "p", 0, human, status, heroes, towns, 4, 1, 5000, 300, 2000, explored, 0, 0.3, 0, 199, 2, 3, 1, 2, 1, 0, 0, 0, 0, movement, 900].join(";");
const csv = [HEAD.join(";"), row(10, "red", 1, 0, 2, 1, 0.3, 120000), row(10, "blue", 0, 0, 1, 1, 0.1, 70000), row(12, "blue", 0, 1, 0, 0, 0.1, 80000)].join("\r\n");

describe("compare-stats", () => {
	it("reads the semicolon export and the tab-separated copy", () => {
		const rows = parseStats(csv);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatchObject({ player: "blue", heroes: 1, movement: 70000, isHuman: false });
		expect(parseStats(csv.replaceAll(";", "\t"))).toEqual(rows);
	});

	it("marks Tachka, notes when it dropped out and lines up several runs", () => {
		const rows = parseStats(csv);
		expect(checkpoints(rows)).toEqual([10, 12]);
		const text = report(rows, "blue");
		expect(text).toContain("blue*");
		expect(text).toContain("red (you)");
		expect(text).toContain("blue was out of the game on day 12");
		const both = compareRuns([{ name: "a", rows }, { name: "b", rows }], "blue");
		expect(both).toContain("explored %");
		expect(both.split("\n").filter(l => l.startsWith("movement k"))).toHaveLength(2);
	});
});
