#!/usr/bin/env python3
"""Sinh bộ thẻ ôn tập hằng ngày → public/quests/N2.json, N1.json

Nguồn:
  data/base_N2.json           thẻ nền (tools/quests_n2.py) — giữ nguyên id để không mất lịch ôn
  data/sources/notebook/*.json  "Sổ tay JLPT N1–N2" (tác vụ Ôn tập buổi sáng): vocab, grammar, quiz, test
  data/sources/news/*.json      "Sổ tay Đọc báo Nhật": vocab của từng bài
  data/corpus.json              reference = từ/mẫu đã ra trong đề thật → gắn nhãn "Đã ra thi", học trước

Mỗi thẻ: {id, type, stem, opts, ans, exp, tag, modes[, flipQ, src, exam]}
  modes: dạng bài cho phép — "mc" (trắc nghiệm), "type" (gõ cách đọc), "flip" (lật thẻ tự chấm)
Id ổn định theo nội dung (hash từ/mẫu) → chạy lại không làm mất lịch ôn.
Dùng: python3 tools/build_cards.py"""
import glob, hashlib, json, os, random, re, unicodedata
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rnd = random.Random(20261127)
h = lambda s: hashlib.sha1(s.encode()).hexdigest()[:8]
KANJI = re.compile(r"[一-鿿々]")
HIRA = lambda s: all("぀" <= c <= "ゟ" or c == "ー" for c in s)

def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def load_dir(d):
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, d, "*.json"))):
        x = json.load(open(f, encoding="utf-8")); out.append(x.get("data", x))
    return out

# ---------- Đề thật: từ/mẫu đã ra thi ----------
corpus = json.load(open(os.path.join(ROOT, "data/corpus.json"), encoding="utf-8"))
def normp(p):  # chuẩn hoá mẫu ngữ pháp để so khớp
    p = re.sub(r"[（(][^）)]*[）)]", "", p)
    return re.sub(r"[～〜~\s]", "", p)
EXAM = defaultdict(set)
for lv, ref in corpus.get("reference", {}).items():
    for v in ref.get("vocab", []): EXAM[(lv, v["w"])].add(v.get("src", ""))
    for g in ref.get("grammar", []): EXAM[(lv, normp(g["p"]))].add(g.get("src", ""))
def exam_of(lv, key):
    s = EXAM.get((lv, key)) or EXAM.get((lv, normp(key)))
    return sorted(s) if s else None

# ---------- Sinh phương án nhiễu cho cách đọc ----------
VOICE = dict(zip("かきくけこさしすせそたちつてとはひふへほ", "がぎぐげござじずぜぞだぢづでどばびぶべぼ"))
VOICE.update({v: k for k, v in VOICE.items()})
SMALL = {"や": "ゃ", "ゆ": "ゅ", "よ": "ょ", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ"}
LONG = [("おう", "お"), ("えい", "え"), ("うう", "う"), ("いい", "い"), ("ゅう", "ゅ"), ("ょう", "ょ")]   # chỉ rút ngắn
O_ROW, E_ROW = set("こそとのほもよろごぞどぼぽょ"), set("けせてねへめれげぜでべぺ")
def reading_distractors(r, protect_suffix, pool):
    core, suf = (r[:-len(protect_suffix)], protect_suffix) if protect_suffix and r.endswith(protect_suffix) else (r, "")
    cands = set()
    for a, b in LONG:
        if a in core: cands.add(core.replace(a, b, 1))          # trường âm → âm ngắn
    for i, c in enumerate(core):                                   # âm ngắn → trường âm (お段+う, え段+い)
        nxt = core[i + 1] if i + 1 < len(core) else ""
        if c in O_ROW and nxt != "う": cands.add(core[:i + 1] + "う" + core[i + 1:])
        if c in E_ROW and nxt != "い": cands.add(core[:i + 1] + "い" + core[i + 1:])
    for i, c in enumerate(core):
        if c in VOICE: cands.add(core[:i] + VOICE[c] + core[i + 1:])
        if c in SMALL: cands.add(core[:i] + SMALL[c] + core[i + 1:])
        if c == "っ": cands.add(core[:i] + core[i + 1:])
        if i < len(core) - 1 and core[i + 1] in "かきくけこさしすせそたちつてとぱぴぷぺぽ" and c not in "っん":
            cands.add(core[:i + 1] + "っ" + core[i + 1:])
    cands = [c + suf for c in cands if c and c + suf != r and HIRA(c)]
    rnd.shuffle(cands)
    out = cands[:3]
    others = [p for p in pool if p != r and p not in out and abs(len(p) - len(r)) <= 1]
    rnd.shuffle(others)
    while len(out) < 3 and others: out.append(others.pop())
    return out if len(out) == 3 else None

def kana_suffix(word, reading):
    """Phần okurigana chung ở cuối (狙う/ねらう → う) để không đổi khi tạo nhiễu."""
    suf = ""
    for a, b in zip(reversed(word), reversed(reading)):
        if a == b and HIRA(a): suf = a + suf
        else: break
    return suf

def mark(sentence, word):
    i = sentence.find(word)
    return (sentence[:i] + "<u>" + word + "</u>" + sentence[i + len(word):]) if i >= 0 else None

def blank(sentence, word):
    i = sentence.find(word)
    return (sentence[:i] + "（　）" + sentence[i + len(word):]) if i >= 0 else None

STRIP = re.compile(r"\[\[([^\]|]+)(?:\|([^\]|]*))?(?:\|([^\]]*))?\]\]|\{([^}|]+)\|([^}]*)\}")
def plain(s):  # bỏ markup furigana của sổ tay đọc báo
    return STRIP.sub(lambda m: m.group(1) or m.group(4), s)

def vocab_exp(v):
    hv = f" {v['hv']}" if v.get("hv") else ""
    ex = f"<br>例：{esc(v['ex'])}" + (f"（{esc(v['exVi'])}）" if v.get("exVi") else "") if v.get("ex") else ""
    reg = {"viet": " · <i>văn viết</i>", "noi": " · <i>khẩu ngữ</i>"}.get(v.get("reg"), "")
    tip = f" → nói: {esc(v['regTip'])}" if v.get("reg") == "viet" and v.get("regTip") else ""
    return f"{esc(v['w'])}（{esc(v['r'])}）{hv}: {esc(v['m'])}{reg}{tip}{ex}"

# ---------- Từ vựng ----------
def vocab_cards(lv, entries, deck_id, src_label, pools):
    """entries: [{w,r,m,hv,ex,exVi,reg,regTip,date}] → thẻ đọc + thẻ điền từ"""
    cards = []
    by_date = defaultdict(list)
    for v in entries: by_date[v["date"]].append(v)
    for v in entries:
        w, r = v["w"], v["r"]
        base = f"{lv}-{deck_id}-{h(w)}"
        exam = exam_of(lv, w)
        src = f"{src_label} {v['date'][8:10]}/{v['date'][5:7]}"
        # 1) Cách đọc (chỉ từ có kanji)
        if KANJI.search(w) and HIRA(r):
            ds = reading_distractors(r, kana_suffix(w, r), pools["readings"])
            if ds:
                stem = (mark(v["ex"], w) if v.get("ex") else None) or f"<u>{esc(w)}</u>"
                cards.append({"id": base + "-r", "type": "漢字読み", "stem": stem, "opts": [r] + ds, "ans": 1,
                              "exp": vocab_exp(v), "tag": w, "modes": ["mc", "type", "flip"],
                              "flipQ": "Đọc là gì? Nghĩa là gì?", "src": src, **({"exam": exam} if exam else {})})
        # 2) Điền từ vào câu ví dụ (phương án nhiễu: từ khác cùng ngày → cùng cấp)
        st = blank(v["ex"], w) if v.get("ex") else None
        if st:
            same = [x["w"] for x in by_date[v["date"]] if x["w"] != w and x["w"] not in v["ex"]]
            rnd.shuffle(same)
            more = [x for x in pools["words"] if x != w and x not in same and x not in v["ex"]]
            rnd.shuffle(more)
            ds = (same + more)[:3]
            if len(ds) == 3:
                cards.append({"id": base + "-c", "type": "語彙", "stem": esc(st), "opts": [w] + ds, "ans": 1,
                              "exp": vocab_exp(v), "tag": w, "modes": ["mc", "flip"],
                              "flipQ": "Nghĩa là gì? Dùng trong câu thế nào?", "src": src, **({"exam": exam} if exam else {})})
    return cards

# ---------- Ngữ pháp ----------
JP = re.compile(r"[ぁ-んァ-ヶ一-龯々ー]{2,}")
def grammar_cards(lv, entries, deck_id):
    cards = []
    by_date = defaultdict(list)
    for g in entries: by_date[g["date"]].append(g)
    allp = [normp(g["pattern"]) for g in entries]
    # dạng hiển thị: bỏ ～ ở đầu/cuối và phần trong ngoặc, giữ ～ ở giữa (さえ～ば)
    disp = {normp(g["pattern"]): re.sub(r"^[～〜]+|[～〜]+$", "", re.sub(r"[（(][^）)]*[）)]", "", g["pattern"]).split("／")[0].strip()) for g in entries}
    for g in entries:
        p = normp(g["pattern"])
        if not p: continue
        exam = exam_of(lv, g["pattern"])
        src = f"Sổ tay {g['date'][8:10]}/{g['date'][5:7]}"
        reg = {"viet": " · <i>văn viết</i>", "noi": " · <i>khẩu ngữ</i>"}.get(g.get("reg"), "")
        tip = f" → nói: {esc(g['regTip'])}" if g.get("regTip") else ""
        exp = (f"<b>{esc(g['pattern'])}</b>（{esc(g.get('form', ''))}）: {esc(g['meaning'])}{reg}{tip}"
               + (f"<br>Phân biệt: {esc(g['note'])}" if g.get("note") else "")
               + (f"<br>例：{esc(g['ex'])}（{esc(g.get('exVi', ''))}）" if g.get("ex") else ""))
        # thử các biến thể của mẫu trong câu ví dụ (bỏ phần trong ngoặc, tách theo ／・)
        variants = [p] + [normp(x) for x in re.split(r"[／/・]", re.sub(r"[（(][^）)]*[）)]", "", g["pattern"])) if normp(x)]
        found = next((x for x in variants if x and g.get("ex") and x in g["ex"]), None)
        card = {"id": f"{lv}-{deck_id}-{h(g['pattern'])}", "type": "文法", "tag": g["pattern"], "exp": exp,
                "flipQ": "Nghĩa là gì? Phân biệt với mẫu dễ nhầm?", "src": src, **({"exam": exam} if exam else {})}
        if found:
            # nhiễu: CHỈ lấy mẫu của ngày khác (nhóm khác). Loại mẫu cùng nhóm hôm đó và mẫu được nhắc trong
            # "note" — chúng thường gần nghĩa (vd ほかない/しかない) nên có thể cùng đúng.
            noted = {normp(m) for m in JP.findall(g.get("note", "") + g.get("meaning", ""))}
            same_day = {normp(y["pattern"]) for y in by_date[g["date"]]}
            other = [x for x in dict.fromkeys(allp) if x != found and x not in noted and x not in same_day
                     and x not in g["ex"] and found not in x and x not in found]
            rnd.shuffle(other)
            ds = [disp.get(x, x) for x in other[:3]]
            if len(ds) == 3:
                card.update({"stem": esc(blank(g["ex"], found)), "opts": [found] + ds, "ans": 1, "modes": ["mc", "flip"]})
                cards.append(card); continue
        # không tách được câu điền → thẻ lật
        card.update({"stem": esc(g.get("ex", g["pattern"])), "opts": [g["pattern"]], "ans": 1, "modes": ["flip"]})
        cards.append(card)
    return cards

# ---------- Câu trắc nghiệm có sẵn (quiz hằng ngày + kiểm tra tuần) ----------
def quiz_cards(lessons, levels_of):
    out = {"N2": [], "N1": []}
    for L in lessons:
        qs = [("q", i, q) for i, q in enumerate(L.get("quiz", []))]
        qs += [("t", i, q) for i, q in enumerate((L.get("test") or {}).get("questions", [])) if q.get("area") != "reading"]
        for kind, i, q in qs:
            opts = q.get("options") or []
            if len(opts) != 4 or not isinstance(q.get("answer"), int) or not 0 <= q["answer"] < 4: continue
            right = opts[q["answer"]]
            lv = "N2"
            for ref in q.get("refs", []):
                k = ref.split(":", 1)[-1]
                if levels_of.get(normp(k)) or levels_of.get(k): lv = levels_of.get(normp(k)) or levels_of.get(k); break
            else:
                lv = levels_of.get(normp(right)) or levels_of.get(right) or "N2"
            stem = re.sub(r"^\(ôn\)\s*", "", q["q"])
            out[lv].append({"id": f"{lv}-nbq-{L['date']}-{kind}{i}", "type": {"vocab": "語彙", "grammar": "文法"}.get(q.get("area"), "総合"),
                            "stem": esc(stem), "opts": [esc(o) for o in opts], "ans": q["answer"] + 1,
                            "exp": esc(q.get("explain", "")), "tag": right, "modes": ["mc"],
                            "src": f"{'Kiểm tra tuần' if kind == 't' else 'Quiz'} {L['date'][8:10]}/{L['date'][5:7]}"})
    return out

def main():
    lessons = load_dir("data/sources/notebook")
    issues = load_dir("data/sources/news")
    # Từ vựng sổ tay JLPT
    nbv = {"N2": [], "N1": []}; nbg = {"N2": [], "N1": []}; levels_of = {}
    seen_w = set()
    for L in lessons:
        for v in L.get("vocab", []):
            lv = v.get("level") if v.get("level") in ("N1", "N2") else "N2"
            e = {"w": v["word"], "r": v.get("reading", ""), "m": v.get("meaning", ""), "hv": v.get("hanviet", ""), "ex": v.get("ex", ""),
                 "exVi": v.get("exVi", ""), "reg": v.get("reg"), "regTip": v.get("regTip", ""), "date": L["date"]}
            if e["w"] in seen_w: continue
            seen_w.add(e["w"]); nbv[lv].append(e); levels_of[e["w"]] = lv
        for g in L.get("grammar", []):
            lv = g.get("level") if g.get("level") in ("N1", "N2") else "N2"
            nbg[lv].append({**g, "date": L["date"]}); levels_of[normp(g["pattern"])] = lv
    # Từ vựng đọc báo (bỏ từ đã có trong sổ tay JLPT); câu ví dụ lấy từ chính bài báo
    nwv = {"N2": [], "N1": []}
    for I in issues:
        for a in I.get("articles", []):
            sents = [s + "。" for p in a.get("paras", []) for s in plain(p).split("。") if s.strip()]
            for v in a.get("vocab", []):
                w = v.get("w") or v.get("k"); lv = v.get("lv")
                if lv not in ("N1", "N2") or not w or w in seen_w: continue
                seen_w.add(w)
                ex = next((s for s in sents if w in s and len(s) <= 90), "")
                nwv[lv].append({"w": w, "r": v.get("r", ""), "m": v.get("m", ""), "hv": v.get("hv", "") if v.get("hv") != "—" else "",
                                "ex": ex, "exVi": "", "reg": None, "regTip": "", "date": I["date"]})
                levels_of.setdefault(w, lv)
    pools = {"readings": [e["r"] for d in (nbv, nwv) for L in d.values() for e in L if e["r"]],
             "words": [e["w"] for d in (nbv, nwv) for L in d.values() for e in L]}
    qz = quiz_cards(lessons, levels_of)

    base = json.load(open(os.path.join(ROOT, "data/base_N2.json"), encoding="utf-8"))
    for q in base["quests"]:
        for it in q["items"]:
            it["modes"] = ["mc", "type"] if it["type"] == "漢字読み" else (["mc"] if it["type"] in ("漢字書き", "語形成", "narabe") else ["mc", "flip"])
            ex = exam_of("N2", it["tag"]);  ex and it.update(exam=ex)
            it.setdefault("src", "Bộ cơ bản")

    stats = {}
    for lv in ("N2", "N1"):
        groups, quests = [], []
        if lv == "N2":
            groups += base["groups"]; quests += base["quests"]
        groups += [{"id": "notebook", "title": "Sổ tay JLPT", "desc": "Từ vựng & ngữ pháp từ bài ôn buổi sáng"},
                   {"id": "news", "title": "Đọc báo Nhật", "desc": "Từ khó trong các bài báo đã đọc"}]
        decks = [
            ("nbv", "notebook", "Từ vựng", "Sổ tay · 語彙", "Cách đọc + điền từ vào câu ví dụ", vocab_cards(lv, nbv[lv], "nbv", "Sổ tay", pools)),
            ("nbg", "notebook", "Ngữ pháp", "Sổ tay · 文法", "Chọn mẫu đúng trong câu ví dụ, phân biệt mẫu dễ nhầm", grammar_cards(lv, nbg[lv], "nbg")),
            ("nbq", "notebook", "Câu hỏi ôn", "Sổ tay · 練習問題", "Quiz hằng ngày và kiểm tra tuần", qz[lv]),
            ("nwv", "news", "Từ vựng", "Đọc báo · 語彙", "Từ khó trong bài báo, câu ví dụ lấy từ chính bài", vocab_cards(lv, nwv[lv], "nwv", "Báo", pools)),
        ]
        for did, grp, kind, title, desc, items in decks:
            if items: quests.append({"id": did, "group": grp, "kind": kind, "title": title, "desc": desc, "items": items})
        ids = [it["id"] for q in quests for it in q["items"]]
        dup = [k for k, n in Counter(ids).items() if n > 1]
        assert not dup, f"id trùng: {dup[:5]}"
        for q in quests:
            for it in q["items"]:
                assert it["opts"] and 1 <= it["ans"] <= len(it["opts"]), it["id"]
                assert it["modes"], it["id"]
        out = {"level": lv, "title": f"Ôn tập {lv}", "groups": groups, "quests": quests}
        path = os.path.join(ROOT, f"public/quests/{lv}.json")
        json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        stats[lv] = {q["title"]: len(q["items"]) for q in quests if q["group"] not in ("kanji", "bunpou")}
        stats[lv]["Tổng"] = len(ids); stats[lv]["Đã ra thi"] = sum(1 for q in quests for it in q["items"] if it.get("exam"))
        stats[lv]["KB"] = os.path.getsize(path) // 1024
    print(json.dumps(stats, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
