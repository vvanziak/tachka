import { BridgeError, type BridgeClient } from "./bridge.js";

interface WaitResult {
	yourTurn: boolean;
	battle: boolean;
}

/** Ends our turn and blocks until the next one starts; battles that need orders are handed to BattleAI. */
export async function nextTurn(bridge: BridgeClient, timeoutMs = 30_000): Promise<void> {
	// the bridge refuses to end a turn while a battle runs; fight it out and try again
	for(let attempt = 0; ; attempt++) {
		try {
			await bridge.call("end_turn");
			break;
		}
		catch(e) {
			if(!(e instanceof BridgeError) || !e.message.includes("battle is in progress") || attempt >= 3)
				throw e;
			await bridge.call("battle_act", { action: "autofight" });
		}
	}
	for(;;) {
		const wait = await bridge.call<WaitResult>("wait_for_turn", { timeoutMs }, timeoutMs + 30_000);
		if(wait.yourTurn)
			return;
		if(wait.battle)
			await bridge.call("battle_act", { action: "autofight" });
	}
}
