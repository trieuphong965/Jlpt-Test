import { verifyAccess } from "./access.js";
import { runTTS, ttsStatus } from "./tts.js";
import { audioUnits, voices, segKey, r2Key, loadIndex, loadExamRaw } from "./exam.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const auth = await verifyAccess(req, env);
    if (!auth.ok) return json({ error: "unauthorized", why: auth.why }, 401);
    try {
      if (url.pathname.startsWith("/audio/")) return audio(req, env, url.pathname.slice(7));
      return await api(req, env, url);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(runTTS(env).then(r => console.log("tts", JSON.stringify(r))));
  },
};

// ---------- R2 audio (có Range: Safari/iOS bắt buộc) ----------
async function audio(req, env, key) {
  if (!/^tts\/[0-9a-f]{40}\.mp3$/.test(key)) return new Response("not found", { status: 404 });
  const m = (req.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/);
  let range;
  if (m && (m[1] || m[2])) {
    const head = await env.AUDIO.head(key);
    if (!head) return new Response("not found", { status: 404 });
    let a = m[1] === "" ? Math.max(0, head.size - +m[2]) : +m[1];
    let b = m[1] === "" || m[2] === "" ? head.size - 1 : Math.min(+m[2], head.size - 1);
    if (a > b || a >= head.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    range = { offset: a, length: b - a + 1, size: head.size };
  }
  const obj = await env.AUDIO.get(key, range ? { range: { offset: range.offset, length: range.length } } : { onlyIf: req.headers });
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  if (!("body" in obj)) return new Response(null, { status: 304, headers: h });
  if (range) {
    h.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${range.size}`);
    h.set("content-length", String(range.length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
}

// ---------- API ----------
async function api(req, env, url) {
  const p = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const m = req.method;
  const DB = env.DB;

  // Danh sách audio của 1 đề: {units: {id: {ready, segs:[{src}|{pause}]}}, done, total}
  if (p[1] === "listening" && p[2] && m === "GET") {
    const meta = (await loadIndex(env, url)).find(e => e.id === p[2]);
    if (!meta) return json({ error: "no exam" }, 404);
    const exam = JSON.parse(await loadExamRaw(env, url, meta));
    const vmap = voices(env);
    const { results } = await DB.prepare("SELECT key FROM tts_job WHERE status='done'").all();
    const done = new Set(results.map(r => r.key));
    const units = {}; let nDone = 0, nTotal = 0;
    for (const u of audioUnits(exam)) {
      let ready = true; const segs = [];
      for (const s of u.segs) {
        if (s.pause != null) { segs.push({ pause: s.pause }); continue; }
        nTotal++;
        const vid = vmap[s.sp];
        const k = vid ? await segKey(env, vid, s.text) : null;
        if (k && done.has(k)) { nDone++; segs.push({ src: "/audio/" + r2Key(k) }); }
        else { ready = false; segs.push({ missing: true }); }
      }
      units[u.id] = { ready, segs };
    }
    return json({ units, done: nDone, total: nTotal });
  }

  // TTS
  if (p[1] === "tts" && p[2] === "status" && m === "GET") return json(await ttsStatus(env, url.searchParams.has("live")));
  if (p[1] === "tts" && p[2] === "run" && m === "POST") {
    const n = parseInt(url.searchParams.get("n") || "0") || undefined;
    return json(await runTTS(env, { maxJobs: n }));
  }

  // Tổng quan cho trang chủ: lần làm gần nhất + đề đang làm dở
  if (p[1] === "state" && m === "GET") {
    const { results: last } = await DB.prepare(
      `SELECT exam_id, correct, total, score, finished_at FROM attempt a
       WHERE status='done' AND finished_at = (SELECT MAX(finished_at) FROM attempt b WHERE b.exam_id=a.exam_id AND b.status='done')`
    ).all();
    const { results: prog } = await DB.prepare("SELECT exam_id, updated_at FROM attempt WHERE status='progress'").all();
    return json({ last, progress: prog });
  }

  // Bài làm dở
  if (p[1] === "attempt" && p[2]) {
    const exam = p[2];
    if (m === "GET" && !p[3]) {
      const row = await DB.prepare("SELECT * FROM attempt WHERE exam_id=? AND status='progress'").bind(exam).first();
      return json(row ? { ...row, answers: JSON.parse(row.answers) } : null);
    }
    if (m === "PUT" && !p[3]) {
      const b = await req.json(); const now = Date.now();
      await DB.prepare(
        `INSERT INTO attempt(id,exam_id,status,answers,left_sec,started_at,updated_at) VALUES(?,?,'progress',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET answers=excluded.answers, left_sec=excluded.left_sec, updated_at=excluded.updated_at
         WHERE attempt.status='progress'`
      ).bind(b.id, exam, JSON.stringify(b.answers || {}), b.left ?? null, b.started_at || now, now).run();
      return json({ ok: true });
    }
    if (m === "POST" && p[3] === "finish") {
      const b = await req.json(); const now = Date.now();
      await DB.prepare(
        `INSERT INTO attempt(id,exam_id,status,answers,left_sec,score,correct,total,started_at,updated_at,finished_at)
         VALUES(?,?,'done',?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status='done', answers=excluded.answers, left_sec=excluded.left_sec, score=excluded.score,
           correct=excluded.correct, total=excluded.total, updated_at=excluded.updated_at, finished_at=excluded.finished_at`
      ).bind(b.id, exam, JSON.stringify(b.answers || {}), b.left ?? null, JSON.stringify(b.score), b.correct, b.total,
        b.started_at || now, now, now).run();
      return json({ ok: true });
    }
    if (m === "DELETE" && !p[3]) {
      await DB.prepare("DELETE FROM attempt WHERE exam_id=? AND status='progress'").bind(exam).run();
      return json({ ok: true });
    }
  }

  // ---------- Quest ôn tập ----------
  // POST /api/quest/attempt  {id, level, quest_id, started_at, answers:[{item_id, correct, ms, at}]}
  if (p[1] === "quest" && p[2] === "attempt" && m === "POST") {
    const b = await req.json();
    if (!b.id || !b.level || !Array.isArray(b.answers) || !b.answers.length) return json({ error: "bad request" }, 400);
    const now = Date.now();
    const correct = b.answers.filter(a => a.correct).length;
    const stmts = [DB.prepare(
      "INSERT OR REPLACE INTO quest_attempt(id,level,quest_id,correct,total,started_at,finished_at) VALUES(?,?,?,?,?,?,?)"
    ).bind(b.id, b.level, b.quest_id, correct, b.answers.length, b.started_at || now, now)];
    for (const a of b.answers.slice(0, 200)) stmts.push(DB.prepare(
      "INSERT OR REPLACE INTO quest_answer(attempt_id,item_id,level,correct,ms,at) VALUES(?,?,?,?,?,?)"
    ).bind(b.id, String(a.item_id), b.level, a.correct ? 1 : 0, a.ms ?? null, a.at || now));
    await DB.batch(stmts);
    return json({ ok: true });
  }
  // GET /api/quest/log?level=N2 → toàn bộ nhật ký (nhỏ, dùng cho thống kê phía client)
  if (p[1] === "quest" && p[2] === "log" && m === "GET") {
    const lv = url.searchParams.get("level") || "N2";
    const { results: attempts } = await DB.prepare(
      "SELECT id, quest_id, correct, total, started_at, finished_at FROM quest_attempt WHERE level=? ORDER BY finished_at").bind(lv).all();
    const { results: answers } = await DB.prepare(
      "SELECT attempt_id, item_id, correct, ms, at FROM quest_answer WHERE level=? ORDER BY at").bind(lv).all();
    return json({ attempts, answers: answers.map(a => [a.attempt_id, a.item_id, a.correct, a.ms, a.at]) });
  }

  // ---------- SRS (ôn tập hằng ngày) ----------
  if (p[1] === "srs" && m === "GET") {
    const lv = url.searchParams.get("level") || "N2";
    const { results } = await DB.prepare(
      "SELECT card_id, state, due, ivl, ease, reps, lapses, added, updated_at FROM srs WHERE level=?").bind(lv).all();
    return json(results);
  }
  if (p[1] === "srs" && m === "POST") {
    const b = await req.json();
    if (!b.level || !Array.isArray(b.cards)) return json({ error: "bad request" }, 400);
    const stmts = b.cards.slice(0, 200).map(c => DB.prepare(
      `INSERT INTO srs(level,card_id,state,due,ivl,ease,reps,lapses,added,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(level,card_id) DO UPDATE SET state=excluded.state, due=excluded.due, ivl=excluded.ivl, ease=excluded.ease,
         reps=excluded.reps, lapses=excluded.lapses, updated_at=excluded.updated_at
       WHERE excluded.updated_at >= srs.updated_at`
    ).bind(b.level, String(c.id), c.state, c.due, c.ivl, c.ease, c.reps, c.lapses, c.added, c.updated_at || Date.now()));
    if (stmts.length) await DB.batch(stmts);
    return json({ ok: true });
  }

  // Lịch sử 1 đề
  if (p[1] === "history" && p[2] && m === "GET") {
    const { results } = await DB.prepare(
      "SELECT id, correct, total, score, started_at, finished_at FROM attempt WHERE exam_id=? AND status='done' ORDER BY finished_at DESC LIMIT 50"
    ).bind(p[2]).all();
    return json(results.map(r => ({ ...r, score: r.score ? JSON.parse(r.score) : null })));
  }

  return json({ error: "not found" }, 404);
}
