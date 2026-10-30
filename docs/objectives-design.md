# Objectives layer (proposal)

Closes gap 1 in `plan-gaps.md`: the king decides where heroes go and why, not only what towns build. Same rule as the economy plan: the king writes data, code executes it, anything code cannot judge comes back as a deviation.

## Objective

```
{ id, kind, target, why, heroes, requires, byDay? }
kind:     acquire (mine, pile, artifact) | clear (guarded site) | capture (town) | explore | deliver (army to a hero) | hold
target:   object id or tile
why:      what it unblocks, e.g. { "resource": "wood", "unblocks": ["core:mageGuild1", "core:dwellingLvl4"] }
heroes:   assigned hero ids; one is the "main" (army stays with it) and the rest are carriers or scouts
requires: { maxThreat?: number, minRatio?: number }   // safety bound the executor enforces
```

Plan = `economy` (what exists today) + `objectives` + `hire` (buy a hero at a town: `{ town, hero | "best" }`) + `army` (merge everything under hero X at town Y).

## Executor for objectives

Mechanical only: path to the target with `find_path`/`move_hero`, visit it, report `arrived`. Before stepping next to a guarded site it checks the bound from the existing fight rules (`inspect` ratio, neutrals at about 0.5 or lower early, roaming heroes at 1.3x or higher). If the bound fails it stops and returns a deviation (`ratio_too_high`, `unreachable`, `target_gone`, `hero_lost`), never a fight decision. Questions (chests, level-ups) use the existing rules in the playbook, or become deviations when unknown.

## New facts

- **Sites:** known mines, piles, dwellings, artifacts, guarded sites, each with distance in turns and guard ratio (from `targets` and `inspect`).
- **Exploration:** fraction of the map seen per level, and unexplored directions near each hero.
- **Market:** gold-to-each-resource rate.
- **Heroes:** role (main, carrier, scout), army value, movement left, assigned objective.
- **Per-resource sources:** which need has a known source, which has none (the next scouting target).

## When the king is called

Plan older than `reviewByDay`. Any deviation. A new site of a needed resource appears. An enemy hero within reach of a town or a hero. A week turn. A hero or town is lost or gained. A question the rules do not cover.

## Memory window

The king gets the current plan and objectives, the facts now, and a journal of the last N days (N about 5 on a small map, 7 on medium, 10 on large): what each plan decided, which objectives finished, which deviations came up. Anything older stays in the per-turn record file and is fetched by a `history` query (day range or topic) when needed. This keeps the context small and matches how a human remembers "where we came from and where we are going".

## Self-improvement hooks

Every plan and objective has an id; the turn record stores the ids in force. After a game: income curve, day of first dwelling per level, mines flagged by day 10 and 20, army value over time, heroes lost, compared against Nullkiller2 in the same seed. The same numbers can be computed from the mined historical games.

## Open questions

1. Is a hero-level objective the right grain, or does the king also want to say "get wood" and let code pick the nearest known source?
2. Safety bounds: are the numbers in the existing fight rules the ones you would give the executor, or do you decide per situation?
3. Roles: should "main hero keeps all army, carriers deliver" be a hard rule in the executor, or a plan choice?
