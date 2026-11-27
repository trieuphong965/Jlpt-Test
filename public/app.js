"use strict";
/* JLPT 模擬試験 — SPA không framework.
   Màn hình: home → intro (chọn chế độ) → test (1 câu/màn hình + palette) → result → review. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-1.5 4L16 12H5"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};

// ---------- Lưu trữ: D1 qua /api, localStorage làm cache/dự phòng ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let API_OK = true;
async function api(path, opt = {}) {
  if (!API_OK) return null;
  try {
    const r = await fetch("/api/" + path, {
      method: opt.method || "GET",
      headers: opt.body ? { "content-type": "application/json" } : {},
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: "same-origin",
    });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) { if ([401, 404, 405].includes(r.status)) API_OK = false; return null; }
    return r.json();
  } catch { return null; }   // lỗi mạng (mất sóng, phiên Access hết hạn…) → coi là tạm thời, không tắt API
}

// ---------- Hàng đợi đồng bộ: ghi lên D1 thất bại (mất mạng) thì giữ lại, có mạng tự gửi lại ----------
// Mỗi mục có khoá riêng; ghi mới cùng khoá thay bản cũ. Server upsert theo updated_at / id nên gửi lại an toàn.
const PENDING = "jlpt-pending";
const pendingCount = () => Object.keys(store.get(PENDING, {})).length;
async function send(key, path, method, body) {
  const r = await api(path, { method, body });
  if (r) { flushQueue(); return r; }
  if (API_OK) { const q = store.get(PENDING, {}); q[key] = { path, method, body, at: Date.now() }; store.set(PENDING, q); }
  return null;
}
let flushing = null;
function flushQueue() {
  if (flushing || !API_OK) return flushing || Promise.resolve();
  flushing = (async () => {
    const entries = Object.entries(store.get(PENDING, {})).sort((a, b) => a[1].at - b[1].at);
    for (const [key, it] of entries) {
      const r = await api(it.path, { method: it.method, body: it.body });
      if (!r) break;                                  // vẫn chưa có mạng → thử lại lần sau
      const q = store.get(PENDING, {}); if (q[key] && q[key].at === it.at) { delete q[key]; store.set(PENDING, q); }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
window.addEventListener("online", () => flushQueue());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Dữ liệu đề ----------
const SEC = { "文字・語彙": "moji", "文法": "bunpou", "読解": "dokkai", "聴解": "choukai" };
const SP_LABEL = { N: "", M: "男", F: "女", M2: "男2", F2: "女2" };
const LOGO = `<div class="logo"><i>試</i>JLPT <b>模試</b></div>`;
const FOOTER = `<footer>Voice by <a href="https://elevenlabs.io/text-to-speech" target="_blank" rel="noopener">ElevenLabs</a></footer>`;
let INDEX = [], EXAM = null, S = null, PAGES = [], timerId = null, saveT = null, AUDIO = null;

const isL = m => m.section === "聴解";
const hasL = ex => ex.mondai.some(isL);
const nChoices = it => it.opts ? it.opts.length : (it.n || 4);
const fmt = sec => { const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0"); };
const limitFor = scope => scope === "A" ? EXAM.time : scope === "L" ? (EXAM.listenTime || 50) : EXAM.time + (hasL(EXAM) ? (EXAM.listenTime || 50) : 0);

function buildPages(scope) {
  const out = [];
  EXAM.mondai.forEach((m, mi) => {
    if (scope === "A" && isL(m)) return;
    if (scope === "L" && !isL(m)) return;
    m.groups.forEach((g, gi) => g.items.forEach((it, ii) =>
      out.push({ m, mi, g, gi, it, ii, firstOfMondai: gi === 0 && ii === 0, sec: SEC[m.section] })));
  });
  return out;
}
async function loadIndex() { INDEX = await (await fetch("exams/index.json")).json(); window.SPLASH && SPLASH.step("index"); }
async function loadExam(id) {
  const meta = INDEX.find(e => e.id === id); if (!meta) return null;
  return (await fetch(meta.file)).json();
}

// ---------- Router ----------
async function route() {
  stopAudio(); clearInterval(timerId); closeSheet(); document.querySelectorAll(".tip").forEach(t => t.remove());
  const id = location.hash.slice(1);
  const parts = id.split("/");
  if (parts[0] === "quest") { location.replace("#review/" + (parts[1] || "N2")); return; }
  if (parts[0] === "review") { S = null; EXAM = null; await routeReview(parts); scrollTo(0, 0); return; }
  if (parts[0] === "stats") { S = null; EXAM = null; await renderStats(parts[1] || "N2"); scrollTo(0, 0); return; }
  if (parts[0] === "exams") { S = null; EXAM = null; await renderHome(); scrollTo(0, 0); return; }
  if (id && INDEX.some(e => e.id === id)) {
    if (!EXAM || EXAM.id !== id) { EXAM = await loadExam(id); EXAM._audio = hasL(EXAM) ? await api("listening/" + id) : null; }
    await openExam();
  } else { S = null; EXAM = null; await renderDashboard(); }
  scrollTo(0, 0);
}

// ---------- Home ----------
async function renderHome() {
  const remote = await api("state");
  const last = {}, prog = new Set();
  if (remote) {
    remote.last.forEach(r => last[r.exam_id] = { correct: r.correct, total: r.total, at: r.finished_at });
    remote.progress.forEach(r => prog.add(r.exam_id));
  } else Object.assign(last, store.get("jlpt-history", {}));
  const card = e => {
    const h = last[e.id], loc = store.get("jlpt-progress-" + e.id, null);
    const doing = prog.has(e.id) || (loc && loc.phase === "test");
    const pct = h ? Math.round(h.correct / h.total * 100) : null;
    return `<button class="exam-card" data-id="${e.id}">
      <div class="lv">${e.level}</div>
      <div style="flex:1;min-width:0">
        <div class="t">${esc(e.title)}</div>
        <div class="meta">
          <span>言語知識・読解${e.listening ? "・聴解" : ""}</span>
          ${doing ? `<span class="chip warn">Đang làm dở</span>` : ""}
          ${h ? `<span class="chip ${pct >= 60 ? "ok" : "ng"}">Lần gần nhất ${h.correct}/${h.total} · ${pct}%</span>` : `<span class="chip">Chưa làm</span>`}
        </div>
      </div>
      <span class="go">${ICON.next.replace("<svg", '<svg width="20" height="20" style="stroke:currentColor;fill:none;stroke-width:2"')}</span>
    </button>`;
  };
  const levels = [...new Set(INDEX.map(e => e.level))];
  $("#app").innerHTML = `${appBar("exams", remote)}
  <div class="page">
    <div class="hero gridpaper">
      <div class="eyebrow">模擬試験 · ${INDEX.length} đề</div>
      <h1>Đề thi thử JLPT</h1>
      <p>Cấu trúc theo đề thật N2・N1. Thi thử có bấm giờ, hoặc luyện tập xem đáp án ngay.</p>
      <div class="blocks" aria-hidden="true"><span class="hatch" style="height:14px"></span><span class="hatch" style="height:24px"></span><span style="height:34px;background:var(--dark)"></span><span class="hatch" style="height:46px"></span></div>
    </div>
    ${levels.map(lv => `<div class="sect-title eyebrow">${lv} · ${INDEX.filter(e => e.level === lv).length} đề</div><div class="exam-list">${INDEX.filter(e => e.level === lv).map(card).join("")}</div>`).join("")}
    ${FOOTER}
  </div>`;
  $$(".exam-card").forEach(b => b.onclick = () => { location.hash = b.dataset.id; });
}

// ---------- Mở đề: khôi phục trạng thái ----------
const freshState = (mode = "exam", scope = "all") => ({
  id: uid(), phase: "intro", mode, scope, answers: {}, flags: {}, cur: 0,
  elapsed: 0, started_at: null, filter: "all", result: null,
});
async function openExam() {
  const local = store.get("jlpt-progress-" + EXAM.id, null);
  const remote = await api("attempt/" + EXAM.id);
  S = local && local.phase ? local : freshState();
  if (remote && remote.id !== S.id && (!local || remote.updated_at > (local.saved_at || 0))) {
    // Bài làm dở từ thiết bị khác
    S = { ...freshState(), id: remote.id, phase: "test", answers: remote.answers, started_at: remote.started_at,
          elapsed: remote.left_sec != null ? limitFor("all") * 60 - remote.left_sec : 0 };
  }
  PAGES = buildPages(S.scope);
  if (S.phase === "review") S.phase = "result";
  render();
}
function persist(remoteNow) {
  S.saved_at = Date.now();
  store.set("jlpt-progress-" + EXAM.id, S);
  if (S.phase !== "test") return;
  clearTimeout(saveT);
  const ex = EXAM.id, sendNow = () => send("exam-progress:" + ex, "attempt/" + ex, "PUT", {
    id: S.id, answers: S.answers, left: Math.round(limitFor(S.scope) * 60 - S.elapsed), started_at: S.started_at });
  if (remoteNow) sendNow(); else saveT = setTimeout(sendNow, 3000);
}
function render() {
  stopAudio(); clearInterval(timerId); closeSheet();
  ({ intro: renderIntro, test: renderTest, result: renderResult, review: renderTest })[S.phase]();
}

// ---------- Intro ----------
async function renderIntro() {
  const L = hasL(EXAM);
  const rows = []; let lastSec = null;
  EXAM.mondai.forEach(m => {
    const n = m.groups.reduce((a, g) => a + g.items.length, 0);
    const key = isL(m) ? "聴解" : m.section === "読解" ? "読解" : "言語知識（文字・語彙・文法）";
    if (lastSec && lastSec.key === key) { lastSec.n += n; lastSec.m.push(m.no); } else rows.push(lastSec = { key, n, m: [m.no] });
  });
  const hist = await api("history/" + EXAM.id) || [];
  const inProg = S.phase === "intro" && Object.keys(S.answers).length;
  $("#app").innerHTML = `
    <div class="topbar"><div class="in">
      <button class="icon-btn" id="home" aria-label="Trang chủ">${ICON.back}</button>
      <div class="ttl"><b>${esc(EXAM.title)}</b><span>${EXAM.level}</span></div>
    </div></div>
    <div class="page">
      <div class="card gridpaper">
        <div class="eyebrow">${EXAM.level} · ${esc(EXAM.ref || "")}</div>
        <h2 class="intro-h">${esc(EXAM.title)}</h2>
        <table class="struct">${rows.map(r => `<tr><td>${r.key}<div class="small muted">問題${r.m[0]}${r.m.length > 1 ? "–" + r.m[r.m.length - 1] : ""}</div></td><td>${r.n} câu</td></tr>`).join("")}
          </table><div class="timebox"><span class="chip">⏱ 言語知識・読解 ${EXAM.time} phút</span>${L ? `<span class="chip">⏱ 聴解 ${EXAM.listenTime || 50} phút</span>` : ""}</div>
        <div class="field"><span class="eyebrow">Chế độ</span>
          <div class="seg" id="mode"><button data-v="exam" class="${S.mode === "exam" ? "on" : ""}">Thi thử</button><button data-v="practice" class="${S.mode === "practice" ? "on" : ""}">Luyện tập</button></div>
          <div class="hint" id="modehint"></div></div>
        ${L ? `<div class="field"><span class="eyebrow">Phần thi</span>
          <div class="seg" id="scope"><button data-v="all" class="${S.scope === "all" ? "on" : ""}">Toàn bộ</button><button data-v="A" class="${S.scope === "A" ? "on" : ""}">言語・読解</button><button data-v="L" class="${S.scope === "L" ? "on" : ""}">聴解</button></div>
          ${EXAM._audio ? `<div class="hint">Audio đã có ${EXAM._audio.done}/${EXAM._audio.total} đoạn${EXAM._audio.done < EXAM._audio.total ? " — câu chưa có audio sẽ hiện script" : ""}.</div>` : ""}</div>` : ""}
        <div class="actions">
          <button class="btn pri block" id="start">${inProg ? "Tiếp tục làm" : "Bắt đầu"}</button>
        </div>
      </div>
      ${hist.length ? `<div class="sect-title eyebrow">Lịch sử làm bài</div><div class="card hist">${hist.slice(0, 8).map(h => `<div><span>${new Date(h.finished_at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</span><b>${h.correct}/${h.total}</b></div>`).join("")}</div>` : ""}
      ${FOOTER}
    </div>`;
  const hint = () => $("#modehint").textContent = S.mode === "exam"
    ? "Bấm giờ ngược, đáp án và lời giải hiện sau khi nộp bài."
    : "Không giới hạn giờ, chọn xong là thấy đáp án và lời giải ngay.";
  hint();
  $("#home").onclick = () => { location.hash = "exams"; };
  $$("#mode button").forEach(b => b.onclick = () => { S.mode = b.dataset.v; $$("#mode button").forEach(x => x.classList.toggle("on", x === b)); hint(); });
  $$("#scope button").forEach(b => b.onclick = () => { S.scope = b.dataset.v; $$("#scope button").forEach(x => x.classList.toggle("on", x === b)); });
  $("#start").onclick = () => {
    S.phase = "test"; S.started_at = S.started_at || Date.now();
    PAGES = buildPages(S.scope); S.cur = Math.min(S.cur, PAGES.length - 1);
    persist(true); render(); scrollTo(0, 0);
  };
}

// ---------- Test / Review ----------
const answered = p => S.answers[p.it.q] != null;
const reviewing = () => S.phase === "review";
const revealed = p => reviewing() || (S.mode === "practice" && answered(p));
function visiblePages() {
  if (!reviewing() || S.filter === "all") return PAGES.map((p, i) => i);
  return PAGES.map((p, i) => i).filter(i => S.answers[PAGES[i].it.q] !== PAGES[i].it.ans);
}

function renderTest() {
  const p = PAGES[S.cur]; if (!p) { S.cur = 0; return renderTest(); }
  const vis = visiblePages(), vpos = vis.indexOf(S.cur);
  const done = Object.keys(S.answers).filter(q => PAGES.some(x => String(x.it.q) === q)).length;
  const hasPass = !!p.g.passage;
  const limit = limitFor(S.scope) * 60;

  $("#app").innerHTML = `
    <div class="topbar"><div class="in">
      <button class="icon-btn" id="exit" aria-label="Thoát">${ICON.close}</button>
      <div class="ttl"><b>問題${p.m.no} · ${p.m.section}</b><span>${esc(EXAM.title)}${reviewing() ? " · Xem lại" : S.mode === "practice" ? " · Luyện tập" : ""}</span></div>
      ${reviewing() ? "" : `<span class="timer" id="timer"></span>`}
      <button class="count-btn" id="pal">${ICON.grid.replace("<svg", '<svg width="16" height="16" style="stroke:currentColor;fill:none;stroke-width:2"')}<span>${reviewing() ? `${vpos + 1}/${vis.length}` : `${done}/${PAGES.length}`}</span></button>
    </div></div>
    <div class="shell">
      <aside class="side"><div class="scroll">${paletteHtml(false)}</div><div class="foot">${progLine()}</div></aside>
      <main class="stage">
        ${reviewing() ? `<div class="review-bar"><span class="small muted">Hiển thị:</span>
          <div class="seg" style="flex:1;max-width:320px"><button data-f="all" class="${S.filter === "all" ? "on" : ""}">Tất cả</button><button data-f="ng" class="${S.filter === "ng" ? "on" : ""}">Câu sai</button></div>
          <button class="btn sm" id="toResult">Kết quả</button></div>` : ""}
        <div class="qhead-row">
          <div><div class="eyebrow">${p.m.section} · 問題 ${p.m.no}</div><h2>${reviewing() ? "Xem lại" : S.mode === "practice" ? "Luyện tập" : "Thi thử"}</h2></div>
          <div style="text-align:right"><span class="tag">${p.m.section}</span><div class="eyebrow" style="margin-top:6px">Câu ${p.ii + 1 + p.m.groups.slice(0, p.gi).reduce((a, g) => a + g.items.length, 0)} / ${p.m.groups.reduce((a, g) => a + g.items.length, 0)}</div></div>
        </div>
        <div class="instr ${p.firstOfMondai ? "" : "clamp"}" id="instr"><span class="ic">!</span><span class="tx"><span class="eyebrow" style="color:var(--accent)">Hướng dẫn</span><br>${p.m.instr}</span></div>
        ${p.m.script && p.firstOfMondai ? unitHtml("m" + p.mi, p.m.script, "Lời dẫn 問題" + p.m.no) : ""}
        <div class="canvas gridpaper"><div class="split ${hasPass ? "has-passage" : ""}">
          ${hasPass ? `<div class="passage-col">
              <button class="pass-toggle eyebrow" id="ptog"><span>Bài đọc · cuộn trong khung · bấm để mở rộng</span>${ICON.chev.replace("<svg", '<svg width="18" height="18" style="stroke:currentColor;fill:none;stroke-width:2"')}</button>
              <div class="passage" id="pbody">${p.g.label ? `<p class="lbl">${p.g.label}</p>` : ""}${p.g.passage.includes("<table") ? `<div class="tblwrap">${p.g.passage}</div>` : p.g.passage}</div>
            </div>` : ""}
          <div>
            ${p.g.script ? unitHtml("g" + p.g.items[0].q, p.g.script, "Bài nghe chung") : ""}
            ${questionHtml(p)}
          </div>
        </div></div>
        ${stepperHtml(p)}
        <div class="kbd-hint"><kbd>1</kbd>–<kbd>4</kbd> chọn đáp án · <kbd>←</kbd> <kbd>→</kbd> chuyển câu · <kbd>F</kbd> đánh dấu</div>
        ${FOOTER}
      </main>
    </div>
    <div class="bottombar"><div class="in">
      <button class="btn" id="prev" ${vpos <= 0 ? "disabled" : ""}>${ICON.back}Trước</button>
      <div class="pos">${reviewing() ? `${vpos + 1} / ${vis.length}` : `Câu ${S.cur + 1} / ${PAGES.length}`}</div>
      ${!reviewing() && S.cur === PAGES.length - 1
        ? `<button class="btn pri" id="submit">Nộp bài</button>`
        : `<button class="btn pri" id="next" ${vpos >= vis.length - 1 ? "disabled" : ""}>Tiếp<span class="lbl-long">(${esc(PAGES[vis[vpos + 1]]?.it.no || PAGES[vis[vpos + 1]]?.it.q || "")})</span>${ICON.next}</button>`}
    </div></div>`;

  // Thoát / palette / điều hướng
  $("#exit").onclick = () => reviewing() ? (S.phase = "result", persist(), render()) : confirmExit();
  $("#pal").onclick = openSheet;
  $("#prev").onclick = () => go(vis[vpos - 1]);
  const nx = $("#next"); if (nx) nx.onclick = () => go(vis[vpos + 1]);
  const sb = $("#submit"); if (sb) sb.onclick = confirmSubmit;
  const tr = $("#toResult"); if (tr) tr.onclick = () => { S.phase = "result"; persist(); render(); scrollTo(0, 0); };
  $$(".review-bar .seg button").forEach(b => b.onclick = () => {
    S.filter = b.dataset.f; const v = visiblePages();
    if (!v.includes(S.cur)) S.cur = v.length ? v[0] : 0;
    persist(); render();
  });
  const pt = $("#ptog"); if (pt) pt.onclick = () => { const pb = $("#pbody"); pb.classList.toggle("open"); pt.firstElementChild.textContent = pb.classList.contains("open") ? "Thu gọn bài đọc" : "Bài đọc · cuộn trong khung · bấm để mở rộng"; };
  $("#instr").onclick = e => e.currentTarget.classList.toggle("clamp");
  bindQuestion(p);
  bindPalette($(".side"));
  bindStepper();
  bindPlayers();

  // Đồng hồ
  if (!reviewing()) {
    const tick = () => {
      const t = $("#timer"); if (!t) return;
      if (S.mode === "exam") { const left = limit - S.elapsed; t.textContent = fmt(left); t.classList.toggle("warn", left < 600); if (left <= 0) { clearInterval(timerId); finish(); } }
      else t.textContent = fmt(S.elapsed);
    };
    tick();
    timerId = setInterval(() => { S.elapsed++; tick(); if (S.elapsed % 15 === 0) persist(); }, 1000);
  }
}

function questionHtml(p) {
  const it = p.it;
  return `<div class="qcard">
      <div class="qhead"><span class="qno">${esc(it.no || it.q)}</span><div class="stem">${it.stem || ""}</div>
        ${reviewing() ? "" : `<button class="flag-btn ${S.flags[it.q] ? "on" : ""}" id="flag" aria-label="Đánh dấu xem lại" title="Đánh dấu xem lại (F)">${ICON.flag}</button>`}</div>
      ${it.script ? unitHtml("q" + it.q, it.script, "") : ""}
      <div class="qans">${answersHtml(p)}</div>
    </div>`;
}
function answersHtml(p) {
  const it = p.it, a = S.answers[it.q], rev = revealed(p), L = isL(p.m);
  const labels = it.opts || Array.from({ length: nChoices(it) }, () => "");
  const numOnly = !it.opts;
  const compact = !numOnly && !L && p.m.section !== "読解" && it.opts.every(o => o.replace(/<[^>]+>/g, "").length <= 7);
  const opts = labels.map((o, i) => {
    const v = i + 1; let c = "opt";
    if (!rev && a === v) c += " sel";
    if (rev && v === it.ans) c += " correct";
    if (rev && a === v && a !== it.ans) c += " wrong";
    return `<button class="${c}" data-v="${v}" ${rev ? "disabled" : ""}><span class="n">${v}</span><span class="tx">${o}</span></button>`;
  }).join("");
  let fb = "";
  if (rev) {
    const ok = a === it.ans;
    fb = `<div class="verdict ${a == null ? "na" : ok ? "ok" : "ng"}">${a == null ? "Bỏ trống" : ok ? "✓ Chính xác" : `✗ Sai — bạn chọn ${a}`} · Đáp án ${it.ans}</div>
          ${it.exp ? `<div class="exp ${ok ? "" : "ng"}"><span class="eyebrow">Lời giải</span>${it.exp}</div>` : ""}`;
  }
  return `<div class="opts ${numOnly ? "numonly" + (labels.length === 3 ? " c3" : "") : compact ? "compact" : ""}">${opts}</div>${fb}`;
}
function bindQuestion(p) {
  $$(".qans .opt").forEach(b => b.onclick = () => choose(p, +b.dataset.v));
  const f = $("#flag"); if (f) f.onclick = () => toggleFlag(p);
}
function choose(p, v) {
  if (revealed(p)) return;
  S.answers[p.it.q] = v; persist();
  $(".qans").innerHTML = answersHtml(p);
  $$(".qans .opt").forEach(b => b.onclick = () => choose(p, +b.dataset.v));
  updateCounts();
}
function toggleFlag(p) {
  if (S.flags[p.it.q]) delete S.flags[p.it.q]; else S.flags[p.it.q] = true;
  persist(); $("#flag").classList.toggle("on", !!S.flags[p.it.q]); updateCounts();
}
function updateCounts() {
  const done = PAGES.filter(answered).length;
  const c = $("#pal span"); if (c && !reviewing()) c.textContent = `${done}/${PAGES.length}`;
  const side = $(".side"); if (side) { $(".scroll", side).innerHTML = paletteHtml(false); $(".foot", side).innerHTML = progLine(); bindPalette(side); }
  const st = $(".stepper"); if (st) { st.outerHTML = stepperHtml(PAGES[S.cur]); bindStepper(); }
}
function renderKeepScroll() { const y = scrollY; const pc = $(".passage-col"), py = pc ? pc.scrollTop : 0; renderTest(); scrollTo(0, y); const pc2 = $(".passage-col"); if (pc2) pc2.scrollTop = py; }
function go(i) {
  if (i == null || i < 0 || i >= PAGES.length) return;
  const sameGroup = PAGES[i].mi === PAGES[S.cur].mi && PAGES[i].gi === PAGES[S.cur].gi && PAGES[i].g.passage;
  S.cur = i; persist(); closeSheet();
  if (sameGroup) { renderKeepScroll(); const q = $(".qcard"); if (q && innerWidth < 900) q.scrollIntoView({ block: "start", behavior: "instant" }); }
  else { renderTest(); scrollTo(0, 0); }
}

// ---------- Palette ----------
const OPEN = new Set();
function stepState(p, i) {
  const a = S.answers[p.it.q]; const c = [];
  if (i === S.cur) c.push("cur");
  if (reviewing()) c.push(a == null ? "blank" : a === p.it.ans ? "ok" : "ng");
  else { if (S.mode === "practice" && a != null) c.push(a === p.it.ans ? "ok" : "ng"); else if (a != null) c.push("ans"); if (S.flags[p.it.q]) c.push("flag"); }
  return c;
}
function stepperHtml(p) {
  const idx = PAGES.map((x, i) => i).filter(i => PAGES[i].mi === p.mi);
  return `<div class="stepper"><div class="row"><span class="eyebrow">Trong 問題${p.m.no}</span><span class="eyebrow">${idx.filter(i => answered(PAGES[i])).length}/${idx.length} đã làm</span></div>
    <div class="steps">${idx.map(i => `<button class="step ${stepState(PAGES[i], i).join(" ")}" data-i="${i}"><span class="c">${esc(String(PAGES[i].it.no || PAGES[i].it.q).replace("番", "").replace(" 質問", "-"))}</span></button>`).join("")}</div></div>`;
}
function bindStepper() {
  $$(".stepper .step").forEach(b => b.onclick = () => go(+b.dataset.i));
  const c = $(".stepper .step.cur"); if (c) c.scrollIntoView({ block: "nearest", inline: "center" });
}
function progLine() {
  const n = PAGES.filter(answered).length;
  if (reviewing()) { const ok = PAGES.filter(p => S.answers[p.it.q] === p.it.ans).length; return `<div class="prog-line"><span>Đúng</span><div class="bar"><i class="hatch" style="width:${ok / PAGES.length * 100}%"></i></div><span>${ok}/${PAGES.length}</span></div>`; }
  return `<div class="prog-line"><span>Tiến độ</span><div class="bar"><i style="width:${n / PAGES.length * 100}%"></i></div><span>${n}/${PAGES.length}</span></div>
    <button class="btn pri block" data-submit style="margin-top:10px">Nộp bài</button>`;
}
function paletteHtml(sheet = true) {
  const by = [];
  PAGES.forEach((p, i) => { let s = by[by.length - 1]; if (!s || s.mi !== p.mi) by.push(s = { mi: p.mi, m: p.m, idx: [] }); s.idx.push(i); });
  const rev = reviewing();
  const vis = new Set(visiblePages());
  const cls = (p, i) => stepState(p, i).join(" ");
  const curMi = PAGES[S.cur]?.mi;
  const nAns = PAGES.filter(answered).length, nFlag = PAGES.filter(p => S.flags[p.it.q]).length;
  return `<div class="palette">
    ${sheet ? "" : `<div class="tree-h"><span class="eyebrow">${esc(EXAM.title)}</span><span class="eyebrow">${PAGES.length} câu</span></div>`}
    <div class="legend">${rev ? `<span><i class="o"></i>Đúng</span><span><i class="x"></i>Sai</span><span><i style="border-style:dashed"></i>Bỏ trống</span>`
      : `<span><i class="a"></i>Đã làm ${nAns}</span><span><i></i>Chưa làm ${PAGES.length - nAns}</span><span><i class="f"></i>Đánh dấu ${nFlag}</span>`}</div>
    ${by.map(s => {
      const okN = s.idx.filter(i => S.answers[PAGES[i].it.q] === PAGES[i].it.ans).length;
      const ansN = s.idx.filter(i => answered(PAGES[i])).length;
      const open = sheet || s.mi === curMi || OPEN.has(s.mi);
      return `<div class="pal-sec ${open ? "open" : ""} ${s.mi === curMi ? "cur" : ""}" data-mi="${s.mi}"><button class="tog"><span class="ar">▶</span><span class="nm">問題${s.m.no}<small>${s.m.section}</small></span><span class="ct">${rev ? okN : ansN}/${s.idx.length}</span></button>
        <div class="pal-grid">${s.idx.map(i => `<button data-i="${i}" class="${cls(PAGES[i], i)}" ${rev && !vis.has(i) ? "style='opacity:.35'" : ""}>${esc(String(PAGES[i].it.no || PAGES[i].it.q).replace("番", "").replace(" 質問", "-"))}</button>`).join("")}</div></div>`;
    }).join("")}
    ${rev || !sheet ? "" : `<button class="btn pri block" data-submit style="margin-top:10px">Nộp bài</button>`}
  </div>`;
}
function bindPalette(root) {
  if (!root) return;
  $$(".pal-grid button", root).forEach(b => b.onclick = () => go(+b.dataset.i));
  $$(".pal-sec .tog", root).forEach(b => b.onclick = () => { const sec = b.parentElement, mi = +sec.dataset.mi; sec.classList.toggle("open"); if (sec.classList.contains("open")) OPEN.add(mi); else OPEN.delete(mi); });
  const s = $("[data-submit]", root); if (s) s.onclick = () => { closeSheet(); confirmSubmit(); };
}
function openSheet() {
  closeSheet();
  const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.id = "sheet";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="Danh sách câu"><div class="grab"></div>
    <div class="sheet-h"><span class="eyebrow">Danh sách câu · ${PAGES.length}</span><button class="icon-btn" id="sclose" aria-label="Đóng">${ICON.close}</button></div>${paletteHtml()}</div>`;
  document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) closeSheet(); };
  $("#sclose", bg).onclick = closeSheet;
  bindPalette(bg);
  const cur = $(".pal-grid .cur", bg); if (cur) cur.scrollIntoView({ block: "center" });
}
function closeSheet() { const s = $("#sheet"); if (s) s.remove(); }

// ---------- Modals ----------
function modal(title, body, actions) {
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<div class="box"><h3>${title}</h3><div class="small muted">${body}</div><div class="acts">${actions.map((a, i) => `<button class="btn ${a.pri ? "pri" : ""}" data-i="${i}">${a.label}</button>`).join("")}</div></div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) d.remove(); };
  $$(".acts button", d).forEach(b => b.onclick = () => { d.remove(); actions[+b.dataset.i].fn?.(); });
}
function confirmSubmit() {
  const n = PAGES.filter(answered).length, t = PAGES.length, f = PAGES.filter(p => S.flags[p.it.q]).length;
  modal("Nộp bài?", `Đã làm <b>${n}/${t}</b> câu.${n < t ? ` Còn <b>${t - n}</b> câu bỏ trống.` : ""}${f ? ` <b>${f}</b> câu đang đánh dấu xem lại.` : ""}`,
    [{ label: "Làm tiếp" }, { label: "Nộp bài", pri: true, fn: finish }]);
}
function confirmExit() {
  modal("Tạm dừng?", "Bài làm được lưu lại, lần sau mở đề sẽ làm tiếp.",
    [{ label: "Ở lại" }, { label: "Thoát", pri: true, fn: () => { persist(true); location.hash = "exams"; } }]);
}

// ---------- Chấm điểm ----------
function computeScore() {
  const s = { moji: [0, 0], bunpou: [0, 0], dokkai: [0, 0], choukai: [0, 0] }, byM = {};
  let correct = 0;
  PAGES.forEach(p => {
    const ok = S.answers[p.it.q] === p.it.ans;
    s[p.sec][1]++; if (ok) { s[p.sec][0]++; correct++; }
    const k = p.mi; byM[k] = byM[k] || { no: p.m.no, sec: p.m.section, c: 0, t: 0 }; byM[k].t++; if (ok) byM[k].c++;
  });
  return { s, byM: Object.values(byM), correct, total: PAGES.length };
}
async function finish() {
  clearInterval(timerId); clearTimeout(saveT); stopAudio();
  const r = computeScore();
  S.phase = "result"; S.result = r; S.finished_at = Date.now(); persist();
  const h = store.get("jlpt-history", {}); h[EXAM.id] = { correct: r.correct, total: r.total, at: Date.now() }; store.set("jlpt-history", h);
  send("exam-finish:" + S.id, `attempt/${EXAM.id}/finish`, "POST", {
    id: S.id, answers: S.answers, left: Math.round(limitFor(S.scope) * 60 - S.elapsed),
    score: { ...r.s, scope: S.scope, mode: S.mode }, correct: r.correct, total: r.total, started_at: S.started_at });
  render(); scrollTo(0, 0);
}

// ---------- Kết quả ----------
function renderResult() {
  if (!PAGES.length) PAGES = buildPages(S.scope);
  const r = S.result || computeScore();
  const sc = (c, t) => t ? Math.round(c / t * 60) : null;
  const parts = [
    { k: "言語知識", sub: "文字・語彙・文法", v: sc(r.s.moji[0] + r.s.bunpou[0], r.s.moji[1] + r.s.bunpou[1]) },
    { k: "読解", v: sc(...r.s.dokkai) },
    { k: "聴解", v: sc(...r.s.choukai) },
  ].filter(x => x.v != null);
  const full = parts.length === 3, tot = parts.reduce((a, x) => a + x.v, 0);
  const passLine = EXAM.level === "N1" ? 100 : 90;
  const anyLow = parts.some(x => x.v < 19);
  const pass = full ? tot >= passLine && !anyLow : !anyLow && tot >= parts.length * 30;
  const pct = Math.round(r.correct / r.total * 100);
  const wrong = PAGES.filter(p => S.answers[p.it.q] !== p.it.ans).length;
  const col = v => v >= 70 ? "var(--ok)" : v >= 50 ? "var(--flag)" : "var(--ng)";

  $("#app").innerHTML = `
    <div class="topbar"><div class="in">
      <button class="icon-btn" id="home" aria-label="Trang chủ">${ICON.back}</button>
      <div class="ttl"><b>Kết quả</b><span>${esc(EXAM.title)} · ${S.mode === "exam" ? "Thi thử" : "Luyện tập"}${S.scope !== "all" ? " · " + (S.scope === "A" ? "言語知識・読解" : "聴解") : ""}</span></div>
    </div></div>
    <div class="page">
      <div class="card">
        <div class="score-hero">
          <div class="big-score"><div class="fill hatch" style="height:${pct}%"></div><b>${r.correct}</b><span>/ ${r.total} câu · ${pct}%</span></div>
          <div>
            <div class="eyebrow">Kết quả ước tính</div>
            <div class="verdict-big ${pass ? "ok" : "ng"}">${full ? (pass ? "合格ライン達成" : "不合格ライン") : (pass ? "Đạt mức an toàn" : "Chưa đạt")}</div>
            <div class="small muted">${full ? `Tổng ước tính <b>${tot}</b>/180 · cần ≥ ${passLine} và mỗi phần ≥ 19` : `Mỗi phần cần ≥ 19/60 (an toàn ≥ 30)`}</div>
            <div class="small muted">Thời gian làm: ${fmt(S.elapsed)}</div>
          </div>
        </div>
        <div class="scores">${parts.map(x => `<div class="sc ${x.v < 19 ? "low" : ""}"><div class="eyebrow">${x.k}${x.sub ? ` · ${x.sub}` : ""}</div><div class="v">${x.v}<small> /60</small></div>${x.v < 19 ? `<div class="s">Dưới 基準点 19</div>` : ""}</div>`).join("")}</div>
        <p class="small muted" style="margin:12px 0 0">Điểm quy đổi tuyến tính theo tỉ lệ đúng; JLPT thật dùng thang cân bằng nên chỉ để tham khảo.</p>
        <div class="actions" style="grid-template-columns:1fr 1fr">
          <button class="btn pri" id="revNg" ${wrong ? "" : "disabled style='opacity:.5'"}>Xem câu sai (${wrong})</button>
          <button class="btn" id="revAll">Xem toàn bộ</button>
        </div>
      </div>
      <div class="sect-title eyebrow">Theo từng 問題</div>
      <div class="card gridpaper">${r.byM.map(m => { const v = Math.round(m.c / m.t * 100); return `<div class="mrow"><span>問題${m.no}<div class="small muted">${m.sec}</div></span><div class="bar"><i style="width:${v}%;background:repeating-linear-gradient(-45deg,${col(v)} 0 3px,color-mix(in srgb,${col(v)} 45%,transparent) 3px 6px)"></i></div><span>${m.c}/${m.t}</span></div>`; }).join("")}</div>
      <div class="actions" style="grid-template-columns:1fr 1fr">
        <button class="btn" id="retry">Làm lại đề</button>
        <button class="btn" id="home2">Trang chủ</button>
      </div>
      ${FOOTER}
    </div>`;
  $("#home").onclick = $("#home2").onclick = () => { location.hash = "exams"; };
  const review = f => { S.phase = "review"; S.filter = f; const v = visiblePages(); S.cur = v.length ? v[0] : 0; persist(); render(); scrollTo(0, 0); };
  $("#revNg").onclick = () => review("ng");
  $("#revAll").onclick = () => review("all");
  $("#retry").onclick = () => modal("Làm lại đề?", "Bắt đầu lượt mới. Kết quả lượt này vẫn nằm trong lịch sử.",
    [{ label: "Huỷ" }, { label: "Làm lại", pri: true, fn: async () => { await api("attempt/" + EXAM.id, { method: "DELETE" }); S = freshState(S.mode, S.scope); persist(); render(); scrollTo(0, 0); } }]);
}

// ---------- Audio 聴解 ----------
function scriptHtml(segs) {
  return `<div class="script">${segs.map(s => s.pause != null ? `<div class="pz">（${s.pause}秒）</div>`
    : `<div class="ln"><span class="sp">${SP_LABEL[s.sp] ?? s.sp}</span><span>${esc(s.text)}</span></div>`).join("")}</div>`;
}
function unitHtml(id, segs, label) {
  const a = EXAM._audio?.units?.[id], ready = !!(a && a.ready);
  const showScript = !ready || reviewing();
  const nA = a ? a.segs.filter(s => !s.pause).length : segs.filter(s => !s.pause).length;
  const nD = a ? a.segs.filter(s => s.src).length : 0;
  return `<div class="unit" data-u="${id}">
    <div class="player ${ready ? "" : "na"}">
      ${ready ? `<button class="play" aria-label="Phát">${ICON.play}</button>` : ""}
      <div class="prog">${ready ? `<div class="bar"><i></i></div>` : ""}<div class="st">${label ? label + " · " : ""}${ready ? "Sẵn sàng" : `Chưa có audio (${nD}/${nA} đoạn) — đọc script`}</div></div>
      <button class="scr">${showScript ? "Ẩn script" : "Script"}</button>
    </div>
    <div class="scrbox ${showScript ? "" : "hide"}">${scriptHtml(segs)}</div></div>`;
}
function bindPlayers() {
  $$(".unit").forEach(u => {
    $(".scr", u).onclick = () => { const b = $(".scrbox", u); b.classList.toggle("hide"); $(".scr", u).textContent = b.classList.contains("hide") ? "Script" : "Ẩn script"; };
    const pb = $(".play", u); if (!pb) return;
    pb.onclick = () => (AUDIO && AUDIO.u === u) ? stopAudio() : playUnit(u);
  });
}
function stopAudio() {
  if (!AUDIO) return;
  AUDIO.stop = true; clearTimeout(AUDIO.t); AUDIO.el.pause();
  const u = AUDIO.u; AUDIO = null;
  if (u.isConnected) { $(".play", u).innerHTML = ICON.play; }
}
function playUnit(u) {
  stopAudio();
  const segs = EXAM._audio.units[u.dataset.u].segs;
  const el = new Audio(); el.preload = "auto";
  const me = AUDIO = { u, el, stop: false, t: 0 };
  $(".play", u).innerHTML = ICON.stop;
  const st = $(".st", u), bar = $(".bar i", u);
  const total = segs.reduce((a, s) => a + (s.pause || 1), 0); let acc = 0;
  const step = i => {
    if (me.stop) return;
    bar.style.width = (acc / total * 100) + "%";
    if (i >= segs.length) { stopAudio(); st.textContent = "Đã nghe xong · bấm ▶ để nghe lại"; bar.style.width = "100%"; return; }
    const s = segs[i];
    if (s.pause != null) { st.textContent = `Thời gian trả lời… ${s.pause}秒`; me.t = setTimeout(() => { acc += s.pause; step(i + 1); }, s.pause * 1000); return; }
    st.textContent = "Đang phát…";
    el.src = s.src; el.onended = () => { acc += 1; step(i + 1); };
    el.onerror = () => { st.textContent = "Lỗi tải audio"; stopAudio(); };
    el.play().catch(() => stopAudio());
    const nx = segs.slice(i + 1).find(x => x.src); if (nx) fetch(nx.src).catch(() => {});
  };
  step(0);
}

// ---------- Phím tắt (desktop) ----------
document.addEventListener("keydown", e => {
  if (!S || !EXAM || !(S.phase === "test" || S.phase === "review") || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($(".modal") || /input|textarea/i.test(e.target.tagName)) return;
  const p = PAGES[S.cur]; const vis = visiblePages(), vp = vis.indexOf(S.cur);
  if (/^[1-4]$/.test(e.key) && S.phase === "test" && +e.key <= nChoices(p.it)) choose(p, +e.key);
  else if (e.key === "ArrowRight") go(vis[vp + 1]);
  else if (e.key === "ArrowLeft") go(vis[vp - 1]);
  else if ((e.key === "f" || e.key === "F") && S.phase === "test") toggleFlag(p);
  else if (e.key === "Escape") closeSheet();
  else return;
  e.preventDefault();
});

window.addEventListener("hashchange", route);
// Tải dữ liệu ngay, nhưng chỉ vẽ trang khi mọi script (app.js + quest.js) đã chạy xong
const scriptsReady = new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
Promise.all([loadIndex(), scriptsReady, flushQueue()]).then(route).then(() => window.SPLASH && SPLASH.done()).catch(e => { console.error("init", e); window.SPLASH && SPLASH.done(); $("#app").innerHTML = '<div class="page"><p>Không tải được dữ liệu đề.</p></div>'; });
