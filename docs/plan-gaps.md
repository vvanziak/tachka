# What the plan format cannot say yet

Found by writing plans for three recorded situations (`plans/`). Each gap names the scenario that shows it.

1. **Heroes and objectives** (all three). The decisions that matter on day 1 are not economic: buy a second hero, merge the army under the main hero, send the main hero for chests and weekly creatures, the second one for mines, go for ore first. A plan can only build and recruit. Needs an objectives layer: a target (mine, pile, dwelling), the heroes assigned, the army ratio required, and what it unblocks.
2. **Reserves protect only against recruiting** (g17: sulfur for the dragon dwelling). Another build can still spend the reserved sulfur. Reserves should apply to every spend except the step that names `usesReserve`.
3. **Facts lack the way out of a shortage** (g01: ore 0, 5440 gold idle). The executor reports `blocked_by_resource: ore`, but nothing says where ore is: no known mines or piles, their distance, their guard, or the marketplace rate for gold to ore.
4. **Recruit policy is per level, not per intent** (g05). "Keep gold for the next build" is written as a gold reserve plus level filter; a stock-by-stock choice such as "shooters first" needs creature roles in the facts.
5. **Recorded situations cannot be replayed against the executor.** The mined facts carry no `get_buildable` options or costs, so a past turn can seed a planner prompt but not drive `executePlan`.
6. **Scenario selection is rough.** `starved-g01-t011` carries assistant notes about loading a save, not about the decision, and the turn index counts every `end_turn` including startup retries.
