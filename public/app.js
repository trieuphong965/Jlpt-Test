"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Lưu trữ: D1 qua /api, localStorage làm cache/dự phòng ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let API_OK = true; // tắt khi /api không dùng được (preview tĩnh, mất mạng)
async function api(path, opt = {}) {
  if (!API_OK) return null;
  try {
    const r = await fetch("/api/" + path, {
      method: opt.method || "GET",
      headers: opt.body ? { "content-type": "application/json" } : {},
      body: opt.body ? JSON.stringify(opt.body) : undefined,
      credentials: "same-origin",
    });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) { if (r.status === 404 || r.status === 401 || r.status === 405) API_OK = false; return null; }
    return r.json();
  } catch { API_OK = false; return null; }
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const SEC_GROUP = { "文字・語彙": "moji", "文法": "bunpou", "読解": "dokkai", "聴解": "choukai" };
const SP_LABEL = { N: "", M: "男", F: "女", M2: "男2", F2: "女2" };
const FOOTER = `<footer>Voice by <a href="https://elevenlabs.io/text-to-speech" target="_blank" rel="noopener">ElevenLabs</a></footer>`;
let INDEX = [], EXAM = null, state = null, timerId = null, AUDIO = null, saveT = null;

async function loadIndex() { INDEX = await (await fetch("exams/index.json")).json(); }
async function loadExam(id) {
  const meta = INDEX.find(e => e.id === id); if (!meta) return null;
  return (await fetch(meta.file)).json();
}
const isL = m => m.section === "聴解";
const hasListening = ex => ex.mondai.some(isL);
function allItems(ex, part) {
  const out = [];
  ex.mondai.forEach((m, mi) => {
    if (part && (part === "L") !== isL(m)) return;
    m.groups.forEach(g => g.items.forEach(it => out.push({ ...it, mi, mondai: m.no, sec: SEC_GROUP[m.section] })));
  });
  return out;
}
const fmt = sec => { const s = Math.max(0, sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const nChoices = it => it.opts ? it.opts.length : (it.n || 4);

// ---------- Trang chủ ----------
async function renderHome() {
  clearInterval(timerId); stopAudio();
  const local = store.get("jlpt-history", {});
  const remote = await api("state");
  const last = {}, prog = new Set();
  if (remote) {
    remote.last.forEach(r => last[r.exam_id] = { correct: r.correct, total: r.total, at: r.finished_at });
    remote.progress.forEach(r => prog.add(r.exam_id));
  } else Object.assign(last, local);
  $("#app").innerHTML = `<div class="wrap">
    <h1>JLPT 模擬試験</h1>
    <p class="sub">Đề thi thử cá nhân · 言語知識・読解・聴解 <span class="sync">${remote ? "· đồng bộ D1" : "· lưu trên máy (offline)"}</span></p>
    <div class="cards">${INDEX.map(e => {
      const h = last[e.id]; const saved = store.get("jlpt-progress-" + e.id, null);
      const doing = prog.has(e.id) || (saved && !saved.done);
      return `<button class="card" data-id="${e.id}"><div class="lv">${e.level}</div><div>
        <div class="t">${esc(e.title)}${e.listening ? " · 聴解" : ""}</div>
        <div class="m">${h ? `Lần gần nhất: ${h.correct}/${h.total} câu · ${new Date(h.at).toLocaleDateString("vi-VN")}` : "Chưa làm"}${doing ? " · Đang làm dở" : ""}</div>
      </div></button>`;
    }).join("")}</div>
    ${FOOTER}
  </div>`;
  document.querySelectorAll(".card").forEach(b => b.onclick = () => { location.hash = b.dataset.id; });
}

// ---------- Mở đề ----------
const fresh = () => ({ id: uid(), answers: {}, left: EXAM.time * 60, done: false, filter: "all", part: "A", started_at: Date.now() });
async function openExam(id) {
  EXAM = await loadExam(id);
  if (!EXAM) { location.hash = ""; return; }
  const local = store.get("jlpt-progress-" + id, null);
  const remote = await api("attempt/" + id);
  if (remote && (!local || local.done || remote.updated_at > (local.saved_at || 0)))
    state = { ...fresh(), id: remote.id, answers: remote.answers, left: remote.left_sec ?? EXAM.time * 60, started_at: remote.started_at };
  else state = local && !local.done ? { ...fresh(), ...local } : fresh();
  EXAM._audio = hasListening(EXAM) ? await api("listening/" + id) : null;
  renderExam();
}
function persist(now) {
  state.saved_at = Date.now();
  store.set("jlpt-progress-" + EXAM.id, state);
  if (state.done) return;
  clearTimeout(saveT);
  const send = () => api("attempt/" + EXAM.id, { method: "PUT", body: { id: state.id, answers: state.answers, left: state.left, started_at: state.started_at } });
  if (now) send(); else saveT = setTimeout(send, 4000);
}

function renderExam() {
  clearInterval(timerId); stopAudio();
  const L = hasListening(EXAM), part = L ? state.part : "A";
  const items = allItems(EXAM, part);
  const done = state.done;
  const res = done ? score() : null;
  const head = `<div class="top"><div class="in">
      <button class="btn ghost" id="home">←</button>
      <div class="name">${esc(EXAM.title)}</div>
      ${done ? `<span class="pill">${res.correct}/${res.total}</span>`
             : `${part === "A" ? `<span class="pill" id="timer">${fmt(state.left)}</span>` : ""}<span class="pill" id="prog"></span><button class="btn pri" id="submit">Nộp bài</button>`}
    </div></div>`;
  const tabs = L ? `<div class="tabs"><button class="btn ${part === "A" ? "on" : ""}" data-p="A">言語知識・読解</button><button class="btn ${part === "L" ? "on" : ""}" data-p="L">聴解</button>${
    EXAM._audio ? `<span class="note" style="align-self:center">audio ${EXAM._audio.done}/${EXAM._audio.total} đoạn</span>` : ""}</div>` : "";
  const body = EXAM.mondai.map((m, mi) => {
    if (L && (part === "L") !== isL(m)) return "";
    const qsHtml = m.groups.map(g => {
      const p = g.passage ? `<div class="passage">${g.label ? `<p class="lbl">${g.label}</p>` : ""}${g.passage.includes("<table") ? `<div class="tblwrap">${g.passage}</div>` : g.passage}</div>` : "";
      const ga = g.script ? unitHtml("g" + g.items[0].q, g.script) : "";
      return p + ga + g.items.map(it => renderQ(it, m)).join("");
    }).join("");
    const ma = m.script ? unitHtml("m" + mi, m.script) : "";
    return `<section class="mondai" id="m${mi}"><div class="mh"><b>問題${m.no}</b><span class="sec">${m.section}</span></div><p class="instr">${m.instr}</p>${ma}${qsHtml}</section>`;
  }).join("");
  const nav = `<div class="nav"><div class="in">${EXAM.mondai.map((m, mi) => (L && (part === "L") !== isL(m)) ? "" : `<a href="#${EXAM.id}" data-m="${mi}">問題${m.no}</a>`).join("")}</div></div>`;
  $("#app").innerHTML = head + `<div class="wrap">${done ? renderResult(res) : ""}${tabs}${body}${FOOTER}</div>` + nav;

  $("#home").onclick = () => { location.hash = ""; };
  document.querySelectorAll(".tabs .btn").forEach(b => b.onclick = () => { state.part = b.dataset.p; persist(); renderExam(); scrollTo(0, 0); });
  document.querySelectorAll(".nav a").forEach(a => a.onclick = ev => { ev.preventDefault(); $("#m" + a.dataset.m).scrollIntoView({ behavior: "smooth", block: "start" }); });
  bindPlayers();
  if (!done) {
    document.querySelectorAll(".opt").forEach(b => b.onclick = () => {
      state.answers[b.dataset.q] = +b.dataset.v; persist();
      b.parentElement.querySelectorAll(".opt").forEach(o => o.classList.toggle("sel", o === b));
      updateProg();
    });
    $("#submit").onclick = confirmSubmit;
    updateProg();
    if (part === "A") timerId = setInterval(() => {
      state.left--; const t = $("#timer"); if (!t) return;
      t.textContent = fmt(state.left); t.classList.toggle("warn", state.left < 600);
      if (state.left % 15 === 0) persist();
      if (state.left <= 0) { clearInterval(timerId); finish(); }
    }, 1000);
  } else {
    document.querySelectorAll(".filter .btn[data-f]").forEach(b => b.onclick = () => { state.filter = b.dataset.f; renderExam(); });
    applyFilter();
  }
  function updateProg() {
    const n = items.filter(it => state.answers[it.q]).length; $("#prog").textContent = `${n}/${items.length}`;
    const byM = {}; items.forEach(it => { byM[it.mi] = byM[it.mi] || [0, 0]; byM[it.mi][1]++; if (state.answers[it.q]) byM[it.mi][0]++; });
    document.querySelectorAll(".nav a").forEach(a => { const c = byM[a.dataset.m]; a.classList.toggle("done", !!c && c[0] === c[1]); });
  }
}

// ---------- Audio ----------
function scriptHtml(segs) {
  return `<div class="script">${segs.map(s => s.pause != null ? `<span class="pz">（${s.pause}秒）</span><br>`
    : `<span class="sp">${SP_LABEL[s.sp] ?? s.sp}</span>${esc(s.text)}<br>`).join("")}</div>`;
}
function unitHtml(id, segs) {
  const a = EXAM._audio?.units?.[id];
  const ready = a && a.ready;
  return `<div class="unit" data-u="${id}"><div class="player ${ready ? "" : "na"}">
      ${ready ? `<button class="btn play">▶ Nghe</button><span class="st"></span>`
              : `<span class="st">${a ? `Chưa có audio (${a.segs.filter(s => s.src).length}/${a.segs.filter(s => !s.pause).length} đoạn)` : "Chưa có audio"}</span>`}
      <button class="btn ghost scr">${state.done || !ready ? "Ẩn/hiện script" : "Xem script"}</button>
    </div><div class="scrbox ${ready && !state.done ? "hide" : ""}">${scriptHtml(segs)}</div></div>`;
}
function bindPlayers() {
  document.querySelectorAll(".unit").forEach(u => {
    $(".scr", u).onclick = () => $(".scrbox", u).classList.toggle("hide");
    const pb = $(".play", u); if (!pb) return;
    pb.onclick = () => (AUDIO && AUDIO.u === u) ? stopAudio() : playUnit(u);
  });
}
function stopAudio() {
  if (!AUDIO) return;
  AUDIO.stop = true; clearTimeout(AUDIO.t); AUDIO.el.pause();
  const pb = $(".play", AUDIO.u); if (pb) pb.textContent = "▶ Nghe";
  const st = $(".st", AUDIO.u); if (st) st.textContent = "";
  AUDIO = null;
}
function playUnit(u) {
  stopAudio();
  const segs = EXAM._audio.units[u.dataset.u].segs;
  const el = AUDIO?.el || new Audio(); el.preload = "auto";
  const me = AUDIO = { u, el, stop: false, t: 0 };
  $(".play", u).textContent = "■ Dừng";
  const st = $(".st", u);
  const nAudio = segs.filter(s => s.src).length; let k = 0;
  const step = i => {
    if (me.stop) return;
    if (i >= segs.length) { stopAudio(); st.textContent = "✓ hết"; return; }
    const s = segs[i];
    if (s.pause != null) { st.textContent = `（${s.pause}秒）`; me.t = setTimeout(() => step(i + 1), s.pause * 1000); return; }
    k++; st.textContent = `${k}/${nAudio}`;
    el.src = s.src; el.onended = () => step(i + 1);
    el.onerror = () => { st.textContent = "lỗi tải audio"; stopAudio(); };
    el.play().catch(() => stopAudio());
    // tải trước đoạn kế tiếp
    const nx = segs.slice(i + 1).find(x => x.src); if (nx) fetch(nx.src).catch(() => {});
  };
  step(0);
}

// ---------- Câu hỏi ----------
function renderQ(it, m) {
  const a = state.answers[it.q], done = state.done, L = isL(m);
  const isOk = a === it.ans;
  const labels = it.opts || Array.from({ length: nChoices(it) }, () => "");
  const short = (it.opts ? it.opts.every(o => o.length <= 8) : true) && !/^（\d+）$/.test(it.stem || "") ? " grid4" : "";
  const opts = labels.map((o, i) => {
    const v = i + 1; let cls = "opt";
    if (!done && a === v) cls += " sel";
    if (done && v === it.ans) cls += " correct";
    if (done && a === v && !isOk) cls += " wrong";
    return `<button class="${cls}" data-q="${it.q}" data-v="${v}" ${done ? "disabled" : ""}><span class="n">${v}</span><span>${o}</span></button>`;
  }).join("");
  const exp = done ? `<div class="exp">${a ? (isOk ? "✓ Đúng" : `✗ Bạn chọn ${a}`) : "— Bỏ trống"} · Đáp án <b>${it.ans}</b><br>${it.exp || ""}</div>` : "";
  const au = it.script ? unitHtml("q" + it.q, it.script) : "";
  return `<div class="q ${L ? "lq " : ""}${done ? (isOk ? "isok" : "isng") : ""}" data-q="${it.q}"><div class="qs"><span class="qn">${it.no || it.q}</span><div class="stem">${it.stem || ""}</div></div>${au}<div class="opts${m.section !== "読解" ? short : ""}">${opts}</div>${exp}</div>`;
}

// ---------- Chấm điểm ----------
function score() {
  const s = { moji: [0, 0], bunpou: [0, 0], dokkai: [0, 0], choukai: [0, 0] };
  let correct = 0; const items = allItems(EXAM);
  items.forEach(it => { s[it.sec][1]++; if (state.answers[it.q] === it.ans) { s[it.sec][0]++; correct++; } });
  return { s, correct, total: items.length };
}
function renderResult(r) {
  const s = r.s, sc = (c, t) => t ? Math.round(c / t * 60) : null;
  const gengo = sc(s.moji[0] + s.bunpou[0], s.moji[1] + s.bunpou[1]), dokkai = sc(...s.dokkai), chou = sc(...s.choukai);
  const row = (lbl, c, t) => t ? `<div class="row"><span>${lbl}</span><div class="bar"><i style="width:${c / t * 100}%"></i></div><span>${c}/${t}</span></div>` : "";
  const N1 = EXAM.level === "N1", pass = N1 ? 100 : 90;
  const tot = chou != null ? gengo + dokkai + chou : null;
  return `<div class="result">
    <div class="note">Kết quả</div>
    <div class="big">${r.correct}<span style="font-size:1.1rem;color:var(--muted)"> / ${r.total}</span></div>
    <div class="rows">${row("文字・語彙", ...s.moji)}${row("文法", ...s.bunpou)}${row("読解", ...s.dokkai)}${row("聴解", ...s.choukai)}</div>
    <p class="note" style="margin-top:14px">Điểm quy đổi ước tính: 言語知識 <b>${gengo}</b>/60 · 読解 <b>${dokkai}</b>/60${chou != null ? ` · 聴解 <b>${chou}</b>/60 · Tổng <b>${tot}</b>/180 (đỗ ≥ ${pass})` : ""} (基準点 mỗi phần: 19). Thang JLPT thật dùng phương pháp cân bằng nên chỉ mang tính tham khảo.</p>
    <div class="filter"><button class="btn ${state.filter === "all" ? "on" : ""}" data-f="all">Tất cả</button><button class="btn ${state.filter === "ng" ? "on" : ""}" data-f="ng">Chỉ câu sai</button><button class="btn" id="retry">Làm lại</button></div>
  </div>`;
}
function applyFilter() {
  const ng = state.filter === "ng";
  document.querySelectorAll(".q").forEach(q => q.classList.toggle("hide", ng && q.classList.contains("isok")));
  document.querySelectorAll(".passage").forEach(p => {
    let n = p.nextElementSibling, any = false;
    while (n && (n.classList.contains("q") || n.classList.contains("unit"))) { if (n.classList.contains("q") && !n.classList.contains("hide")) any = true; n = n.nextElementSibling; }
    p.classList.toggle("hide", ng && !any);
  });
  document.querySelectorAll(".mondai").forEach(m => m.classList.toggle("hide", ng && !m.querySelector(".q:not(.hide)")));
  const r = $("#retry"); if (r) r.onclick = async () => {
    await api("attempt/" + EXAM.id, { method: "DELETE" });
    state = fresh(); persist(true); renderExam(); scrollTo(0, 0);
  };
}
function confirmSubmit() {
  const n = Object.keys(state.answers).length, t = allItems(EXAM).length;
  const d = document.createElement("div"); d.className = "modal";
  d.innerHTML = `<div class="box2"><b>Nộp bài?</b><p class="note">Đã làm ${n}/${t} câu${n < t ? `, còn ${t - n} câu bỏ trống` : ""}${hasListening(EXAM) ? " (tính cả 聴解)" : ""}.</p><div class="acts"><button class="btn" id="no">Làm tiếp</button><button class="btn pri" id="yes">Nộp</button></div></div>`;
  document.body.appendChild(d);
  $("#no", d).onclick = () => d.remove();
  $("#yes", d).onclick = () => { d.remove(); finish(); };
}
async function finish() {
  clearInterval(timerId); clearTimeout(saveT);
  state.done = true; persist();
  const r = score();
  const h = store.get("jlpt-history", {}); h[EXAM.id] = { correct: r.correct, total: r.total, at: Date.now() }; store.set("jlpt-history", h);
  api(`attempt/${EXAM.id}/finish`, { method: "POST", body: { id: state.id, answers: state.answers, left: state.left, score: r.s, correct: r.correct, total: r.total, started_at: state.started_at } });
  renderExam(); scrollTo(0, 0);
}

async function route() {
  const id = location.hash.slice(1);
  if (id && INDEX.some(e => e.id === id)) await openExam(id); else await renderHome();
  scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
loadIndex().then(route).catch(() => { $("#app").innerHTML = '<div class="wrap"><p>Không tải được dữ liệu đề.</p></div>'; });
