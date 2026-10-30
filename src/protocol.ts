// Wire format of the ClaudeBridge TCP protocol; the server side is AI/ClaudeBridge in the VCMI fork.
export const BASE_PORT = 37100;
export const PLAYER_COLORS = ["red", "blue", "tan", "green", "orange", "purple", "teal", "pink"] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export function portForPlayer(color: PlayerColor): number {
	return BASE_PORT + PLAYER_COLORS.indexOf(color);
}

export interface BridgeRequest {
	id: number;
	cmd: string;
	args: Record<string, unknown>;
}

export type BridgeReply =
	| { id: number | null; ok: true; result: unknown }
	| { id: number | null; ok: false; error: string };
