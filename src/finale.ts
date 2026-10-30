import type { BridgeClient } from "./bridge.js";

/** The last look at the game once it is over: whatever the bridge still answers. Every part is best effort. */
export async function collectFinale(bridge: BridgeClient, gameOver: unknown): Promise<Record<string, unknown>> {
	const final: Record<string, unknown> = { gameOver };
	const attempt = async (key: string, run: () => Promise<unknown>) => {
		try { final[key] = await run(); }
		catch(e) { final[key] = { unavailable: e instanceof Error ? e.message : String(e) }; }
	};
	const state = await bridge.call<{ day: number; resources: unknown; heroes: unknown; towns: Array<{ id: number }> }>("get_state", { radius: 0 }, 10_000).catch(() => undefined);
	if(state) {
		final.day = state.day;
		final.resources = state.resources;
		final.heroes = state.heroes;
		final.towns = state.towns;
		const town = state.towns[0];
		if(town)
			await attempt("thievesGuild", () => bridge.call("thieves_guild", { town: town.id }, 10_000));
	}
	await attempt("threats", () => bridge.call("threats", {}, 10_000));
	return final;
}
