import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";

export interface BrainUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface BrainReply {
	json: unknown;
	usage: BrainUsage;
}

/** A language model that answers with a JSON object matching a schema. Providers live behind this. */
export interface Brain {
	readonly name: string;
	complete(system: string, user: string, schema: object): Promise<BrainReply>;
	/** Free-form answer, for conversation. */
	say(system: string, user: string): Promise<{ text: string; usage: BrainUsage }>;
}

/** Uses the `claude` CLI in print mode, so a Claude Code subscription is enough (no API key). */
export class ClaudeCliBrain implements Brain {
	readonly name: string;

	constructor(private readonly model = "sonnet", private readonly timeoutMs = 180_000) {
		this.name = `claude-cli:${model}`;
	}

	complete(system: string, user: string, schema: object): Promise<BrainReply> {
		return this.run(["--json-schema", JSON.stringify(schema)], system, user).then(reply => {
			if(reply.structured_output === undefined)
				throw new Error(`claude CLI returned no structured output: ${String(reply.result).slice(0, 300)}`);
			return { json: reply.structured_output, usage: this.usage(reply) };
		});
	}

	async say(system: string, user: string): Promise<{ text: string; usage: BrainUsage }> {
		const reply = await this.run([], system, user);
		return { text: String(reply.result ?? "").trim(), usage: this.usage(reply) };
	}

	private usage(reply: any): BrainUsage {
		const u = reply.usage ?? {};
		return {
			inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
			outputTokens: u.output_tokens ?? 0,
			costUsd: reply.total_cost_usd ?? 0,
		};
	}

	private run(extra: string[], system: string, user: string): Promise<any> {
		const args = ["-p", "--output-format", "json", ...extra, "--model", this.model, "--tools", "",
			"--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--system-prompt", system];
		return new Promise((resolve, reject) => {
			const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timer = setTimeout(() => { child.kill(); reject(new Error(`claude CLI did not answer within ${this.timeoutMs} ms`)); }, this.timeoutMs);
			child.stdout.on("data", d => out += d);
			child.stderr.on("data", d => err += d);
			child.on("error", e => { clearTimeout(timer); reject(e); });
			child.on("close", code => {
				clearTimeout(timer);
				try {
					const reply = JSON.parse(out);
					if(reply.is_error)
						throw new Error(String(reply.result ?? err).slice(0, 300));
					resolve(reply);
				}
				catch(e) {
					reject(new Error(`claude CLI exited with ${code}: ${e instanceof Error ? e.message : String(e)} ${err.slice(0, 300)}`));
				}
			});
			child.stdin.end(user);
		});
	}
}

/** Anthropic API with a forced tool call; needs ANTHROPIC_API_KEY. */
export class AnthropicBrain implements Brain {
	readonly name: string;
	private readonly client: Anthropic;

	constructor(private readonly model = process.env.TACHKA_MODEL ?? "claude-sonnet-5-5", client?: Anthropic) {
		this.name = `anthropic:${model}`;
		this.client = client ?? new Anthropic();
	}

	async say(system: string, user: string): Promise<{ text: string; usage: BrainUsage }> {
		const response = await this.client.messages.create({
			model: this.model, max_tokens: 1024,
			system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: user }],
		});
		const text = response.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n").trim();
		return { text, usage: { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens, costUsd: 0 } };
	}

	async complete(system: string, user: string, schema: object): Promise<BrainReply> {
		const response = await this.client.messages.create({
			model: this.model,
			max_tokens: 4096,
			system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
			tools: [{ name: "decide", description: "Your decision for this turn.", input_schema: schema as Anthropic.Tool.InputSchema }],
			tool_choice: { type: "tool", name: "decide" },
			messages: [{ role: "user", content: user }],
		});
		const block = response.content.find(b => b.type === "tool_use");
		if(!block || block.type !== "tool_use")
			throw new Error("the model did not call the decide tool");
		return {
			json: block.input,
			usage: { inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens, costUsd: 0 },
		};
	}
}
