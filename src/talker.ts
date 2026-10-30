import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain } from "./brain.js";
import type { Tachka } from "./core.js";

const SYSTEM = readFileSync(join(import.meta.dirname, "..", "prompts", "talker.md"), "utf8");
const HISTORY_IN_PROMPT = 24;

interface Line {
	from: "human" | "tachka";
	text: string;
}

/**
 * Answers the human at any moment, also while the turn loop is waiting or thinking. It reads the same journal and facts as
 * the king but does not act; what the human wrote still reaches the king at its next decision.
 */
export class Talker {
	private readonly history: Line[] = [];
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly tachka: Tachka, private readonly brain: Brain, private readonly situation: () => string, private readonly historyPath?: string) {
		if(historyPath && existsSync(historyPath))
			for(const line of readFileSync(historyPath, "utf8").split("\n").filter(Boolean).slice(-60))
				this.history.push(JSON.parse(line) as Line);
		tachka.subscribe(event => {
			if(event.type === "chat" && event.from === "human")
				this.queue = this.queue.then(() => this.reply(event.text));
		});
	}

	private remember(line: Line): void {
		this.history.push(line);
		if(this.historyPath)
			appendFileSync(this.historyPath, JSON.stringify(line) + "\n");
	}

	private async reply(text: string): Promise<void> {
		this.remember({ from: "human", text });
		this.tachka.publish({ type: "typing", on: true });
		try {
			const conversation = this.history.slice(-HISTORY_IN_PROMPT, -1).map(l => `${l.from === "human" ? "Human" : "Tachka"}: ${l.text}`).join("\n");
			const prompt = `SITUATION\n${this.situation()}\n\nCONVERSATION SO FAR\n${conversation || "(none)"}\n\nThe human now writes:\n${text}\n\nAnswer as Tachka.`;
			const { text: answer } = await this.brain.say(SYSTEM, prompt);
			this.remember({ from: "tachka", text: answer });
			this.tachka.note(`(already answered in chat: ${answer.slice(0, 400)})`);
			this.tachka.publish({ type: "chat", from: "king", text: answer });
		}
		catch(e) {
			this.tachka.publish({ type: "problem", text: `could not answer: ${e instanceof Error ? e.message : String(e)}` });
		}
		finally {
			this.tachka.publish({ type: "typing", on: false });
		}
	}
}
