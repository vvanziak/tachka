import type { BridgeClient } from "./bridge.js";

interface WaitResult {
	yourTurn: boolean;
	battle: boolean;
}

/** Ends our turn and blocks until the next one starts; battles that need orders are handed to BattleAI. */
export async function nextTurn(bridge: BridgeClient, timeoutMs = 30_000): Promise<void> {
	await bridge.call("end_turn");
	for(;;) {
		const wait = await bridge.call<WaitResult>("wait_for_turn", { timeoutMs }, timeoutMs + 30_000);
		if(wait.yourTurn)
			return;
		if(wait.battle)
			await bridge.call("battle_act", { action: "autofight" });
	}
}
