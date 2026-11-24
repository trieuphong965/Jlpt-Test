"use strict";
/* Quest ôn tập + Thống kê. Dùng chung $, $$, esc, api, store, ICON, LOGO, FOOTER, INDEX từ app.js. */

const LEVELS = ["N2", "N1"];
const QDATA = {};            // level → nội dung quest (null nếu chưa có)
const QLOG = {};             // level → {attempts:[], answers:[[attempt_id,item_id,correct,ms,at]]}
let QS = null;               // trạng thái lượt đang làm
const DAY = 86400000;

// ---------- Thanh điều hướng chung ----------
function appBar(active, remote) {
  const tab = (id, href, label) => `<a class="navtab ${active === id ? "on" : ""}" href="#${href}">${label}</a>`;
  return `<div class="topbar"><div class="in">
      <a href="#" style="text-decoration:none;color:inherit">${LOGO}</a>
      <nav class="navtabs">${tab("home", "", "Tổng quan")}${tab("quest", "quest/N2", "Quest")}${tab("exams", "exams", "Đề thi")}${tab("stats", "stats/N2", "Thống kê")}</nav>
      ${remote === false ? `<span class="chip warn">offline</span>` : ""}
    </div></div>
    <nav class="navtabs-m">${tab("home", "", "Tổng quan")}${tab("quest", "quest/N2", "Quest")}${tab("exams", "exams", "Đề thi")}${tab("stats", "stats/N2", "Thống kê")}</nav>`;
}

// ---------- Dữ liệu ----------
async function loadQuests(level) {
  if (level in QDATA) return QDATA[level];
  try { const r = await fetch(`quests/${level}.json`); QDATA[level] = r.ok ? await r.json() : null; }
  catch { QDATA[level] = null; }
  if (QDATA[level]) {
    const d = QDATA[level]; d.itemMap = {}; d.questMap = {};
    d.quests.forEach(q => { d.questMap[q.id] = q; q.items.forEach(it => { d.itemMap[it.id] = { ...it, quest: q }; }); });
  }
  return QDATA[level];
}
const localKey = lv => "jlpt-qlog-" + lv;
async function loadLog(level, force) {
  if (QLOG[level] && !force) return QLOG[level];
  const remote = await api("quest/log?level=" + level);
  QLOG[level] = remote || store.get(localKey(level), { attempts: [], answers: [] });
  QLOG[level].remote = !!remote;
  return QLOG[level];
}
function saveAttemptLocal(level, att, answers) {
  const log = store.get(localKey(level), { attempts: [], answers: [] });
  log.attempts.push(att); answers.forEach(a => log.answers.push([att.id, a.item_id, a.correct ? 1 : 0, a.ms, a.at]));
  if (log.answers.length > 20000) log.answers = log.answers.slice(-20000);
  store.set(localKey(level), log);
  if (QLOG[level]) { QLOG[level].attempts.push(att); answers.forEach(a => QLOG[level].answers.push([att.id, a.item_id, a.correct ? 1 : 0, a.ms, a.at])); }
}

// ---------- Phân tích ----------
const starsOf = pct => pct >= 90 ? 3 : pct >= 70 ? 2 : pct >= 50 ? 1 : 0;
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function analyze(level) {
  const data = QDATA[level], log = QLOG[level] || { attempts: [], answers: [] };
  const items = {};      // item_id → {n, ok, hist:[0/1…], lastAt}
  log.answers.forEach(([, iid, c, , at]) => {
    if (!data.itemMap[iid]) return;
    const s = items[iid] = items[iid] || { n: 0, ok: 0, hist: [], lastAt: 0 };
    s.n++; s.ok += c; s.hist.push(c); s.lastAt = Math.max(s.lastAt, at);
  });
  const quests = {};     // quest_id → {best, n, last}
  log.attempts.forEach(a => {
    if (!data.questMap[a.quest_id]) return;
    const pct = Math.round(a.correct / a.total * 100), q = quests[a.quest_id] = quests[a.quest_id] || { best: 0, n: 0, last: 0 };
    q.best = Math.max(q.best, pct); q.n++; q.last = Math.max(q.last, a.finished_at);
  });
  // Trạng thái từng câu: weak = lần cuối sai, hoặc đúng < 60% khi đã làm ≥ 3 lần; mastered = 2 lần gần nhất đều đúng
  const status = iid => {
    const s = items[iid]; if (!s) return "new";
    const h = s.hist;
    if (!h[h.length - 1] || (s.n >= 3 && s.ok / s.n < 0.6)) return "weak";
    if (h.length >= 2 && h[h.length - 1] && h[h.length - 2]) return "mastered";
    return "learning";
  };
  const weak = Object.keys(items).filter(iid => status(iid) === "weak")
    .sort((a, b) => (items[a].ok / items[a].n) - (items[b].ok / items[b].n) || items[b].lastAt - items[a].lastAt);
  const byQuest = data.quests.map(q => {
    let n = 0, ok = 0, mastered = 0;
    q.items.forEach(it => { const s = items[it.id]; if (s) { n += s.n; ok += s.ok; } if (status(it.id) === "mastered") mastered++; });
    return { q, n, ok, mastered, best: quests[q.id]?.best ?? null, tries: quests[q.id]?.n || 0 };
  });
  // 14 ngày gần nhất
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => { const t = today.getTime() - (13 - i) * DAY; return { t, key: dayKey(t), n: 0, ok: 0 }; });
  const dm = Object.fromEntries(days.map(d => [d.key, d]));
  log.answers.forEach(([, iid, c, , at]) => { const d = dm[dayKey(at)]; if (d && data.itemMap[iid]) { d.n++; d.ok += c; } });
  // Chuỗi ngày liên tiếp có học
  const active = new Set(log.answers.map(a => dayKey(a[4])));
  let streak = 0; for (let t = today.getTime(); active.has(dayKey(t)); t -= DAY) streak++;
  if (!streak && active.has(dayKey(today.getTime() - DAY))) for (let t = today.getTime() - DAY; active.has(dayKey(t)); t -= DAY) streak++;
  const dayAll = {};
  log.answers.forEach(([, iid, c, , at]) => { if (!data.itemMap[iid]) return; const k = dayKey(at); const d = dayAll[k] = dayAll[k] || { n: 0, ok: 0 }; d.n++; d.ok += c; });
  let longest = 0, run = 0, prev = null;
  Object.keys(dayAll).map(k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getTime(); }).sort((a, b) => a - b)
    .forEach(t => { run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1; longest = Math.max(longest, run); prev = t; });
  const total = log.answers.filter(a => data.itemMap[a[1]]).length;
  const totalOk = log.answers.filter(a => data.itemMap[a[1]] && a[2]).length;
  const nItems = Object.keys(data.itemMap).length;
  const mastered = Object.keys(data.itemMap).filter(i => status(i) === "mastered").length;
  const stars = data.quests.reduce((a, q) => a + (quests[q.id] ? starsOf(quests[q.id].best) : 0), 0);
  const ms = log.answers.filter(a => a[3]).map(a => a[3]);
  return { items, quests, status, weak, byQuest, days, streak, longest, dayAll, activeDays: Object.keys(dayAll).length, total, totalOk, nItems, mastered, stars,
    passed: data.quests.filter(q => (quests[q.id]?.best || 0) >= 70).length,
    avgSec: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 100) / 10 : null,
    attempts: log.attempts.filter(a => data.questMap[a.quest_id] || a.quest_id === "review") };
}
const starHtml = n => `<span class="stars" aria-label="${n} sao">${[1, 2, 3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;

// ---------- Tổng quan (trang chủ) ----------
async function renderDashboard() {
  const data = await loadQuests("N2");
  const log = await loadLog("N2", true);
  const A = data ? analyze("N2") : null;
  const todayN = A ? A.days[13].n : 0;
  const pct = A && A.total ? Math.round(A.totalOk / A.total * 100) : null;
  $("#app").innerHTML = `${appBar("home", log.remote)}
  <div class="page wide">
    <div class="hero gridpaper">
      <div class="eyebrow">JLPT 模試 · N2 → N1</div>
      <h1>Hôm nay ôn gì?</h1>
      <p>${A && A.weak.length ? `Có <b>${A.weak.length}</b> câu đang yếu — ôn lại trước khi học quest mới.` : "Bắt đầu bằng một quest 10 câu, sai câu nào có giải thích câu đó."}</p>
      <div class="blocks" aria-hidden="true"><span class="hatch" style="height:14px"></span><span class="hatch" style="height:24px"></span><span style="height:34px;background:var(--dark)"></span><span class="hatch" style="height:46px"></span></div>
    </div>
    ${A ? `<div class="kpis">
      ${kpi("Hôm nay", todayN, "câu")}${kpi("Chuỗi ngày", A.streak, "ngày")}${kpi("Tỉ lệ đúng", pct == null ? "—" : pct, pct == null ? "" : "%")}${kpi("Đã thuộc", A.mastered, "/ " + A.nItems)}
    </div>` : ""}
    <div class="dash">
      <a class="dash-card" href="#quest/N2">
        <div class="eyebrow">Quest ôn tập</div>
        <h3>N2 · 漢字・文法</h3>
        <p class="muted small">${data ? `${data.quests.length} quest · ${A.nItems} câu · ${A.passed}/${data.quests.length} quest đã qua` : "Chưa có dữ liệu"}</p>
        ${A ? `<div class="prog-line"><span>${starHtml(3)}</span><div class="bar"><i class="hatch" style="width:${A.stars / (data.quests.length * 3) * 100}%"></i></div><span>${A.stars}/${data.quests.length * 3}</span></div>` : ""}
        ${A && A.weak.length ? `<span class="btn pri sm" style="margin-top:12px" data-go="quest/N2/review">Ôn ${Math.min(A.weak.length, 15)} câu yếu</span>` : `<span class="btn sm" style="margin-top:12px">Mở bản đồ quest →</span>`}
      </a>
      <a class="dash-card dim" href="#quest/N1">
        <div class="eyebrow">Quest ôn tập</div>
        <h3>N1</h3>
        <p class="muted small">Sắp có — nội dung sẽ thêm khi bắt đầu khoá N1.</p>
        <span class="tag" style="margin-top:12px">Coming soon</span>
      </a>
      <a class="dash-card" href="#exams">
        <div class="eyebrow">Đề thi thử</div>
        <h3>JLPT N2 · N1</h3>
        <p class="muted small">${INDEX.length} đề theo cấu trúc đề thật, có 聴解.</p>
        <span class="btn sm" style="margin-top:12px">Danh sách đề →</span>
      </a>
      <a class="dash-card" href="#stats/N2">
        <div class="eyebrow">Phân tích</div>
        <h3>Thống kê</h3>
        <p class="muted small">Tiến độ 14 ngày, tỉ lệ đúng theo chủ đề, danh sách điểm yếu.</p>
        <span class="btn sm" style="margin-top:12px">Xem thống kê →</span>
      </a>
    </div>
    ${FOOTER}
  </div>`;
  $$("[data-go]").forEach(b => b.onclick = e => { e.preventDefault(); location.hash = b.dataset.go; });
}
const kpi = (k, v, unit) => `<div class="kpi"><div class="eyebrow">${k}</div><div class="v">${v}<small> ${unit}</small></div></div>`;

// ---------- Bản đồ quest ----------
async function routeQuest(parts) {
  const level = LEVELS.includes(parts[1]) ? parts[1] : "N2";
  const data = await loadQuests(level);
  await loadLog(level);
  if (parts[2] && data) {
    if (parts[2] === "review") return startReview(level);
    const q = data.questMap[parts[2]]; if (q) return startQuest(level, q, q.items);
  }
  renderQuestMap(level);
}
function renderQuestMap(level) {
  const data = QDATA[level], log = QLOG[level];
  const levelSeg = `<div class="seg" style="max-width:220px">${LEVELS.map(l => `<button data-lv="${l}" class="${l === level ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!data) {
    $("#app").innerHTML = `${appBar("quest", log?.remote)}<div class="page wide">
      <div class="qmap-head"><div><div class="eyebrow">Quest ôn tập</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
      <div class="card gridpaper empty"><div class="eyebrow">Sắp có</div><h3>Quest ${level} chưa có nội dung</h3>
      <p class="muted small">Cấu trúc đã sẵn sàng: chỉ cần thêm file <code>quests/${level}.json</code> (sinh bằng <code>tools/quests_${level.toLowerCase()}.py</code>). Thống kê sẽ tự tách riêng theo cấp độ.</p></div>${FOOTER}</div>`;
    bindLevelSeg("quest"); return;
  }
  const A = analyze(level);
  const card = b => {
    const st = b.best == null ? 0 : starsOf(b.best);
    return `<a class="qc" href="#quest/${level}/${b.q.id}">
      <div class="qc-top"><span class="eyebrow">${esc(b.q.kind)}</span>${starHtml(st)}</div>
      <div class="qc-t">${esc(b.q.title)}</div>
      <div class="qc-d">${esc(b.q.desc)}</div>
      <div class="qc-meta"><span>${b.q.items.length} câu</span><span>${b.best == null ? "Chưa làm" : `Cao nhất ${b.best}% · ${b.tries} lần`}</span></div>
      <div class="qc-bar" title="Đã thuộc ${b.mastered}/${b.q.items.length}"><i class="hatch" style="width:${b.mastered / b.q.items.length * 100}%"></i></div>
    </a>`;
  };
  $("#app").innerHTML = `${appBar("quest", log.remote)}
  <div class="page wide">
    <div class="qmap-head"><div><div class="eyebrow">Quest ôn tập · ${A.nItems} câu</div><h2 class="intro-h">${esc(data.title)}</h2></div>${levelSeg}</div>
    <div class="review-card ${A.weak.length ? "" : "dim"}">
      <div><div class="eyebrow" style="color:var(--accent)">Ôn tập thông minh</div>
        <b>${A.weak.length ? `${A.weak.length} câu đang yếu` : "Chưa có câu yếu"}</b>
        <div class="small muted">${A.weak.length ? "Câu trả lời sai gần nhất hoặc đúng dưới 60%. Đúng 2 lần liên tiếp thì được tính là đã thuộc." : "Làm vài quest — câu nào sai sẽ tự vào đây."}</div></div>
      ${A.weak.length ? `<a class="btn pri" href="#quest/${level}/review">Ôn ${Math.min(A.weak.length, 15)} câu</a>` : ""}
    </div>
    ${data.groups.map(g => `<div class="sect-title"><span class="eyebrow">${esc(g.title)}</span> <span class="small muted">· ${esc(g.desc)}</span></div>
      <div class="qgrid">${A.byQuest.filter(b => b.q.group === g.id).map(card).join("")}</div>`).join("")}
    <p class="small muted" style="margin-top:14px">★ ≥ 50% · ★★ ≥ 70% · ★★★ ≥ 90%. Thanh sọc = số câu đã thuộc.</p>
    ${FOOTER}
  </div>`;
  bindLevelSeg("quest");
}
function bindLevelSeg(kind) { $$("[data-lv]").forEach(b => b.onclick = () => { location.hash = `${kind}/${b.dataset.lv}`; }); }

// ---------- Làm quest ----------
function shuffleItem(it) {
  const perm = [0, 1, 2, 3].slice(0, it.opts.length);
  for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  return { ...it, opts: perm.map(i => it.opts[i]), ans: perm.indexOf(it.ans - 1) + 1, origAns: it.ans };
}
function startQuest(level, q, items, title) {
  QS = { level, qid: q ? q.id : "review", title: title || q.title, kind: q ? q.kind : "Ôn tập",
    items: items.map(shuffleItem), i: 0, answers: [], started: Date.now(), shownAt: Date.now() };
  renderPlay();
}
function startReview(level) {
  const A = analyze(level), data = QDATA[level];
  const ids = A.weak.slice(0, 15);
  if (!ids.length) { location.hash = `quest/${level}`; return; }
  startQuest(level, null, ids.map(i => data.itemMap[i]), "Ôn câu yếu");
}
function renderPlay() {
  const it = QS.items[QS.i], a = QS.answers[QS.i], n = QS.items.length;
  const done = a != null, last = QS.i === n - 1;
  const opts = it.opts.map((o, k) => {
    const v = k + 1; let c = "opt";
    if (done && v === it.ans) c += " correct";
    if (done && a.chosen === v && !a.correct) c += " wrong";
    return `<button class="${c}" data-v="${v}" ${done ? "disabled" : ""}><span class="n">${v}</span><span class="tx">${o}</span></button>`;
  }).join("");
  const compact = it.opts.every(o => o.replace(/<[^>]+>/g, "").length <= 8);
  const src = QS.qid === "review" ? it.quest : null;
  $("#app").innerHTML = `
    <div class="topbar"><div class="in">
      <button class="icon-btn" id="qexit" aria-label="Thoát">${ICON.close}</button>
      <div class="ttl"><b>${esc(QS.title)}</b><span>${QS.level} · ${esc(src ? src.title : QS.kind)}</span></div>
      <span class="count-btn" style="display:inline-flex">${QS.i + 1}/${n}</span>
    </div>
    <div class="qprog"><i class="hatch" style="width:${(QS.answers.filter(Boolean).length) / n * 100}%"></i></div></div>
    <div class="page">
      <div class="qhead-row"><div><div class="eyebrow">${esc(it.type === "narabe" ? "並べ替え" : it.type)}</div><h2>Câu ${QS.i + 1}</h2></div>
        <div style="text-align:right"><span class="tag">${QS.answers.filter(x => x && x.correct).length} đúng</span></div></div>
      ${it.type === "narabe" ? `<div class="instr"><span class="ic">!</span><span class="tx">Sắp xếp 4 mảnh thành câu đúng, chọn mảnh nằm ở vị trí <b>★</b>.</span></div>` : ""}
      <div class="canvas gridpaper"><div class="qcard">
        <div class="qhead"><div class="stem">${it.stem}</div></div>
        <div class="opts ${compact ? "compact" : ""}">${opts}</div>
        ${done ? `<div class="verdict ${a.correct ? "ok" : "ng"}">${a.correct ? "✓ Chính xác" : `✗ Sai — đáp án đúng: ${it.ans}. ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}`}</div>
          <div class="exp ${a.correct ? "" : "ng"}"><span class="eyebrow">${a.correct ? "Giải thích" : "Ghi nhớ"}</span>${it.exp}</div>` : ""}
      </div></div>
      <div class="kbd-hint"><kbd>1</kbd>–<kbd>4</kbd> chọn · <kbd>Enter</kbd> câu tiếp</div>
      ${FOOTER}
    </div>
    <div class="bottombar"><div class="in" style="padding-left:12px">
      <div class="pos" style="text-align:left">${done ? (a.correct ? "Đúng rồi!" : "Đọc lời giải rồi đi tiếp") : "Chọn một đáp án"}</div>
      <button class="btn pri" id="qnext" ${done ? "" : "disabled"}>${last ? "Xem kết quả" : "Câu tiếp"}${ICON.next}</button>
    </div></div>`;
  $("#qexit").onclick = () => {
    if (!QS.answers.filter(Boolean).length) { location.hash = `quest/${QS.level}`; return; }
    modal("Dừng quest?", "Các câu đã trả lời vẫn được lưu vào thống kê.", [{ label: "Làm tiếp" }, { label: "Dừng", pri: true, fn: () => finishQuest(true) }]);
  };
  $$(".opt").forEach(b => b.onclick = () => answer(+b.dataset.v));
  $("#qnext").onclick = next;
  if (done && !a.correct) $(".exp").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function answer(v) {
  if (!QS || QS.answers[QS.i]) return;
  const it = QS.items[QS.i];
  QS.answers[QS.i] = { item_id: it.id, chosen: v, correct: v === it.ans, ms: Date.now() - QS.shownAt, at: Date.now() };
  renderPlay();
}
function next() {
  if (!QS || !QS.answers[QS.i]) return;
  if (QS.i === QS.items.length - 1) return finishQuest();
  QS.i++; QS.shownAt = Date.now(); renderPlay(); scrollTo(0, 0);
}
async function finishQuest(partial) {
  const answers = QS.answers.filter(Boolean);
  if (!answers.length) { location.hash = `quest/${QS.level}`; return; }
  const att = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), quest_id: QS.qid,
    correct: answers.filter(a => a.correct).length, total: answers.length, started_at: QS.started, finished_at: Date.now() };
  saveAttemptLocal(QS.level, att, answers);
  api("quest/attempt", { method: "POST", body: { id: att.id, level: QS.level, quest_id: QS.qid, started_at: QS.started, answers } });
  QS.result = att; QS.partial = partial;
  renderQuestResult();
}
function renderQuestResult() {
  const r = QS.result, pct = Math.round(r.correct / r.total * 100), st = starsOf(pct);
  const wrong = QS.items.map((it, i) => ({ it, a: QS.answers[i] })).filter(x => x.a && !x.a.correct);
  const secs = Math.round((r.finished_at - r.started_at) / 1000);
  const msg = pct >= 90 ? "Xuất sắc! Quest này đã chắc." : pct >= 70 ? "Tốt — ôn lại vài câu sai là ổn." : pct >= 50 ? "Tạm được — nên làm lại sau khi đọc lời giải." : "Cần ôn lại kỹ chủ đề này.";
  $("#app").innerHTML = `${appBar("quest")}
  <div class="page">
    <div class="card gridpaper">
      <div class="score-hero">
        <div class="big-score"><div class="fill hatch" style="height:${pct}%"></div><b>${r.correct}</b><span>/ ${r.total} câu · ${pct}%</span></div>
        <div><div class="eyebrow">${esc(QS.title)}${QS.partial ? " · dừng giữa chừng" : ""}</div>
          <div style="margin:6px 0 2px">${starHtml(st).replace('class="stars"', 'class="stars big"')}</div>
          <div class="verdict-big ${pct >= 70 ? "ok" : "ng"}" style="font-size:1.05rem">${msg}</div>
          <div class="small muted">Thời gian ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · trung bình ${Math.round(secs / r.total)} giây/câu</div></div>
      </div>
      <div class="actions" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        ${wrong.length ? `<button class="btn pri" id="rwrong">Làm lại ${wrong.length} câu sai</button>` : ""}
        ${QS.qid !== "review" ? `<button class="btn" id="ragain">Làm lại quest</button>` : ""}
        <a class="btn" href="#quest/${QS.level}">Bản đồ quest</a>
      </div>
    </div>
    ${wrong.length ? `<div class="sect-title eyebrow">Câu sai — đọc lại lời giải</div>
    <div class="wrong-list">${wrong.map(({ it, a }) => `<div class="card wl">
      <div class="stem" style="font-size:1rem">${it.stem}</div>
      <div class="wl-ans"><span class="chip ng">Bạn chọn: ${esc(it.opts[a.chosen - 1].replace(/<[^>]+>/g, ""))}</span><span class="chip ok">Đúng: ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}</span></div>
      <div class="exp ng"><span class="eyebrow">Ghi nhớ</span>${it.exp}</div></div>`).join("")}</div>` : ""}
    ${FOOTER}
  </div>`;
  const rw = $("#rwrong"); if (rw) rw.onclick = () => startQuest(QS.level, null, wrong.map(x => QDATA[QS.level].itemMap[x.it.id]), "Làm lại câu sai");
  const ra = $("#ragain"); if (ra) ra.onclick = () => { const q = QDATA[QS.level].questMap[QS.qid]; startQuest(QS.level, q, q.items); };
  scrollTo(0, 0);
}
document.addEventListener("keydown", e => {
  if (!QS || !location.hash.startsWith("#quest/") || QS.result || e.metaKey || e.ctrlKey || e.altKey || $(".modal")) return;
  if (/^[1-4]$/.test(e.key)) answer(+e.key);
  else if (e.key === "Enter" || e.key === "ArrowRight") next();
  else return;
  e.preventDefault();
});
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#quest/")) QS = null; else if (QS && QS.result) QS = null; });

// ---------- Thống kê ----------
async function renderStats(level) {
  if (!LEVELS.includes(level)) level = "N2";
  const data = await loadQuests(level);
  const log = await loadLog(level, true);
  const levelSeg = `<div class="seg" style="max-width:220px">${LEVELS.map(l => `<button data-lv="${l}" class="${l === level ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!data) {
    $("#app").innerHTML = `${appBar("stats", log.remote)}<div class="page wide"><div class="qmap-head"><div><div class="eyebrow">Thống kê</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
      <div class="card gridpaper empty"><h3>Chưa có dữ liệu ${level}</h3><p class="muted small">Quest ${level} sẽ có khi thêm nội dung.</p></div>${FOOTER}</div>`;
    bindLevelSeg("stats"); return;
  }
  const A = analyze(level);
  const pct = A.total ? Math.round(A.totalOk / A.total * 100) : null;
  const weakRows = A.weak.slice(0, 15).map(iid => {
    const it = data.itemMap[iid], s = A.items[iid];
    return `<details class="wk"><summary>
        <span class="wk-tag">${esc(it.tag || "")}</span>
        <span class="wk-q small muted">${esc(it.quest.title)}</span>
        <span class="wk-r">${s.ok}/${s.n}</span>
        <span class="wk-h">${s.hist.slice(-5).map(c => `<i class="${c ? "o" : "x"}" title="${c ? "đúng" : "sai"}"></i>`).join("")}</span>
      </summary><div class="wk-body"><div class="stem" style="font-size:.98rem">${it.stem}</div>
        <div class="wl-ans"><span class="chip ok">Đáp án: ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}</span></div>
        <div class="exp ng"><span class="eyebrow">Ghi nhớ</span>${it.exp}</div></div></details>`;
  }).join("");
  const recent = A.attempts.slice(-8).reverse();
  $("#app").innerHTML = `${appBar("stats", log.remote)}
  <div class="page wide">
    <div class="qmap-head"><div><div class="eyebrow">Thống kê · Quest ôn tập</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
    <div class="kpis">
      ${kpi("Câu đã làm", A.total, "lượt")}${kpi("Tỉ lệ đúng", pct == null ? "—" : pct, pct == null ? "" : "%")}
      ${kpi("Đã thuộc", A.mastered, "/ " + A.nItems)}${kpi("Quest đã qua", A.passed, "/ " + data.quests.length)}
      ${kpi("Chuỗi ngày", A.streak, "ngày")}${kpi("Tốc độ TB", A.avgSec == null ? "—" : A.avgSec < 1 ? "<1" : A.avgSec, A.avgSec == null ? "" : "giây/câu")}
    </div>
    ${A.total ? "" : `<div class="card gridpaper empty" style="margin-bottom:14px"><b>Chưa có dữ liệu.</b> <span class="muted small">Làm một quest để bắt đầu thống kê.</span> <a class="btn pri sm" href="#quest/${level}">Mở quest</a></div>`}
    <section class="card chart-card" style="margin-bottom:14px" id="hm-card">${heatmapCard(A, HM_METRIC)}</section>
    <div class="stat-grid">
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Hoạt động</div><h3>Số câu mỗi ngày · 14 ngày</h3></div><button class="btn sm" data-table="t-days">Bảng</button></div>
        ${daysChart(A.days)}
        <table class="dtable hide" id="t-days"><thead><tr><th>Ngày</th><th>Số câu</th><th>Đúng</th></tr></thead><tbody>${A.days.map(d => `<tr><td>${fmtDay(d.t)}</td><td>${d.n}</td><td>${d.n ? Math.round(d.ok / d.n * 100) + "%" : "—"}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Mức độ thuộc</div><h3>${A.mastered} / ${A.nItems} câu</h3></div></div>
        ${masteryBar(A, data)}
      </section>
    </div>
    <section class="card chart-card" style="margin-top:14px">
      <div class="chart-h"><div><div class="eyebrow">Theo chủ đề</div><h3>Tỉ lệ đúng từng quest</h3></div><span class="small muted">Vạch dọc: mốc 70%</span></div>
      ${topicBars(A)}
    </section>
    <section class="card" style="margin-top:14px">
      <div class="chart-h"><div><div class="eyebrow" style="color:var(--accent)">Điểm yếu</div><h3>${A.weak.length} câu cần ôn</h3></div>${A.weak.length ? `<a class="btn pri sm" href="#quest/${level}/review">Ôn ngay</a>` : ""}</div>
      ${A.weak.length ? `<div class="wk-head small muted"><span>Mẫu / từ</span><span>Quest</span><span>Đúng</span><span>5 lần gần nhất</span></div>${weakRows}` : `<p class="muted small">Không có câu yếu. ${A.total ? "Tốt lắm!" : ""}</p>`}
    </section>
    ${recent.length ? `<section class="card" style="margin-top:14px"><div class="eyebrow" style="margin-bottom:6px">Lượt gần đây</div>
      ${recent.map(a => { const q = data.questMap[a.quest_id]; const p = Math.round(a.correct / a.total * 100); return `<div class="hist-row"><span>${q ? esc(q.title) : "Ôn câu yếu"}</span><span class="small muted">${new Date(a.finished_at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</span><b>${a.correct}/${a.total}</b>${starHtml(starsOf(p))}</div>`; }).join("")}</section>` : ""}
    ${FOOTER}
  </div>`;
  bindLevelSeg("stats");
  bindHeatmap(A);
  $$("[data-table]").forEach(b => b.onclick = () => $("#" + b.dataset.table).classList.toggle("hide"));
  bindTips();
}
// ---------- Heatmap lịch (GitHub-style) ----------
let HM_METRIC = (() => { try { return localStorage.getItem("jlpt-hm") || "n"; } catch { return "n"; } })();
const hmWeeks = () => innerWidth >= 900 ? 52 : 26;
// Thang tuần tự 1 tông (--chart), nhạt → đậm, 5 mức; ô trống = nền.
const HM_SCALE = {
  n: { label: "Số câu", steps: [1, 10, 20, 40], fmt: ["1–9", "10–19", "20–39", "40+"], unit: "câu" },
  p: { label: "Tỉ lệ đúng", steps: [0, 50, 70, 85, 95], fmt: ["<50%", "50–69%", "70–84%", "85–94%", "95%+"], unit: "%" },
};
function hmLevel(metric, d) {
  if (!d || !d.n) return 0;
  if (metric === "n") return d.n >= 40 ? 4 : d.n >= 20 ? 3 : d.n >= 10 ? 2 : 1;
  const p = d.ok / d.n * 100;
  return p >= 95 ? 5 : p >= 85 ? 4 : p >= 70 ? 3 : p >= 50 ? 2 : 1;
}
function heatmapCard(A, metric) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;                    // 0 = Thứ Hai
  const start = today.getTime() - (dow + (hmWeeks() - 1) * 7) * DAY;
  const levels = metric === "n" ? 4 : 5;
  let cols = "", months = "", lastM = -1;
  for (let w = 0; w < hmWeeks(); w++) {
    let cells = "";
    for (let r = 0; r < 7; r++) {
      const t = start + (w * 7 + r) * DAY;
      if (t > today.getTime()) { cells += `<i class="hm-c out"></i>`; continue; }
      const d = A.dayAll[dayKey(t)], lv = hmLevel(metric, d);
      const tip = `${new Date(t).toLocaleDateString("vi-VN", { weekday: "short", day: "numeric", month: "numeric" })}: ${d && d.n ? `${d.n} câu · đúng ${Math.round(d.ok / d.n * 100)}%` : "không học"}`;
      cells += `<i class="hm-c hit l${lv}${metric === "p" ? " p" : ""}${t === today.getTime() ? " today" : ""}" data-tip="${tip}"></i>`;
    }
    const m = new Date(start + w * 7 * DAY).getMonth();
    months += `<span>${m !== lastM ? `T${m + 1}` : ""}</span>`; lastM = m;
    cols += `<div class="hm-w">${cells}</div>`;
  }
  const sc = HM_SCALE[metric];
  const legend = `<span class="small muted">Ít</span><i class="hm-c l0"></i>${Array.from({ length: levels }, (_, i) => `<i class="hm-c l${i + 1}${metric === "p" ? " p" : ""}" title="${sc.fmt[i]}"></i>`).join("")}<span class="small muted">Nhiều</span>`;
  const legendP = `<i class="hm-c l0"></i><span class="small muted">không học</span>${sc.fmt.map((f, i) => `<i class="hm-c l${i + 1} p"></i><span class="small muted">${f}</span>`).join("")}`;
  const withData = Object.values(A.dayAll);
  const best = withData.length ? Math.max(...withData.map(d => d.n)) : 0;
  return `<div class="chart-h"><div><div class="eyebrow">Lịch học · ${hmWeeks()} tuần</div><h3>${metric === "n" ? "Số câu mỗi ngày" : "Tỉ lệ đúng mỗi ngày"}</h3></div>
      <div class="seg" id="hm-seg" style="width:190px"><button data-m="n" class="${metric === "n" ? "on" : ""}">Số câu</button><button data-m="p" class="${metric === "p" ? "on" : ""}">Tỉ lệ đúng</button></div></div>
    <div class="streaks">
      <div><span class="eyebrow">Chuỗi hiện tại</span><b>${A.streak}<small> ngày</small></b></div>
      <div><span class="eyebrow">Chuỗi dài nhất</span><b>${A.longest}<small> ngày</small></b></div>
      <div><span class="eyebrow">Ngày đã học</span><b>${A.activeDays}<small> ngày</small></b></div>
      <div><span class="eyebrow">Ngày nhiều nhất</span><b>${best}<small> câu</small></b></div>
    </div>
    <div class="hm-scroll" id="hm-scroll"><div class="hm">
      <div class="hm-days"><span></span><span>T2</span><span></span><span>T4</span><span></span><span>T6</span><span></span></div>
      <div><div class="hm-months">${months}</div><div class="hm-grid">${cols}</div></div>
    </div></div>
    <div class="hm-legend">${metric === "n" ? legend : legendP}</div>`;
}
function bindHeatmap(A) {
  const sc = $("#hm-scroll"); if (sc) sc.scrollLeft = sc.scrollWidth;
  $$("#hm-seg button").forEach(b => b.onclick = () => {
    HM_METRIC = b.dataset.m; try { localStorage.setItem("jlpt-hm", HM_METRIC); } catch {}
    $("#hm-card").innerHTML = heatmapCard(A, HM_METRIC); bindHeatmap(A); bindTips($("#hm-card"));
  });
}
const fmtDay = t => { const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1}`; };

// Cột: số câu/ngày (1 chuỗi, màu --chart). Hover/tap → tooltip.
function daysChart(days) {
  const W = innerWidth < 600 ? 340 : 560, H = innerWidth < 600 ? 150 : 170, padL = 26, padB = 22, padT = 10, bw = (W - padL) / days.length;
  const max = Math.max(10, ...days.map(d => d.n));
  const nice = Math.ceil(max / 10) * 10;
  const y = v => padT + (H - padT - padB) * (1 - v / nice);
  const grid = [0, nice / 2, nice].map(v => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${padL - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join("");
  const bars = days.map((d, i) => {
    const x = padL + i * bw + 3, w = bw - 6, h = Math.max(0, y(0) - y(d.n));
    const r = Math.min(4, w / 2, h);
    const tip = `${fmtDay(d.t)}: ${d.n} câu${d.n ? ` · đúng ${Math.round(d.ok / d.n * 100)}%` : ""}`;
    const path = h > 0 ? `M${x},${y(0)} V${y(d.n) + r} Q${x},${y(d.n)} ${x + r},${y(d.n)} H${x + w - r} Q${x + w},${y(d.n)} ${x + w},${y(d.n) + r} V${y(0)} Z` : "";
    return `<g class="hit" data-tip="${tip}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>${path ? `<path d="${path}" class="bar"/>` : ""}
      ${i % 2 === 1 || i === 13 ? `<text x="${x + w / 2}" y="${H - 6}" class="ax" text-anchor="middle">${i === 13 ? "Hôm nay" : fmtDay(d.t)}</text>` : ""}</g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Số câu mỗi ngày trong 14 ngày">${grid}<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/>${bars}</svg>`;
}
// Thanh ngang: tỉ lệ đúng từng quest (1 chuỗi). Nhãn chữ dùng màu chữ, không dùng màu dữ liệu.
function topicBars(A) {
  return `<div class="tbars">${A.byQuest.map(b => {
    const p = b.n ? Math.round(b.ok / b.n * 100) : null;
    return `<div class="tb hit" data-tip="${esc(b.q.title)}: ${b.n ? `${b.ok}/${b.n} lượt đúng (${p}%)` : "chưa làm"} · đã thuộc ${b.mastered}/${b.q.items.length}">
      <span class="tb-l"><span class="eyebrow">${esc(b.q.kind)}</span>${esc(b.q.title)}</span>
      <span class="tb-track"><i style="width:${p ?? 0}%"></i><b class="tb-ref"></b></span>
      <span class="tb-v">${p == null ? "—" : p + "%"}<small>${b.n ? ` · ${b.n}` : ""}</small></span></div>`;
  }).join("")}</div>`;
}
function masteryBar(A, data) {
  const n = A.nItems, c = { mastered: 0, learning: 0, weak: 0, new: 0 };
  Object.keys(data.itemMap).forEach(i => c[A.status(i)]++);
  const seg = (k, label, cls) => c[k] ? `<i class="${cls}" style="flex:${c[k]}" title="${label}: ${c[k]}"></i>` : "";
  const row = (cls, label, k) => `<div class="ml"><i class="${cls}"></i><span>${label}</span><b>${c[k]}</b></div>`;
  return `<div class="mbar">${seg("mastered", "Đã thuộc", "m-ok")}${seg("learning", "Đang học", "m-learn")}${seg("weak", "Yếu", "m-weak")}${seg("new", "Chưa làm", "m-new")}</div>
    <div class="mlegend">${row("m-ok", "Đã thuộc (2 lần đúng liên tiếp)", "mastered")}${row("m-learn", "Đang học", "learning")}${row("m-weak", "Yếu (sai gần nhất)", "weak")}${row("m-new", "Chưa làm", "new")}</div>`;
}
function bindTips(root = document) {
  let tip = document.querySelector(".tip");
  const show = (el, x, y) => {
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip); }
    tip.textContent = el.dataset.tip; tip.style.display = "block";
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
  };
  $$(".hit", root).forEach(el => {
    el.addEventListener("mousemove", e => show(el, e.clientX, e.clientY));
    el.addEventListener("mouseleave", () => tip && (tip.style.display = "none"));
    el.addEventListener("click", e => { const r = el.getBoundingClientRect(); show(el, e.clientX || r.left + r.width / 2, e.clientY || r.top); });
  });
}
