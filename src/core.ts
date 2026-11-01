import { BridgeClient, type BridgeOptions, type Exchange } from "./bridge.js";

export interface KingUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export type TachkaEvent =
	| { type: "chat"; from: "human" | "king"; text: string }
	| { type: "exchange"; exchange: Exchange }
	| { type: "facts"; facts: unknown }
	| { type: "turn"; day: number; line: string; journal: unknown }
	| { type: "king"; note: string; usage: KingUsage; total: KingUsage; ms: number }
	| { type: "problem"; text: string }
	| { type: "status"; text: string }
	| { type: "typing"; on: boolean }
	| { type: "query"; text: string }
	| { type: "review"; findings: string[]; revised: boolean }
	| { type: "final"; final: unknown }
	| { type: "paused" }
	| { type: "resumed" };

type Listener = (event: TachkaEvent) => void;

/** Headless core: owns the bridge connection, the human's message inbox and the event stream that UIs subscribe to. */
export class Tachka {
	readonly bridge: BridgeClient;
	private readonly listeners = new Set<Listener>();
	private inbox: string[] = [];
	private paused = false;

	private events: string[] = [];

	constructor(options: BridgeOptions) {
		this.bridge = new BridgeClient({
			...options,
			onExchange: exchange => {
				options.onExchange?.(exchange);
				this.collectEvents(exchange);
				this.publish({ type: "exchange", exchange });
			},
		});
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A message from the human; the brain takes it from the inbox at the next decision point. */
	say(text: string): void {
		this.inbox.push(text);
		this.publish({ type: "chat", from: "human", text });
	}

	/** What the game reported since the last call: battle results, pickups, messages. */
	drainEvents(): string[] {
		const events = this.events;
		this.events = [];
		return events;
	}

	private collectEvents(exchange: Exchange): void {
		const result = exchange.result as { events?: unknown; status?: { events?: unknown } } | undefined;
		for(const list of [result?.events, result?.status?.events])
			if(Array.isArray(list))
				for(const e of list)
					if(typeof e === "string" && e !== "your turn started" && !this.events.includes(e))
						this.events.push(e.replace(/\r?\n+/g, " ").slice(0, 220));
		if(this.events.length > 60)
			this.events.splice(0, this.events.length - 60);
	}

	/** A line for the king's next brief that is not shown in the chat (what the talker already told the human). */
	note(text: string): void {
		this.inbox.push(text);
	}

	/** Puts back what a brief had taken when the turn is played again. */
	restore(messages: string[], events: string[]): void {
		this.inbox = [...messages, ...this.inbox];
		this.events = [...events, ...this.events];
	}

	drainInbox(): string[] {
		const messages = this.inbox;
		this.inbox = [];
		return messages;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	pause(): void {
		this.paused = true;
		this.publish({ type: "paused" });
	}

	resume(): void {
		this.paused = false;
		this.publish({ type: "resumed" });
	}

	publish(event: TachkaEvent): void {
		for(const listener of this.listeners)
			listener(event);
	}
}
