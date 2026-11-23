#!/usr/bin/env python3
"""Kiểm tra đề: schema, q trùng, đáp án hợp lệ, phân bố 1–4, không quá 3 câu liền cùng đáp án,
script 聴解 hợp lệ, ước tính credit ElevenLabs.  Dùng: python3 tools/validate.py [exams/*.json]"""
import json, sys, glob, collections, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECTIONS = {"文字・語彙", "文法", "読解", "聴解"}
SPEAKERS = {"N", "M", "F", "M2", "F2"}

def check(path):
    err, warn = [], []
    ex = json.load(open(path, encoding="utf-8"))
    for k in ("id", "level", "title", "time", "mondai"):
        if k not in ex: err.append(f"thiếu trường {k}")
    seen, seq, chars, texts = set(), [], 0, set()

    def check_script(sc, where):
        nonlocal chars
        if not isinstance(sc, list) or not sc: err.append(f"{where}: script rỗng"); return
        for s in sc:
            if "pause" in s:
                if not isinstance(s["pause"], (int, float)) or s["pause"] <= 0: err.append(f"{where}: pause sai")
            elif s.get("sp") not in SPEAKERS: err.append(f"{where}: speaker sai {s.get('sp')}")
            elif not s.get("text", "").strip(): err.append(f"{where}: text rỗng")
            elif (s["sp"], s["text"]) not in texts:
                texts.add((s["sp"], s["text"])); chars += len(s["text"])

    for m in ex.get("mondai", []):
        if m.get("section") not in SECTIONS: err.append(f"問題{m.get('no')}: section sai")
        L = m.get("section") == "聴解"
        if m.get("script"): check_script(m["script"], f"問題{m['no']} intro")
        for g in m.get("groups", []):
            if g.get("script"): check_script(g["script"], f"問題{m['no']} group")
            for it in g.get("items", []):
                q = it.get("q"); w = f"問題{m['no']} q={q}"
                if q in seen: err.append(f"{w}: q trùng")
                seen.add(q)
                n = len(it["opts"]) if it.get("opts") else it.get("n", 4)
                if not L and (not it.get("opts") or len(it["opts"]) != 4): err.append(f"{w}: cần 4 opts")
                if not isinstance(it.get("ans"), int) or not 1 <= it["ans"] <= n: err.append(f"{w}: ans ngoài 1..{n}")
                if not it.get("exp"): warn.append(f"{w}: thiếu lời giải")
                if L:
                    if it.get("script"): check_script(it["script"], w)
                    elif not g.get("script"): err.append(f"{w}: câu nghe không có script (item/group)")
                elif not it.get("stem"): err.append(f"{w}: thiếu stem")
                seq.append((w, it.get("ans")))

    run = 1
    for i in range(1, len(seq)):
        run = run + 1 if seq[i][1] == seq[i - 1][1] else 1
        if run > 3: err.append(f"{seq[i][0]}: {run} câu liền cùng đáp án {seq[i][1]}")
    dist = collections.Counter(a for _, a in seq)
    return ex, err, warn, dist, len(seq), chars, len(texts)

def main():
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "public/exams/*-*.json")))
    index = json.load(open(os.path.join(ROOT, "public/exams/index.json"), encoding="utf-8"))
    ids = {e["id"]: e for e in index}
    bad = 0
    for f in files:
        ex, err, warn, dist, n, chars, segs = check(f)
        if ex["id"] not in ids: err.append("không có trong index.json")
        elif ids[ex["id"]].get("listening") != (segs > 0): warn.append("index.json: cờ listening không khớp")
        print(f"== {os.path.basename(f)}: {n} câu, đáp án {dict(sorted(dist.items()))}"
              + (f", 聴解 {segs} đoạn / {chars} ký tự ≈ {chars // 2} credit" if segs else ""))
        for w in warn: print("  ! " + w)
        for e in err: print("  ✗ " + e)
        bad += len(err)
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
