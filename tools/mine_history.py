#!/usr/bin/env python3
"""Turns a Claude Code session transcript of VCMI games into one JSONL file per game, one record per turn:
facts at the start of the turn, the actions taken, short assistant notes and the human's messages.

usage: mine_history.py <transcript.jsonl> <output dir>
"""
import json
import os
import sys

ACTIONS = {"move_hero", "recruit", "build", "swap_stacks", "move_army", "buy_hero", "trade", "upgrade", "build_boat",
           "buy_spellbook", "equip", "answer_question", "battle_act", "save_game"}
NOISE_PREFIXES = ("<", "## Context", "This session is being continued", "[Usage limit", "[Earlier usage", "Your claude.ai usage")
NOISE_SHORT = {"your turn", "done", "play", "ok", "yes", "reconnected", "reconneced", "go ahead", "started", "enjoy!", "fight!"}


def text_of(content):
    if isinstance(content, list):
        return "".join(x.get("text", "") for x in content if isinstance(x, dict))
    return content if isinstance(content, str) else ""


def compact_facts(state):
    objects = state.get("visibleObjects") or []
    return {
        "day": state.get("day"), "dayOfWeek": state.get("dayOfWeek"), "player": state.get("player"), "mapSize": state.get("mapSize"),
        "resources": state.get("resources"),
        "towns": [{k: t.get(k) for k in ("id", "faction", "pos", "buildings", "builtThisTurn", "visitingHero", "garrisonHero")}
                  | {"recruitable": [(r.get("creature"), r.get("available")) for r in t.get("recruitable", [])]} for t in state.get("towns", [])],
        "heroes": [{k: h.get(k) for k in ("id", "name", "class", "level", "pos", "movement", "primarySkills", "secondarySkills")}
                   | {"army": [(a.get("creature"), a.get("count")) for a in h.get("army", [])]} for h in state.get("heroes", [])],
        "visibleObjectCount": len(objects),
    }


def action_entry(name, args, result):
    entry = {"do": name, "args": args}
    if result is None:
        entry["failed"] = True
    if isinstance(result, dict):
        for key in ("built", "reached", "stopped", "error"):
            if key in result:
                entry[key] = result[key]
        if name == "move_hero" and isinstance(result.get("pos"), dict):
            entry["pos"] = result["pos"]
    return entry


def new_turn(game, turn):
    return {"game": game, "turn": turn, "facts": None, "actions": [], "notes": [], "advice": []}


def main(path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    games = []
    game = turn = current = None
    pending = {}

    def start_game():
        nonlocal game, turn, current
        game = len(games) + 1
        turn = 1
        current = new_turn(game, turn)
        games.append([current])

    for line in open(path, errors="replace"):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        kind = record.get("type")
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")

        if kind == "user":
            if isinstance(content, str):
                texts = [content]
            elif isinstance(content, list) and not any(x.get("type") == "tool_result" for x in content if isinstance(x, dict)):
                texts = [text_of(content)]
            else:
                texts = []
            for text in texts:
                text = text.strip()
                if current is not None and len(text) > 3 and not text.startswith(NOISE_PREFIXES) and text.lower().rstrip(".!") not in NOISE_SHORT:
                    current["advice"].append(text[:1500])

        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and kind == "assistant" and current is not None:
                text = block.get("text", "").strip()
                if len(text) > 40 and len(current["notes"]) < 4:
                    current["notes"].append(text[:400])
            elif block.get("type") == "tool_use" and block.get("name", "").startswith("mcp__vcmi__"):
                pending[block["id"]] = (block["name"][len("mcp__vcmi__"):], block.get("input") or {})
            elif block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                name, args = pending.pop(block["tool_use_id"])
                try:
                    result = json.loads(text_of(block.get("content")))
                except ValueError:
                    result = None

                if name == "game_state" and isinstance(result, dict) and "day" in result:
                    if current is None or (result["day"] == 1 and any(r["facts"] and r["facts"]["day"] > 1 for r in games[-1])):
                        start_game()
                    if current["facts"] is None:
                        current["facts"] = compact_facts(result)
                elif current is not None and name in ACTIONS:
                    current["actions"].append(action_entry(name, args, result))
                elif current is not None and name in ("next_turn", "end_turn"):
                    turn += 1
                    current = new_turn(game, turn)
                    games[-1].append(current)

    for records in games:
        records = [r for r in records if r["facts"] or r["actions"]]
        with open(os.path.join(out_dir, f"game-{records[0]['game']:02d}.jsonl"), "w") as out:
            for r in records:
                out.write(json.dumps(r, separators=(",", ":")) + "\n")
        withFacts = [r["facts"] for r in records if r["facts"]]
        first, last = withFacts[0], withFacts[-1]
        towns = (first or {}).get("towns") or [{}]
        print(f"game {records[0]['game']:02d}: {len(records)} turns, days {first and first['day']}..{last and last['day']}, "
              f"{first and first['player']}, {towns[0].get('faction')}, map {first and first['mapSize']}, "
              f"advice {sum(len(r['advice']) for r in records)}")


main(sys.argv[1], sys.argv[2])
