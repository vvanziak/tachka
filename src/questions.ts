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

/** Fixed answers for the dialogs that come up every few turns; undefined means the loop cannot judge and stops. */
export function defaultAnswer(question: Question): number | undefined {
	if(question.kind === "level_up" && question.choices?.length) {
		const preferred = SKILL_PREFERENCE.find(skill => question.choices?.includes(skill));
		return preferred ? question.choices.indexOf(preferred) : 0;
	}
	if(question.kind === "dialog")
		return 1;
	return undefined;
}
