import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Tachka, TachkaEvent } from "./core.js";

const HISTORY = 400;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".json": "application/json" };

function body(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", c => { data += c; if(data.length > 100_000) req.destroy(); });
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

/** Local web UI: a page, a server-sent event stream of everything Tachka does, and endpoints for chat, pause and resume. */
export function startServer(tachka: Tachka, port: number): { close: () => void } {
	const page = join(import.meta.dirname, "..", "ui", "index.html");
	const assetsDir = join(import.meta.dirname, "..", "ui", "assets");
	const history: TachkaEvent[] = [];
	const clients = new Set<ServerResponse>();
	let latestFacts: TachkaEvent | undefined;

	const send = (res: ServerResponse, event: TachkaEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
	const unsubscribe = tachka.subscribe(event => {
		if(event.type === "exchange")
			return;
		if(event.type === "facts")
			latestFacts = event;
		history.push(event);
		if(history.length > HISTORY)
			history.shift();
		for(const client of clients)
			send(client, event);
	});

	const server = createServer(async (req, res) => {
		try {
			if(req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(readFileSync(page));
			}
			else if(req.method === "GET" && req.url?.startsWith("/assets/")) {
				const file = normalize(join(assetsDir, decodeURIComponent(req.url.slice("/assets/".length).split("?")[0] ?? "")));
				const type = IMAGE_TYPES[file.slice(file.lastIndexOf("."))];
				if(!file.startsWith(assetsDir) || !type || !existsSync(file))
					res.writeHead(404).end();
				else {
					res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" });
					res.end(readFileSync(file));
				}
			}
			else if(req.method === "GET" && req.url === "/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				for(const event of history.filter(e => e.type !== "facts"))
					send(res, event);
				if(latestFacts)
					send(res, latestFacts);
				send(res, tachka.isPaused ? { type: "paused" } : { type: "resumed" });
				clients.add(res);
				req.on("close", () => clients.delete(res));
			}
			else if(req.method === "POST" && req.url === "/say") {
				const { text } = JSON.parse(await body(req)) as { text?: string };
				if(typeof text === "string" && text.trim())
					tachka.say(text.trim());
				res.writeHead(204).end();
			}
			else if(req.method === "POST" && (req.url === "/pause" || req.url === "/resume")) {
				if(req.url === "/pause") tachka.pause(); else tachka.resume();
				res.writeHead(204).end();
			}
			else
				res.writeHead(404).end();
		}
		catch(e) {
			res.writeHead(400).end(e instanceof Error ? e.message : String(e));
		}
	});
	server.listen(port, "127.0.0.1");
	return { close: () => { unsubscribe(); for(const c of clients) c.end(); server.close(); } };
}
