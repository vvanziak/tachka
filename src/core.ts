import { BridgeClient, type BridgeOptions, type Exchange } from "./bridge.js";

export type TachkaEvent =
	| { type: "chat"; from: "human" | "tachka"; text: string }
	| { type: "exchange"; exchange: Exchange }
	| { type: "paused" }
	| { type: "resumed" };

type Listener = (event: TachkaEvent) => void;

/** Headless core: owns the bridge connection, the human's message inbox and the event stream that UIs subscribe to. */
export class Tachka {
	readonly bridge: BridgeClient;
	private readonly listeners = new Set<Listener>();
	private inbox: string[] = [];
	private paused = false;

	constructor(options: BridgeOptions) {
		this.bridge = new BridgeClient({
			...options,
			onExchange: exchange => {
				options.onExchange?.(exchange);
				this.emit({ type: "exchange", exchange });
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
		this.emit({ type: "chat", from: "human", text });
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
		this.emit({ type: "paused" });
	}

	resume(): void {
		this.paused = false;
		this.emit({ type: "resumed" });
	}

	private emit(event: TachkaEvent): void {
		for(const listener of this.listeners)
			listener(event);
	}
}
