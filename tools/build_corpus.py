#!/usr/bin/env python3
"""Cập nhật data/corpus.json:
- structure: số câu chuẩn mỗi 問題 theo cấp độ (giữ nguyên nếu đã có)
- used: mục từ/ngữ pháp đã dùng ở đề nào (tự trích: chữ <u>gạch chân</u> hoặc đáp án đúng)
- reference: từ vựng/ngữ pháp trích từ đề tham khảo (điền tay / bằng Claude khi đọc đề gốc) — không bị ghi đè."""
import json, glob, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "data/corpus.json")
strip = lambda s: re.sub(r"<[^>]+>", "", s or "").strip()

corpus = json.load(open(PATH, encoding="utf-8")) if os.path.exists(PATH) else {}
corpus.setdefault("reference", {"N1": {"vocab": [], "grammar": []}, "N2": {"vocab": [], "grammar": []}})
used = {}
for f in sorted(glob.glob(os.path.join(ROOT, "public/exams/*-*.json"))):
    ex = json.load(open(f, encoding="utf-8"))
    for m in ex["mondai"]:
        if m["section"] not in ("文字・語彙", "文法"): continue
        for g in m["groups"]:
            for it in g["items"]:
                u = re.search(r"<u>(.*?)</u>", it.get("stem", ""))
                if m["section"] == "文字・語彙":
                    key = strip(u.group(1)) if u else strip(it["opts"][it["ans"] - 1])
                else:
                    if "★" in it.get("stem", ""): continue  # 並べ替え: không có 1 mục duy nhất
                    key = strip(it["opts"][it["ans"] - 1])
                if not key: continue
                e = used.setdefault(ex["level"], {}).setdefault(m["section"], {}).setdefault(key, [])
                tag = f"{ex['id']}#{it['q']}"
                if tag not in e: e.append(tag)
corpus["used"] = used
corpus["structure"] = corpus.get("structure") or {
    "N2": {"ref": "T7-2023", "言語知識・読解": {"1": 5, "2": 5, "3": 3, "4": 7, "5": 5, "6": 5, "7": 12, "8": 5, "9": 4,
                                              "10": 5, "11": 8, "12": 2, "13": 3, "14": 2}, "time": 105,
           "聴解": {"1": 5, "2": 6, "3": 5, "4": 12, "5": 4}, "listenTime": 50},
    "N1": {"ref": "T12-2021", "言語知識・読解": {"1": 6, "2": 7, "3": 6, "4": 6, "5": 10, "6": 5, "7": 4, "8": 4,
                                               "9": 9, "10": 4, "11": 3, "12": 3, "13": 2}, "time": 110,
           "聴解": {"1": 6, "2": 7, "3": 6, "4": 14, "5": 4}, "listenTime": 60},
}
os.makedirs(os.path.dirname(PATH), exist_ok=True)
json.dump(corpus, open(PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print({lv: {s: len(v) for s, v in d.items()} for lv, d in used.items()})
