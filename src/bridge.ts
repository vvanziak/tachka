import net from "node:net";
import type { BridgeReply, BridgeRequest } from "./protocol.js";

export interface Exchange {
	time: number;
	cmd: string;
	args: Record<string, unknown>;
	ms: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface BridgeOptions {
	port: number;
	host?: string;
	onExchange?: (exchange: Exchange) => void;
}

/** The server rejected the command (`ok: false`). */
export class BridgeError extends Error {}

/** One TCP connection to a player slot. The server handles one request at a time, so calls are serialized. */
export class BridgeClient {
	private socket: net.Socket | undefined;
	private buffer = "";
	private nextId = 1;
	private waiting: { id: number; resolve: (r: BridgeReply) => void; reject: (e: Error) => void } | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: BridgeOptions) {}

	call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<T> {
		const run = () => this.exchange<T>(cmd, args, timeoutMs);
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}

	private async exchange<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
		const started = Date.now();
		const record = (ok: boolean, extra: { result?: unknown; error?: string }) =>
			this.options.onExchange?.({ time: started, cmd, args, ms: Date.now() - started, ok, ...extra });

		try {
			const socket = await this.connected();
			const request: BridgeRequest = { id: this.nextId++, cmd, args };
			const reply = await new Promise<BridgeReply>((resolve, reject) => {
				// after a timeout the reply may still arrive and be taken for the next one, so the connection is dropped and the request is never resent
				const timer = setTimeout(() => {
					this.close();
					reject(new Error(`no reply to ${cmd} within ${timeoutMs} ms`));
				}, timeoutMs);
				this.waiting = {
					id: request.id,
					resolve: r => { clearTimeout(timer); resolve(r); },
					reject: e => { clearTimeout(timer); reject(e); },
				};
				socket.write(JSON.stringify(request) + "\n");
			});
			this.waiting = undefined;

			if(!reply.ok)
				throw new BridgeError(reply.error);
			record(true, { result: reply.result });
			return reply.result as T;
		}
		catch(e) {
			this.waiting = undefined;
			record(false, { error: e instanceof Error ? e.message : String(e) });
			throw e;
		}
	}

	private connected(): Promise<net.Socket> {
		if(this.socket && !this.socket.destroyed)
			return Promise.resolve(this.socket);

		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ port: this.options.port, host: this.options.host ?? "127.0.0.1" });
			socket.setEncoding("utf8");
			socket.once("error", reject);
			socket.once("connect", () => {
				socket.off("error", reject);
				this.socket = socket;
				this.buffer = "";
				socket.on("data", chunk => this.onData(String(chunk)));
				socket.on("close", () => this.onClose(socket));
				socket.on("error", () => socket.destroy());
				resolve(socket);
			});
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for(let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if(!line.trim())
				continue;
			let reply: BridgeReply;
			try {
				reply = JSON.parse(line) as BridgeReply;
			}
			catch {
				this.waiting?.reject(new Error(`bridge sent invalid JSON: ${line.slice(0, 200)}`));
				this.close();
				return;
			}
			this.waiting?.resolve(reply);
		}
	}

	private onClose(socket: net.Socket): void {
		if(this.socket === socket)
			this.socket = undefined;
		this.waiting?.reject(new Error("bridge closed the connection"));
	}
}
