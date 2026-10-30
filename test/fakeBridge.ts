import net from "node:net";

export type Handler = (cmd: string, args: Record<string, unknown>) => unknown;

/** Minimal stand-in for a ClaudeBridge slot: JSON lines in, one reply line out. */
export async function startFakeBridge(handler: Handler): Promise<{ port: number; close: () => Promise<void> }> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", async chunk => {
			buffer += chunk;
			for(let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				const request = JSON.parse(line);
				let reply: object;
				try {
					reply = { id: request.id, result: await handler(request.cmd, request.args), ok: true };
				}
				catch(e) {
					reply = { id: request.id, ok: false, error: (e as Error).message };
				}
				socket.write(JSON.stringify(reply) + "\n");
			}
		});
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		close: () => new Promise(resolve => {
			sockets.forEach(s => s.destroy());
			server.close(() => resolve());
		}),
	};
}
