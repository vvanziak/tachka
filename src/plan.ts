import { z } from "zod";
import { RESOURCES } from "./state.js";

const amount = z.object(Object.fromEntries(RESOURCES.map(r => [r, z.number().int().nonnegative().optional()]))).strict();

/** `wait`: when only gold is short, stop and save for this building; `skip`: go on to the next step. */
const buildStep = z.object({
	building: z.string(),
	onShortage: z.enum(["wait", "skip"]).default("wait"),
	/** Label of a reserve that is released once this building is built. */
	usesReserve: z.string().optional(),
}).strict();

const recruitPolicy = z.object({
	mode: z.enum(["all", "levels", "none"]),
	levels: z.array(z.number().int().nonnegative()).optional(),
}).strict().refine(r => r.mode !== "levels" || (r.levels?.length ?? 0) > 0, { message: 'mode "levels" needs a non-empty "levels"' });

const townPlan = z.object({
	town: z.number().int(),
	role: z.string().optional(),
	build: z.array(buildStep).default([]),
	recruit: recruitPolicy.default({ mode: "none" }),
}).strict();

/** The king's decisions for the economy: what each town builds, in which order, what it recruits, and what gold stays untouched. */
export const planSchema = z.object({
	madeOnDay: z.number().int(),
	reviewByDay: z.number().int(),
	note: z.string().optional(),
	/** Withheld from recruiting; builds may spend it. A step's `usesReserve` releases it once built. */
	reserves: z.array(z.object({ label: z.string(), amount: amount }).strict()).default([]),
	/** Towns in priority order: earlier towns draw on the shared treasury first. */
	towns: z.array(townPlan),
}).strict();

export type Plan = z.infer<typeof planSchema>;
export type TownPlan = z.infer<typeof townPlan>;

export function parsePlan(json: unknown): Plan {
	const result = planSchema.safeParse(json);
	if(!result.success)
		throw new Error("invalid plan: " + result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
	return result.data;
}
