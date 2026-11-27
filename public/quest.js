"use strict";
/* Ôn tập hằng ngày kiểu Anki (SM-2) + Thống kê.
   Thẻ = từng câu trong public/quests/<level>.json; bộ thẻ = nhóm chủ đề.
   Dùng chung $, $$, esc, api, store, ICON, LOGO, FOOTER, INDEX, modal từ app.js. */

const LEVELS = ["N2", "N1"];
const QDATA = {};            // level → nội dung thẻ
const QLOG = {};             // level → {attempts, answers:[[attempt_id,item_id,correct,ms,at]]}
const SRS = {};              // level → {card_id: {state,due,ivl,ease,reps,lapses,added,updated_at}}
let SES = null;              // buổi học đang làm
const DAY = 86400000;
const todayNum = (t = Date.now()) => { const d = new Date(t); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
const numToDate = n => { const d = new Date(n * DAY); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

// ---------- Cài đặt (theo người xem) ----------
const SETTINGS_KEY = "jlpt-srs-settings";
const settings = () => ({ newPerDay: 15, maxReviews: 100, typing: true, ...store.get(SETTINGS_KEY, {}) });
const saveSettings = s => store.set(SETTINGS_KEY, s);

// ---------- Thanh điều hướng chung ----------
function appBar(active, remote) {
  const tab = (id, href, label) => `<a class="navtab ${active === id ? "on" : ""}" href="#${href}">${label}</a>`;
  const tabs = `${tab("home", "", "Tổng quan")}${tab("review", "review/N2", "Ôn tập")}${tab("exams", "exams", "Đề thi")}${tab("stats", "stats/N2", "Thống kê")}`;
  return `<div class="topbar"><div class="in">
      <a href="#" style="text-decoration:none;color:inherit">${LOGO}</a>
      <nav class="navtabs">${tabs}</nav>
      ${remote === false ? `<span class="chip warn">offline</span>` : ""}
    </div></div><nav class="navtabs-m">${tabs}</nav>`;
}

// ---------- Dữ liệu ----------
async function loadQuests(level) {
  if (level in QDATA) return QDATA[level];
  try { const r = await fetch(`quests/${level}.json`); QDATA[level] = r.ok ? await r.json() : null; } catch { QDATA[level] = null; }
  const d = QDATA[level];
  if (d) {
    d.itemMap = {}; d.questMap = {};
    d.quests.forEach(q => { d.questMap[q.id] = q; q.items.forEach(it => { d.itemMap[it.id] = { ...it, quest: q }; }); });
    // Thứ tự thẻ mới: xen kẽ các bộ (漢字 → 文法 → 漢字…) để mỗi buổi có nhiều dạng bài
    const decks = d.quests.map(q => q.items.map(it => it.id)); d.newOrder = [];
    for (let i = 0; decks.some(x => x.length > i); i++) decks.forEach(x => { if (x[i]) d.newOrder.push(x[i]); });
  }
  return d;
}
const logKey = lv => "jlpt-qlog-" + lv, srsKey = lv => "jlpt-srs-" + lv;
// Dữ liệu người dùng (nhật ký + lịch ôn): hiện ngay từ bộ nhớ máy, đồng bộ D1 chạy ngầm.
// Lần đầu trên thiết bị mới (chưa có cache) thì chờ D1. Hai request D1 chạy song song.
async function fetchRemote(level) {
  const [log, srs] = await Promise.all([api("quest/log?level=" + level), api("srs?level=" + level)]);
  if (log) { QLOG[level] = { ...log, remote: true }; store.set(logKey(level), log); }
  else if (!QLOG[level]) QLOG[level] = { ...store.get(logKey(level), { attempts: [], answers: [] }), remote: false };
  const map = { ...(SRS[level] || store.get(srsKey(level), {})) };
  if (srs) srs.forEach(r => { if (!map[r.card_id] || r.updated_at >= (map[r.card_id].updated_at || 0)) map[r.card_id] = r; });
  SRS[level] = map; store.set(srsKey(level), map);
}
const lastSync = {};
async function loadUser(level) {
  if (!QLOG[level]) { const l = store.get(logKey(level), null); if (l) QLOG[level] = l; }
  if (!SRS[level]) { const s = store.get(srsKey(level), null); if (s) SRS[level] = s; }
  if (QLOG[level] && SRS[level]) { bgSync(level); return; }
  lastSync[level] = Date.now();
  await fetchRemote(level);
}
function bgSync(level) {
  if (Date.now() - (lastSync[level] || 0) < 15000) return;
  lastSync[level] = Date.now();
  const sig = () => JSON.stringify([QLOG[level]?.answers?.length, QLOG[level]?.attempts?.length, Object.keys(SRS[level] || {}).length,
    Object.values(SRS[level] || {}).reduce((m, s) => Math.max(m, s.updated_at || 0), 0)]);
  const before = sig();
  fetchRemote(level).then(() => { if (sig() !== before) softRerender(); });
}
// Vẽ lại trang hiện tại khi dữ liệu D1 khác bản cache (không làm gián đoạn buổi ôn đang làm)
function softRerender() {
  if (SES && !SES.finished) return;
  const parts = location.hash.slice(1).split("/"), y = scrollY, back = () => scrollTo(0, y);
  if (!parts[0]) renderDashboard().then(back);
  else if (parts[0] === "review" && !parts[2]) { renderReviewHome(LEVELS.includes(parts[1]) ? parts[1] : "N2"); back(); }
  else if (parts[0] === "stats") renderStats(parts[1] || "N2").then(back);
}
function saveCard(level, id, st) {
  st.updated_at = Date.now();
  SRS[level][id] = st;
  store.set(srsKey(level), SRS[level]);
  api("srs", { method: "POST", body: { level, cards: [{ id, ...st }] } });
}

// ---------- SM-2 (biến thể Anki, đơn vị ngày) ----------
const GRADE = { again: 1, hard: 2, good: 3, easy: 4 };
function schedule(prev, grade, today = todayNum()) {
  const s = prev ? { ...prev } : { state: "new", ivl: 0, ease: 2.5, reps: 0, lapses: 0, added: today };
  const fuzz = d => d >= 3 ? d + Math.round((Math.random() - 0.5) * d * 0.1) : d;
  if (s.state !== "review") {                       // thẻ mới / đang học lại
    if (grade === 1) { s.state = "learn"; s.ivl = 0; }
    else { s.state = "review"; s.ivl = grade === 4 ? 4 : 1; }
  } else if (grade === 1) {                         // quên
    s.lapses++; s.ease = Math.max(1.3, s.ease - 0.2); s.state = "learn"; s.ivl = 0;
  } else {
    const iv = s.ivl || 1;
    if (grade === 2) { s.ivl = Math.max(iv + 1, Math.round(iv * 1.2)); s.ease = Math.max(1.3, s.ease - 0.15); }
    if (grade === 3) s.ivl = fuzz(Math.max(iv + 1, Math.round(iv * s.ease)));
    if (grade === 4) { s.ivl = fuzz(Math.max(iv + 2, Math.round(iv * s.ease * 1.3))); s.ease += 0.15; }
  }
  s.reps++;
  s.due = today + Math.max(s.ivl, s.state === "learn" ? 0 : 1);
  s.ease = Math.round(s.ease * 100) / 100;
  return s;
}
const ivlLabel = d => d <= 0 ? "trong buổi" : d === 1 ? "1 ngày" : d < 30 ? `${d} ngày` : d < 365 ? `${Math.round(d / 30)} tháng` : `${(d / 365).toFixed(1)} năm`;

// Trạng thái hiển thị (giống Anki): new / learn / young (<21 ngày) / mature (≥21 ngày)
function cardBucket(st) { if (!st) return "new"; if (st.state === "learn" || st.ivl < 1) return "learn"; return st.ivl >= 21 ? "mature" : "young"; }

// ---------- Lập kế hoạch ngày ----------
function plan(level) {
  const data = QDATA[level], srs = SRS[level] || {}, cfg = settings(), today = todayNum();
  const due = Object.entries(srs).filter(([id, s]) => data.itemMap[id] && s.due <= today).sort((a, b) => a[1].due - b[1].due).map(([id]) => id);
  const newToday = Object.values(srs).filter(s => s.added === today).length;
  const newLeft = Math.max(0, cfg.newPerDay - newToday);
  const fresh = data.newOrder.filter(id => !srs[id]);
  return { due: due.slice(0, cfg.maxReviews), dueAll: due.length, newIds: fresh.slice(0, newLeft), newLeft, newToday, freshTotal: fresh.length };
}
function forecast(level, days = 14) {
  const srs = SRS[level] || {}, today = todayNum(), out = Array.from({ length: days }, (_, i) => ({ d: today + i, n: 0 }));
  Object.values(srs).forEach(s => { const k = Math.max(0, s.due - today); if (k < days) out[k].n++; });
  return out;
}

// ---------- Phân tích (dùng cho Tổng quan & Thống kê) ----------
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function analyze(level) {
  const data = QDATA[level], log = QLOG[level] || { attempts: [], answers: [] }, srs = SRS[level] || {};
  const items = {};
  log.answers.forEach(([, iid, c, , at]) => {
    if (!data.itemMap[iid]) return;
    const s = items[iid] = items[iid] || { n: 0, ok: 0, hist: [], lastAt: 0 };
    s.n++; s.ok += c; s.hist.push(c); s.lastAt = Math.max(s.lastAt, at);
  });
  const buckets = { new: 0, learn: 0, young: 0, mature: 0 };
  Object.keys(data.itemMap).forEach(id => buckets[cardBucket(srs[id])]++);
  // Thẻ yếu: đã quên ≥ 1 lần hoặc lần gần nhất sai
  const weak = Object.keys(data.itemMap).filter(id => {
    const s = srs[id], h = items[id]?.hist; return (s && (s.lapses > 0 || s.state === "learn")) || (h && !h[h.length - 1]);
  }).sort((a, b) => (srs[b]?.lapses || 0) - (srs[a]?.lapses || 0) || (items[a] ? items[a].ok / items[a].n : 1) - (items[b] ? items[b].ok / items[b].n : 1));
  const byDeck = data.quests.map(q => {
    let n = 0, ok = 0; const b = { new: 0, learn: 0, young: 0, mature: 0 };
    q.items.forEach(it => { const s = items[it.id]; if (s) { n += s.n; ok += s.ok; } b[cardBucket(srs[it.id])]++; });
    return { q, n, ok, b };
  });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => { const t = today.getTime() - (13 - i) * DAY; return { t, key: dayKey(t), n: 0, ok: 0 }; });
  const dm = Object.fromEntries(days.map(d => [d.key, d]));
  const dayAll = {};
  log.answers.forEach(([, iid, c, , at]) => {
    if (!data.itemMap[iid]) return; const k = dayKey(at);
    const d = dayAll[k] = dayAll[k] || { n: 0, ok: 0 }; d.n++; d.ok += c;
    if (dm[k]) { dm[k].n++; dm[k].ok += c; }
  });
  let streak = 0; for (let t = today.getTime(); dayAll[dayKey(t)]; t -= DAY) streak++;
  if (!streak) for (let t = today.getTime() - DAY; dayAll[dayKey(t)]; t -= DAY) streak++;
  let longest = 0, run = 0, prev = null;
  Object.keys(dayAll).map(k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getTime(); }).sort((a, b) => a - b)
    .forEach(t => { run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1; longest = Math.max(longest, run); prev = t; });
  const ans = log.answers.filter(a => data.itemMap[a[1]]);
  const ms = ans.filter(a => a[3]).map(a => a[3]);
  return { items, buckets, weak, byDeck, days, dayAll, streak, longest, activeDays: Object.keys(dayAll).length,
    total: ans.length, totalOk: ans.filter(a => a[2]).length, nItems: Object.keys(data.itemMap).length,
    avgSec: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 100) / 10 : null,
    attempts: log.attempts };
}
const kpi = (k, v, unit) => `<div class="kpi"><div class="eyebrow">${k}</div><div class="v">${v}<small> ${unit}</small></div></div>`;

// ---------- Tổng quan ----------
async function renderDashboard() {
  const [data] = await Promise.all([loadQuests("N2"), loadUser("N2")]);
  const log = QLOG.N2;
  const A = data ? analyze("N2") : null, P = data ? plan("N2") : null;
  const todayN = A ? A.days[13].n : 0, pct = A && A.total ? Math.round(A.totalOk / A.total * 100) : null;
  const todo = P ? P.due.length + P.newIds.length : 0;
  $("#app").innerHTML = `${appBar("home", log.remote)}
  <div class="page wide">
    <div class="hero gridpaper">
      <div class="eyebrow">Ôn tập hằng ngày · N2</div>
      <h1>${todo ? `Hôm nay: ${todo} thẻ` : "Hôm nay đã xong ✓"}</h1>
      <p>${todo ? `${P.due.length} thẻ đến hạn ôn lại · ${P.newIds.length} thẻ mới · khoảng ${Math.max(1, Math.round(todo * 12 / 60))} phút.` : "Đã ôn hết thẻ đến hạn. Quay lại vào ngày mai, hoặc làm một đề thi thử."}</p>
      ${todo ? `<a class="btn pri" style="margin-top:14px" href="#review/N2/study">Bắt đầu ôn ${ICON.next}</a>` : ""}
      <div class="blocks" aria-hidden="true"><span class="hatch" style="height:14px"></span><span class="hatch" style="height:24px"></span><span style="height:34px;background:var(--dark)"></span><span class="hatch" style="height:46px"></span></div>
    </div>
    ${A ? `<div class="kpis">${kpi("Hôm nay", todayN, "lượt")}${kpi("Chuỗi ngày", A.streak, "ngày")}${kpi("Tỉ lệ đúng", pct ?? "—", pct == null ? "" : "%")}${kpi("Thuộc lâu", A.buckets.mature, "/ " + A.nItems)}</div>` : ""}
    <div class="dash">
      <a class="dash-card" href="#review/N2"><div class="eyebrow">Ôn tập hằng ngày</div><h3>N2 · 漢字・文法</h3>
        <p class="muted small">${A ? `${A.nItems} thẻ · ${A.nItems - A.buckets.new} đã học · ${P.freshTotal} thẻ mới còn lại` : ""}</p>
        ${A ? srsMini(A) : ""}<span class="btn sm" style="margin-top:12px">Bộ thẻ & cài đặt →</span></a>
      <a class="dash-card dim" href="#review/N1"><div class="eyebrow">Ôn tập hằng ngày</div><h3>N1</h3>
        <p class="muted small">Sắp có — thêm khi bắt đầu khoá N1.</p><span class="tag" style="margin-top:12px">Coming soon</span></a>
      <a class="dash-card" href="#exams"><div class="eyebrow">Đề thi thử</div><h3>JLPT N2 · N1</h3>
        <p class="muted small">${INDEX.length} đề theo cấu trúc đề thật.</p><span class="btn sm" style="margin-top:12px">Danh sách đề →</span></a>
      <a class="dash-card" href="#stats/N2"><div class="eyebrow">Phân tích</div><h3>Thống kê</h3>
        <p class="muted small">Lịch học, chuỗi ngày, dự báo thẻ đến hạn, điểm yếu.</p><span class="btn sm" style="margin-top:12px">Xem thống kê →</span></a>
    </div>
    ${FOOTER}
  </div>`;
}
function srsMini(A) {
  const n = A.nItems, b = A.buckets;
  return `<div class="mbar" style="height:10px;width:100%;margin-top:8px">${["mature", "young", "learn"].map(k => b[k] ? `<i class="m-${k}" style="flex:${b[k]}"></i>` : "").join("")}${b.new ? `<i class="m-new" style="flex:${b.new}"></i>` : ""}</div>`;
}

// ---------- Trang Ôn tập (kế hoạch hôm nay + bộ thẻ + cài đặt) ----------
async function routeReview(parts) {
  const level = LEVELS.includes(parts[1]) ? parts[1] : "N2";
  const [data] = await Promise.all([loadQuests(level), loadUser(level)]);
  if (data && parts[2] === "study") return startDaily(level);
  if (data && parts[2] === "weak") return startCustom(level, analyze(level).weak.slice(0, 20), "Ôn thẻ yếu");
  if (data && parts[2] === "deck" && data.questMap[parts[3]]) return startDeck(level, data.questMap[parts[3]]);
  renderReviewHome(level);
}
function renderReviewHome(level) {
  const data = QDATA[level], cfg = settings();
  const levelSeg = `<div class="seg" style="max-width:160px">${LEVELS.map(l => `<button data-lv="${l}" class="${l === level ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!data) {
    $("#app").innerHTML = `${appBar("review")}<div class="page wide"><div class="qmap-head"><div><div class="eyebrow">Ôn tập hằng ngày</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
      <div class="card gridpaper empty"><div class="eyebrow">Sắp có</div><h3>Chưa có thẻ ${level}</h3><p class="muted small">Thêm file <code>quests/${level}.json</code> là bộ ôn tập ${level} tự hoạt động, thống kê tách riêng theo cấp độ.</p></div>${FOOTER}</div>`;
    bindLevelSeg("review"); return;
  }
  const P = plan(level), A = analyze(level), fc = forecast(level, 7);
  const todo = P.due.length + P.newIds.length;
  const deck = d => {
    const t = d.q.items.length, b = d.b, dueN = d.q.items.filter(it => { const s = SRS[level][it.id]; return s && s.due <= todayNum(); }).length;
    return `<a class="qc" href="#review/${level}/deck/${d.q.id}">
      <div class="qc-top"><span class="eyebrow">${esc(d.q.kind)}</span>${dueN ? `<span class="tag">${dueN} đến hạn</span>` : ""}</div>
      <div class="qc-t">${esc(d.q.title)}</div><div class="qc-d">${esc(d.q.desc)}</div>
      <div class="qc-meta"><span>${t} thẻ</span><span>${b.new} mới · ${b.young + b.learn} đang ôn · ${b.mature} thuộc lâu</span></div>
      <div class="mbar" style="height:8px;margin-top:6px">${["mature", "young", "learn"].map(k => b[k] ? `<i class="m-${k}" style="flex:${b[k]}"></i>` : "").join("")}${b.new ? `<i class="m-new" style="flex:${b.new}"></i>` : ""}</div></a>`;
  };
  const opt = (k, vals, unit) => `<div class="seg" data-set="${k}">${vals.map(v => `<button data-v="${v}" class="${cfg[k] === v ? "on" : ""}">${v}${unit}</button>`).join("")}</div>`;
  $("#app").innerHTML = `${appBar("review")}
  <div class="page wide">
    <div class="qmap-head"><div><div class="eyebrow">Ôn tập hằng ngày · lặp lại ngắt quãng</div><h2 class="intro-h">${esc(data.title.replace("Quest ôn tập", "Ôn tập"))}</h2></div>${levelSeg}</div>
    <div class="today-card">
      <div class="today-main">
        <div class="eyebrow" style="color:var(--accent)">Hôm nay · ${new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric" })}</div>
        <div class="today-n"><b>${P.due.length}</b><span>ôn lại</span><b>${P.newIds.length}</b><span>thẻ mới</span></div>
        <div class="small muted">${todo ? `Khoảng ${Math.max(1, Math.round(todo * 12 / 60))} phút · trộn trắc nghiệm, gõ cách đọc, lật thẻ.` : P.freshTotal ? "Đã xong phần hôm nay. Có thể học thêm thẻ mới." : "Đã học hết thẻ, chỉ còn ôn theo lịch."}</div>
        ${P.dueAll > P.due.length ? `<div class="small" style="color:var(--flag)">${P.dueAll - P.due.length} thẻ đến hạn vượt giới hạn/ngày — sẽ dời sang mai.</div>` : ""}
      </div>
      <div class="today-act">
        ${todo ? `<a class="btn pri" href="#review/${level}/study">Bắt đầu ${ICON.next}</a>` : `<button class="btn pri" id="more">Học thêm 10 thẻ mới</button>`}
        ${A.weak.length ? `<a class="btn" href="#review/${level}/weak">Ôn ${Math.min(20, A.weak.length)} thẻ yếu</a>` : ""}
      </div>
    </div>
    <div class="fc7">${fc.map((f, i) => `<div><span class="eyebrow">${i === 0 ? "Nay" : i === 1 ? "Mai" : ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][numToDate(f.d).getDay()]}</span><b>${i === 0 ? P.dueAll : f.n}</b></div>`).join("")}</div>
    <div class="sect-title"><span class="eyebrow">Bộ thẻ</span> <span class="small muted">· bấm để học riêng một bộ (thẻ đến hạn + tối đa 10 thẻ mới)</span></div>
    <div class="qgrid">${A.byDeck.map(deck).join("")}</div>
    <div class="sect-title eyebrow">Cài đặt</div>
    <div class="card settings">
      <div><span class="eyebrow">Thẻ mới mỗi ngày</span>${opt("newPerDay", [5, 10, 15, 20, 30], "")}</div>
      <div><span class="eyebrow">Giới hạn ôn mỗi ngày</span>${opt("maxReviews", [50, 100, 200], "")}</div>
      <div><span class="eyebrow">Gõ cách đọc (bàn phím tiếng Nhật)</span><div class="seg" data-set="typing"><button data-v="true" class="${cfg.typing ? "on" : ""}">Bật</button><button data-v="false" class="${!cfg.typing ? "on" : ""}">Tắt</button></div></div>
    </div>
    <p class="small muted" style="margin-top:12px">Lịch ôn theo SM-2 (thuật toán của Anki): đúng → khoảng cách giãn dần (1 → 3 → 7 → 15 ngày…), sai → học lại ngay trong buổi và gặp lại từ ngày mai. Thẻ ≥ 21 ngày được tính là <b>thuộc lâu</b>.</p>
    ${FOOTER}
  </div>`;
  bindLevelSeg("review");
  $$("[data-set]").forEach(seg => $$("button", seg).forEach(b => b.onclick = () => {
    const s = settings(), k = seg.dataset.set; s[k] = k === "typing" ? b.dataset.v === "true" : +b.dataset.v; saveSettings(s); renderReviewHome(level);
  }));
  const more = $("#more"); if (more) more.onclick = () => startCustom(level, data.newOrder.filter(id => !SRS[level][id]).slice(0, 10), "Học thêm thẻ mới");
}
function bindLevelSeg(kind) { $$("[data-lv]").forEach(b => b.onclick = () => { location.hash = `${kind}/${b.dataset.lv}`; }); }

// ---------- Buổi học ----------
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function shuffleItem(it) {
  const perm = shuffleArr([0, 1, 2, 3].slice(0, it.opts.length));
  return { ...it, opts: perm.map(i => it.opts[i]), ans: perm.indexOf(it.ans - 1) + 1 };
}
const isYomi = it => it.type === "漢字読み";
const isGrammar = it => !["漢字読み", "漢字書き", "語形成", "narabe"].includes(it.type);
// Chọn dạng bài: thẻ mới → trắc nghiệm; thẻ ôn → xen kẽ gõ cách đọc / lật thẻ / trắc nghiệm
function pickMode(it, st) {
  if (!st || st.state !== "review") return "mc";
  const r = Math.random();
  if (isYomi(it) && settings().typing && r < 0.6) return "type";
  if (isGrammar(it) && st.ivl >= 3 && r < 0.5) return "flip";
  return "mc";
}
function startSession(level, ids, title) {
  const data = QDATA[level];
  const queue = ids.map(id => { const it = data.itemMap[id]; return { id, it: shuffleItem(it), mode: pickMode(it, SRS[level][id]), first: true }; });
  // Trộn: thẻ ôn và thẻ mới xen kẽ nhau
  SES = { level, title, queue: shuffleArr(queue), i: 0, answers: [], started: Date.now(), shownAt: Date.now(),
    id: "daily-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now()), total: ids.length, done: 0, again: 0, cur: null };
  if (!SES.queue.length) { location.hash = `review/${level}`; return; }
  renderCard();
}
function startDaily(level) { const P = plan(level); startSession(level, [...P.due, ...P.newIds], "Ôn tập hôm nay"); }
function startCustom(level, ids, title) { startSession(level, ids, title); }
function startDeck(level, q) {
  const today = todayNum(), srs = SRS[level];
  const due = q.items.filter(it => srs[it.id] && srs[it.id].due <= today).map(it => it.id);
  const fresh = q.items.filter(it => !srs[it.id]).slice(0, 10).map(it => it.id);
  startSession(level, [...due, ...fresh], q.title);
}

function renderCard() {
  const c = SES.queue[SES.i]; SES.cur = { revealed: false, result: null };
  const it = c.it, st = SRS[SES.level][c.id];
  const badge = !st ? `<span class="tag">Thẻ mới</span>` : st.state === "learn" || !c.first ? `<span class="tag" style="background:var(--flag-soft);color:var(--flag)">Học lại</span>` : `<span class="tag" style="background:var(--ok-soft);color:var(--ok)">Ôn · ${ivlLabel(st.ivl)}</span>`;
  const modeLabel = { mc: "Trắc nghiệm", type: "Gõ cách đọc", flip: "Lật thẻ" }[c.mode];
  let body = "";
  if (c.mode === "mc") body = `<div class="qhead"><div class="stem">${it.stem}</div></div><div class="opts ${it.opts.every(o => o.replace(/<[^>]+>/g, "").length <= 8) ? "compact" : ""}" id="opts">${mcOpts(it)}</div>`;
  if (c.mode === "type") body = `<div class="qhead"><div class="stem">${it.stem}</div></div>
      <p class="small muted" style="margin:12px 0 6px">Gõ cách đọc của phần gạch chân bằng hiragana:</p>
      <form id="tform" class="tform"><input id="tin" lang="ja" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ひらがな" enterkeyhint="done"><button class="btn pri" type="submit">Kiểm tra</button></form>
      <button class="btn sm" id="tomc" style="margin-top:8px">Không gõ được → chuyển sang trắc nghiệm</button>`;
  if (c.mode === "flip") body = `<div class="flip-front"><div class="eyebrow">Mẫu ngữ pháp</div><div class="flip-tag">${esc(it.tag)}</div><div class="small muted">Nghĩa là gì? Dùng trong tình huống nào? Nghĩ xong rồi lật thẻ.</div></div>
      <button class="btn pri block" id="flipbtn" style="margin-top:14px">Lật thẻ <span class="kbd-inline">Space</span></button>`;
  $("#app").innerHTML = `
    <div class="topbar"><div class="in">
      <button class="icon-btn" id="sexit" aria-label="Thoát">${ICON.close}</button>
      <div class="ttl"><b>${esc(SES.title)}</b><span>${SES.level} · ${esc(it.quest.title)}</span></div>
      <span class="count-btn" style="display:inline-flex" title="Còn lại">${SES.queue.length - SES.i}</span>
    </div><div class="qprog"><i class="hatch" style="width:${SES.done / SES.total * 100}%"></i></div></div>
    <div class="page">
      <div class="qhead-row"><div><div class="eyebrow">${esc(it.type === "narabe" ? "並べ替え" : it.type)} · ${modeLabel}</div><h2>${SES.done}/${SES.total} thẻ</h2></div><div style="text-align:right">${badge}</div></div>
      ${it.type === "narabe" ? `<div class="instr"><span class="ic">!</span><span class="tx">Sắp xếp 4 mảnh thành câu đúng, chọn mảnh ở vị trí <b>★</b>.</span></div>` : ""}
      <div class="canvas gridpaper"><div class="qcard" id="card">${body}<div id="fb"></div></div></div>
      <div class="kbd-hint">${c.mode === "flip" ? "<kbd>Space</kbd> lật · <kbd>1</kbd>–<kbd>4</kbd> chấm" : "<kbd>1</kbd>–<kbd>4</kbd> chọn · <kbd>Enter</kbd> tiếp"}</div>
      ${FOOTER}
    </div>
    <div class="bottombar"><div class="in" style="padding-left:12px" id="bar"><div class="pos" style="text-align:left">${c.mode === "flip" ? "Tự nhớ lại trước khi lật" : "Chọn đáp án"}</div></div></div>`;
  $("#sexit").onclick = () => SES.answers.length
    ? modal("Dừng buổi ôn?", "Các thẻ đã trả lời đã được lưu lịch ôn. Thẻ còn lại vẫn đến hạn, lần sau học tiếp.", [{ label: "Học tiếp" }, { label: "Dừng", pri: true, fn: () => finishSession(true) }])
    : (location.hash = `review/${SES.level}`);
  if (c.mode === "mc") $$("#opts .opt").forEach(b => b.onclick = () => gradeAuto(+b.dataset.v === it.ans, +b.dataset.v));
  if (c.mode === "type") {
    const inp = $("#tin"); setTimeout(() => inp.focus(), 50);
    $("#tform").onsubmit = e => { e.preventDefault(); if (!inp.value.trim()) return; gradeAuto(norm(inp.value) === norm(it.opts[it.ans - 1]), inp.value.trim()); };
    $("#tomc").onclick = () => { c.mode = "mc"; renderCard(); };
  }
  if (c.mode === "flip") $("#flipbtn").onclick = flipCard;
  SES.shownAt = Date.now();
}
function mcOpts(it, chosen) {
  const done = chosen != null;
  return it.opts.map((o, k) => {
    const v = k + 1; let cl = "opt";
    if (done && v === it.ans) cl += " correct";
    if (done && v === chosen && chosen !== it.ans) cl += " wrong";
    return `<button class="${cl}" data-v="${v}" ${done ? "disabled" : ""}><span class="n">${v}</span><span class="tx">${o}</span></button>`;
  }).join("");
}
// Chuẩn hoá: katakana → hiragana, bỏ khoảng trắng, ・, dấu câu
const norm = s => s.normalize("NFKC").replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/[\s・。、.,]/g, "");
const fillStem = it => it.stem.replace(/（　）|\(　\)/, `<b class="fill">${it.opts[it.ans - 1]}</b>`);

function gradeAuto(correct, chosen) {
  if (SES.cur.result) return;
  const c = SES.queue[SES.i], it = c.it;
  const grade = correct ? GRADE.good : GRADE.again;
  const next = applyGrade(grade, correct);
  if (c.mode === "mc") $("#opts").innerHTML = mcOpts(it, chosen);
  if (c.mode === "type") { $("#tin").disabled = true; $("#tin").classList.add(correct ? "ok" : "ng"); }
  $("#fb").innerHTML = `<div class="verdict ${correct ? "ok" : "ng"}">${correct ? "✓ Chính xác" : `✗ Sai — đáp án: ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}`}</div>
    <div class="exp ${correct ? "" : "ng"}"><span class="eyebrow">${correct ? "Giải thích" : "Ghi nhớ"}</span>${it.exp}</div>`;
  showNextBar(next, correct);
  if (!correct) $("#fb").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function flipCard() {
  if (SES.cur.revealed) return;
  SES.cur.revealed = true;
  const c = SES.queue[SES.i], it = c.it, st = SRS[SES.level][c.id];
  $("#flipbtn").remove();
  $("#fb").innerHTML = `<div class="flip-back"><div class="eyebrow">Ví dụ</div><div class="stem" style="font-size:1.05rem">${fillStem(it)}</div>
    <div class="exp"><span class="eyebrow">Ý nghĩa · cách dùng</span>${it.exp}</div></div>`;
  const prev = c.first ? st : { ...st, state: "learn" };
  const btn = (g, label, cls) => { const n = schedule(prev, g); return `<button class="btn ${cls}" data-g="${g}"><span>${label}</span><small>${ivlLabel(n.state === "learn" ? 0 : n.ivl)}</small></button>`; };
  $("#bar").innerHTML = `<div class="grade-row">${btn(1, "Quên", "g-again")}${btn(2, "Khó", "g-hard")}${btn(3, "Nhớ", "g-good")}${btn(4, "Dễ", "g-easy")}</div>`;
  $$("[data-g]").forEach(b => b.onclick = () => gradeFlip(+b.dataset.g));
}
function gradeFlip(g) {
  if (SES.cur.result) return;
  applyGrade(g, g > 1);
  nextCard();
}
// Ghi nhận kết quả: chỉ lần xuất hiện đầu trong buổi mới thay đổi lịch ôn; sai → đưa thẻ lại cuối hàng (sau ~4 thẻ)
function applyGrade(grade, correct) {
  const c = SES.queue[SES.i], lv = SES.level, prev = SRS[lv][c.id];
  SES.cur.result = { grade, correct };
  let next;
  if (c.first) {
    next = schedule(prev, grade);
    SES.answers.push({ item_id: c.id, correct, ms: Date.now() - SES.shownAt, at: Date.now() });
    logAttempt();
  } else {
    // Học lại trong buổi: đúng → chuyển sang ôn từ mai; sai → tiếp tục học lại
    next = grade > 1 ? { ...prev, state: "review", ivl: Math.max(1, prev.ivl || 1), due: todayNum() + 1 } : { ...prev };
  }
  saveCard(lv, c.id, next);
  if (grade === 1) {
    SES.again++;
    const pos = Math.min(SES.queue.length, SES.i + 4);
    SES.queue.splice(pos, 0, { ...c, it: shuffleItem(QDATA[lv].itemMap[c.id]), mode: "mc", first: false });
  } else SES.done++;
  return next;
}
function showNextBar(next, correct) {
  const last = SES.i >= SES.queue.length - 1;
  $("#bar").innerHTML = `<div class="pos" style="text-align:left">${correct ? `Gặp lại sau <b>${ivlLabel(next.state === "learn" ? 0 : next.ivl)}</b>` : "Thẻ sẽ quay lại trong buổi này"}</div>
    <button class="btn pri" id="snext">${last ? "Xem kết quả" : "Tiếp"}${ICON.next}</button>`;
  $("#snext").onclick = nextCard; $("#snext").focus({ preventScroll: true });
}
function nextCard() {
  if (SES.i >= SES.queue.length - 1) return finishSession();
  SES.i++; renderCard(); scrollTo(0, 0);
}
function logAttempt() {
  const ans = SES.answers;
  const att = { id: SES.id, quest_id: "daily", correct: ans.filter(a => a.correct).length, total: ans.length, started_at: SES.started, finished_at: Date.now() };
  // lưu cục bộ (thay thế bản cũ của cùng buổi)
  const log = store.get(logKey(SES.level), { attempts: [], answers: [] });
  log.attempts = log.attempts.filter(a => a.id !== att.id).concat(att);
  log.answers = log.answers.filter(a => a[0] !== att.id).concat(ans.map(a => [att.id, a.item_id, a.correct ? 1 : 0, a.ms, a.at]));
  store.set(logKey(SES.level), log);
  if (QLOG[SES.level]) {
    const L = QLOG[SES.level]; L.attempts = L.attempts.filter(a => a.id !== att.id).concat(att);
    L.answers = L.answers.filter(a => a[0] !== att.id).concat(ans.map(a => [att.id, a.item_id, a.correct ? 1 : 0, a.ms, a.at]));
  }
  api("quest/attempt", { method: "POST", body: { id: att.id, level: SES.level, quest_id: "daily", started_at: SES.started, answers: ans } });
}
function finishSession(partial) {
  const S2 = SES, lv = S2.level, ans = S2.answers;
  if (!ans.length) { SES = null; location.hash = `review/${lv}`; return; }
  const ok = ans.filter(a => a.correct).length, pct = Math.round(ok / ans.length * 100);
  const secs = Math.round((Date.now() - S2.started) / 1000);
  const wrong = ans.filter(a => !a.correct).map(a => QDATA[lv].itemMap[a.item_id]);
  const P = plan(lv), fc = forecast(lv, 2);
  SES = { ...S2, finished: true };
  // Rời địa chỉ /study để các nút "học tiếp" (link tới /study) hoạt động
  history.replaceState(null, "", `#review/${lv}`);
  $("#app").innerHTML = `${appBar("review")}
  <div class="page">
    <div class="card gridpaper">
      <div class="score-hero">
        <div class="big-score"><div class="fill hatch" style="height:${pct}%"></div><b>${ok}</b><span>/ ${ans.length} thẻ · ${pct}%</span></div>
        <div><div class="eyebrow">${esc(S2.title)}${partial ? " · dừng giữa chừng" : " · hoàn thành"}</div>
          <div class="verdict-big ${pct >= 80 ? "ok" : "ng"}" style="font-size:1.1rem;margin:4px 0">${pct >= 90 ? "Rất tốt!" : pct >= 80 ? "Tốt — giữ nhịp mỗi ngày nhé." : "Các thẻ sai sẽ quay lại từ ngày mai."}</div>
          <div class="small muted">${Math.floor(secs / 60)} phút ${secs % 60} giây · ${S2.again} lần học lại trong buổi</div>
          <div class="small muted">Ngày mai: <b>${fc[1].n}</b> thẻ đến hạn${P.freshTotal ? ` + tối đa ${settings().newPerDay} thẻ mới` : ""}</div></div>
      </div>
      <div class="actions" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        ${P.due.length + P.newIds.length ? `<a class="btn pri" href="#review/${lv}/study">Còn ${P.due.length + P.newIds.length} thẻ — học tiếp</a>` : ""}
        <a class="btn" href="#review/${lv}">Về trang ôn tập</a><a class="btn" href="#stats/${lv}">Thống kê</a>
      </div>
    </div>
    ${wrong.length ? `<div class="sect-title eyebrow">Thẻ trả lời sai — đọc lại</div><div class="wrong-list">${wrong.map(it => `<div class="card wl">
      <div class="stem" style="font-size:1rem">${isGrammar(it) ? fillStem(it) : it.stem}</div>
      <div class="wl-ans"><span class="chip ok">Đáp án: ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}</span></div>
      <div class="exp ng"><span class="eyebrow">Ghi nhớ</span>${it.exp}</div></div>`).join("")}</div>` : ""}
    ${FOOTER}
  </div>`;
  scrollTo(0, 0);
}
document.addEventListener("keydown", e => {
  if (!SES || SES.finished || !location.hash.startsWith("#review/") || e.metaKey || e.ctrlKey || e.altKey || $(".modal")) return;
  if (e.target.tagName === "INPUT") return;
  const c = SES.queue[SES.i];
  if (c.mode === "flip" && !SES.cur.revealed && (e.key === " " || e.key === "Enter")) flipCard();
  else if (c.mode === "flip" && SES.cur.revealed && !SES.cur.result && /^[1-4]$/.test(e.key)) gradeFlip(+e.key);
  else if (c.mode === "mc" && !SES.cur.result && /^[1-4]$/.test(e.key)) { const v = +e.key; gradeAuto(v === c.it.ans, v); }
  else if (SES.cur.result && (e.key === "Enter" || e.key === "ArrowRight")) nextCard();
  else return;
  e.preventDefault();
});
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#review/")) SES = null; else if (SES && SES.finished) SES = null; });

// ---------- Thống kê ----------
async function renderStats(level) {
  if (!LEVELS.includes(level)) level = "N2";
  const [data] = await Promise.all([loadQuests(level), loadUser(level)]);
  const log = QLOG[level];
  const levelSeg = `<div class="seg" style="max-width:160px">${LEVELS.map(l => `<button data-lv="${l}" class="${l === level ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!data) {
    $("#app").innerHTML = `${appBar("stats", log.remote)}<div class="page wide"><div class="qmap-head"><div><div class="eyebrow">Thống kê</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
      <div class="card gridpaper empty"><h3>Chưa có dữ liệu ${level}</h3></div>${FOOTER}</div>`;
    bindLevelSeg("stats"); return;
  }
  const A = analyze(level), P = plan(level);
  const pct = A.total ? Math.round(A.totalOk / A.total * 100) : null;
  const weakRows = A.weak.slice(0, 15).map(iid => {
    const it = data.itemMap[iid], s = A.items[iid] || { ok: 0, n: 0, hist: [] }, st = SRS[level][iid];
    return `<details class="wk"><summary>
        <span class="wk-tag">${esc(it.tag || "")}</span><span class="wk-q small muted">${esc(it.quest.title)}${st ? ` · quên ${st.lapses} lần` : ""}</span>
        <span class="wk-r">${s.ok}/${s.n}</span>
        <span class="wk-h">${s.hist.slice(-5).map(c => `<i class="${c ? "o" : "x"}" title="${c ? "đúng" : "sai"}"></i>`).join("")}</span>
      </summary><div class="wk-body"><div class="stem" style="font-size:.98rem">${isGrammar(it) ? fillStem(it) : it.stem}</div>
        <div class="wl-ans"><span class="chip ok">Đáp án: ${esc(it.opts[it.ans - 1].replace(/<[^>]+>/g, ""))}</span></div>
        <div class="exp ng"><span class="eyebrow">Ghi nhớ</span>${it.exp}</div></div></details>`;
  }).join("");
  const sessions = A.attempts.slice(-8).reverse();
  $("#app").innerHTML = `${appBar("stats", log.remote)}
  <div class="page wide">
    <div class="qmap-head"><div><div class="eyebrow">Thống kê · Ôn tập hằng ngày</div><h2 class="intro-h">${level}</h2></div>${levelSeg}</div>
    <div class="kpis">
      ${kpi("Đến hạn hôm nay", P.dueAll, "thẻ")}${kpi("Tỉ lệ đúng", pct ?? "—", pct == null ? "" : "%")}
      ${kpi("Thuộc lâu", A.buckets.mature, "/ " + A.nItems)}${kpi("Đã học", A.nItems - A.buckets.new, "/ " + A.nItems)}
      ${kpi("Chuỗi ngày", A.streak, "ngày")}${kpi("Tốc độ TB", A.avgSec == null ? "—" : A.avgSec < 1 ? "<1" : A.avgSec, A.avgSec == null ? "" : "giây/thẻ")}
    </div>
    ${A.total ? "" : `<div class="card gridpaper empty" style="margin-bottom:14px"><b>Chưa có dữ liệu.</b> <span class="muted small">Ôn một buổi để bắt đầu thống kê.</span> <a class="btn pri sm" href="#review/${level}/study">Bắt đầu</a></div>`}
    <section class="card chart-card" style="margin-bottom:14px" id="hm-card">${heatmapCard(A, HM_METRIC)}</section>
    <div class="stat-grid">
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Dự báo</div><h3>Thẻ đến hạn · 14 ngày tới</h3></div><button class="btn sm" data-table="t-fc">Bảng</button></div>
        ${forecastChart(forecast(level, 14))}
        <table class="dtable hide" id="t-fc"><thead><tr><th>Ngày</th><th>Thẻ đến hạn</th></tr></thead><tbody>${forecast(level, 14).map((f, i) => `<tr><td>${i === 0 ? "Hôm nay (gồm quá hạn)" : fmtDay(numToDate(f.d).getTime())}</td><td>${f.n}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Mức độ thuộc</div><h3>${A.buckets.mature} thẻ thuộc lâu</h3></div></div>
        ${srsBar(A)}
      </section>
    </div>
    <div class="stat-grid" style="margin-top:14px">
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Hoạt động</div><h3>Số lượt ôn mỗi ngày · 14 ngày</h3></div><button class="btn sm" data-table="t-days">Bảng</button></div>
        ${daysChart(A.days)}
        <table class="dtable hide" id="t-days"><thead><tr><th>Ngày</th><th>Lượt</th><th>Đúng</th></tr></thead><tbody>${A.days.map(d => `<tr><td>${fmtDay(d.t)}</td><td>${d.n}</td><td>${d.n ? Math.round(d.ok / d.n * 100) + "%" : "—"}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="card chart-card">
        <div class="chart-h"><div><div class="eyebrow">Buổi ôn gần đây</div><h3>${A.attempts.length} buổi</h3></div></div>
        ${sessions.length ? sessions.map(a => `<div class="hist-row" style="grid-template-columns:1fr auto auto"><span class="small muted">${new Date(a.finished_at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</span><b>${a.correct}/${a.total}</b><span class="small muted">${Math.round(a.correct / a.total * 100)}%</span></div>`).join("") : `<p class="small muted">Chưa có buổi nào.</p>`}
      </section>
    </div>
    <section class="card chart-card" style="margin-top:14px">
      <div class="chart-h"><div><div class="eyebrow">Theo bộ thẻ</div><h3>Tỉ lệ đúng từng bộ</h3></div><span class="small muted">Vạch dọc: mốc 70%</span></div>
      ${deckBars(A)}
    </section>
    <section class="card" style="margin-top:14px">
      <div class="chart-h"><div><div class="eyebrow" style="color:var(--accent)">Điểm yếu</div><h3>${A.weak.length} thẻ hay quên</h3></div>${A.weak.length ? `<a class="btn pri sm" href="#review/${level}/weak">Ôn ngay</a>` : ""}</div>
      ${A.weak.length ? `<div class="wk-head small muted"><span>Mẫu / từ</span><span>Bộ thẻ</span><span>Đúng</span><span>5 lần gần nhất</span></div>${weakRows}` : `<p class="muted small">Chưa có thẻ yếu.</p>`}
    </section>
    ${FOOTER}
  </div>`;
  bindLevelSeg("stats");
  bindHeatmap(A);
  $$("[data-table]").forEach(b => b.onclick = () => $("#" + b.dataset.table).classList.toggle("hide"));
  bindTips();
}
function srsBar(A) {
  const b = A.buckets;
  const seg = (k, label) => b[k] ? `<i class="m-${k}" style="flex:${b[k]}" title="${label}: ${b[k]}"></i>` : "";
  const row = (k, label) => `<div class="ml"><i class="m-${k}"></i><span>${label}</span><b>${b[k]}</b></div>`;
  return `<div class="mbar">${seg("mature", "Thuộc lâu")}${seg("young", "Đang ôn")}${seg("learn", "Đang học lại")}${seg("new", "Chưa học")}</div>
    <div class="mlegend">${row("mature", "Thuộc lâu (khoảng ôn ≥ 21 ngày)")}${row("young", "Đang ôn (< 21 ngày)")}${row("learn", "Đang học lại (vừa quên)")}${row("new", "Chưa học")}</div>`;
}
function deckBars(A) {
  return `<div class="tbars">${A.byDeck.map(d => {
    const p = d.n ? Math.round(d.ok / d.n * 100) : null;
    return `<div class="tb hit" data-tip="${esc(d.q.title)}: ${d.n ? `${d.ok}/${d.n} lượt đúng (${p}%)` : "chưa học"} · thuộc lâu ${d.b.mature}/${d.q.items.length}">
      <span class="tb-l"><span class="eyebrow">${esc(d.q.kind)}</span>${esc(d.q.title)}</span>
      <span class="tb-track"><i style="width:${p ?? 0}%"></i><b class="tb-ref"></b></span>
      <span class="tb-v">${p == null ? "—" : p + "%"}<small>${d.n ? ` · ${d.n}` : ""}</small></span></div>`;
  }).join("")}</div>`;
}
function forecastChart(fc) {
  const days = fc.map(f => ({ t: numToDate(f.d).getTime(), n: f.n, ok: 0, fc: true }));
  return daysChart(days, true);
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
function daysChart(days, fc = false) {
  const tday = fc ? 0 : days.length - 1;
  const W = innerWidth < 600 ? 340 : 560, H = innerWidth < 600 ? 150 : 170, padL = 26, padB = 22, padT = 10, bw = (W - padL) / days.length;
  const max = Math.max(10, ...days.map(d => d.n));
  const nice = Math.ceil(max / 10) * 10;
  const y = v => padT + (H - padT - padB) * (1 - v / nice);
  const grid = [0, nice / 2, nice].map(v => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${padL - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${v}</text>`).join("");
  const bars = days.map((d, i) => {
    const x = padL + i * bw + 3, w = bw - 6, h = Math.max(0, y(0) - y(d.n));
    const r = Math.min(4, w / 2, h);
    const tip = fc ? `${i === 0 ? "Hôm nay (gồm quá hạn)" : fmtDay(d.t)}: ${d.n} thẻ đến hạn`
                   : `${fmtDay(d.t)}: ${d.n} lượt${d.n ? ` · đúng ${Math.round(d.ok / d.n * 100)}%` : ""}`;
    const path = h > 0 ? `M${x},${y(0)} V${y(d.n) + r} Q${x},${y(d.n)} ${x + r},${y(d.n)} H${x + w - r} Q${x + w},${y(d.n)} ${x + w},${y(d.n) + r} V${y(0)} Z` : "";
    return `<g class="hit" data-tip="${tip}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>${path ? `<path d="${path}" class="bar"/>` : ""}
      ${i === tday || (fc ? i % 2 === 0 && i > 0 : i % 2 === 1) ? `<text x="${x + w / 2}" y="${H - 6}" class="ax" text-anchor="middle">${i === tday ? "Hôm nay" : fmtDay(d.t)}</text>` : ""}</g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${fc ? "Số thẻ đến hạn 14 ngày tới" : "Số lượt ôn mỗi ngày trong 14 ngày"}">${grid}<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/>${bars}</svg>`;
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
