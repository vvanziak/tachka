#!/usr/bin/env python3
"""Picks decision moments from the per-game files made by mine_history.py.

usage: pick_scenarios.py <mined dir> <output dir>
Kinds: day1 (first turn of a game), starved (gold idle while wood or ore is below 5), advised (turns carrying the human's longest messages).
"""
import glob
import json
import os
import sys

mined, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
picked = []


def save(kind, rec, nxt):
    name = f"{kind}-g{rec['game']:02d}-t{rec['turn']:03d}"
    scenario = {"id": name, "kind": kind, **rec, "nextResources": nxt and nxt["facts"] and nxt["facts"]["resources"]}
    with open(os.path.join(out, name + ".json"), "w") as f:
        json.dump(scenario, f, indent=1)
    picked.append(scenario)


games = {}
for path in sorted(glob.glob(os.path.join(mined, "game-*.jsonl"))):
    games[path] = [json.loads(l) for l in open(path)]

advised = []
for path, recs in games.items():
    faction = next((r["facts"]["towns"][0]["faction"] for r in recs if r["facts"] and r["facts"]["towns"]), None)
    if len(recs) < 10 or faction is None:
        continue
    save("day1", recs[0], recs[1] if len(recs) > 1 else None)
    for i, r in enumerate(recs):
        f = r["facts"]
        if f and f["resources"]["gold"] > 3000 and min(f["resources"]["wood"], f["resources"]["ore"]) < 5:
            save("starved", r, recs[i + 1] if i + 1 < len(recs) else None)
            break
    for i, r in enumerate(recs):
        for a in r["advice"]:
            advised.append((len(a), r, recs[i + 1] if i + 1 < len(recs) else None))

for _, r, nxt in sorted(advised, key=lambda x: -x[0])[:10]:
    if r["facts"]:
        save("advised", r, nxt)

print(f"{'id':22} {'faction':18} {'day':>3} {'gold':>6} {'wood':>4} {'ore':>4} acts adv")
for s in picked:
    f = s["facts"]
    print(f"{s['id']:22} {str(f['towns'][0]['faction'] if f['towns'] else '-'):18} {f['day']:>3} {f['resources']['gold']:>6} {f['resources']['wood']:>4} {f['resources']['ore']:>4} {len(s['actions']):>4} {len(s['advice']):>3}")
