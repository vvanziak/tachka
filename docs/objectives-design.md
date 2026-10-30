# Missions (lean version of the objectives layer)

Closes gap 1 in `plan-gaps.md` without formalizing the game: the king decides, code walks and reports. Game rules, thresholds and tactics stay with the king; code supplies facts and safe primitives.

## Plan additions

- `goTo(hero, target)`: walk toward a tile and stop in front of any guarded tile, so walking never starts a fight. `allowFight` is for a deliberate attack. The outcome says why it stopped: arrived, guarded (with the guard), question pending, no movement left, no path.
- `hire(town, hero)`, `merge(from, to)`: plain actions.
- `intent`: free text the king writes for itself and for later review ("wood for the mage guild").
- Cooperation (unit delivery, a carrier following the main hero) is two missions that name each other. No scheduler, no fixed roles.

## Facts the king gets

- **Sites:** reachable objects from `targets` with distance and, for monsters, size, threat band and strength ratio. Code never picks a source; the king chooses, because a threat may stand on the way.
- Economy facts as before; hero state (position, movement, army, skills, spells) from `get_state`; enemy details on demand from `inspect` and `lookup`.
- Still missing: market rates, exploration coverage, per-resource "no known source" flag.

## When the king is called

Plan past `reviewByDay`, any deviation or stop reason, a new site of a needed resource, an enemy hero near a town or hero, a week turn, a lost or captured town, an unknown question.

## Memory window

Current plan and missions, facts now, and a journal of the last N days (about 5 small map, 7 medium, 10 large). Older turns live in the per-turn record file and are fetched by a `history` query.

## Evaluation

Many games against Nullkiller2 on the same seeds, not single-game judgment: income curve, first dwelling per level, mines flagged by day 10 and 20, army value over time, heroes lost. The same numbers can be computed from the mined historical games.
