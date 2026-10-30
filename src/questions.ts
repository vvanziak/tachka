const SKILL_PREFERENCE = [
	"core:wisdom", "core:earthMagic", "core:airMagic", "core:logistics", "core:scouting", "core:leadership",
	"core:offence", "core:armorer", "core:diplomacy", "core:estates", "core:resistance", "core:archery",
];

export interface Question {
	id: number;
	kind?: string;
	text?: string;
	selection?: boolean;
	choices?: string[];
}

export interface AnswerContext {
	/** The mission being walked deliberately attacks what guards the target. */
	allowFight?: boolean;
}

/** Fixed answers for the dialogs that come up every few turns; undefined means the loop cannot judge and stops. */
export function defaultAnswer(question: Question, context: AnswerContext = {}): number | undefined {
	if(question.kind === "level_up" && question.choices?.length) {
		const preferred = SKILL_PREFERENCE.find(skill => question.choices?.includes(skill));
		return preferred ? question.choices.indexOf(preferred) : 0;
	}
	if(question.kind === "dialog") {
		const text = question.text ?? "";
		// a fight the king did not ask for, a recruitment prompt (the plan recruits in towns), and paid experience (too early to buy)
		if(/wish to fight|attack the/i.test(text))
			return context.allowFight ? 1 : 0;
		if(/recruit/i.test(text) || /Tree of Knowledge/i.test(text))
			return 0;
		return 1;
	}
	// closing a dwelling's recruitment window or a hero exchange; the king recruits through the plan
	if(question.kind === "recruitment" || question.kind === "hero_exchange")
		return 0;
	return undefined;
}
