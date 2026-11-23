import { audioUnits, sha256hex, voices, segKey, r2Key, loadIndex, loadExamRaw } from "./exam.js";

const apiBase = env => env.ELEVENLABS_BASE || "https://api.elevenlabs.io"; // ghi đè chỉ để test với mock
// Worker không có URL gốc khi chạy cron → dùng host giả để gọi ASSETS.
const ASSET_BASE = "https://assets.local/";

// ---------- Đồng bộ đề → hàng đợi ----------
export async function syncQueue(env) {
  const vmap = voices(env);
  const index = await loadIndex(env, ASSET_BASE);
  let added = 0;
  for (let ei = 0; ei < index.length; ei++) {
    const meta = index[ei];
    const raw = await loadExamRaw(env, ASSET_BASE, meta);
    if (!raw) continue;
    const hash = await sha256hex(raw + env.VOICES + env.TTS_MODEL + env.TTS_FORMAT);
    const prev = await env.DB.prepare("SELECT hash FROM exam_sync WHERE exam_id=?").bind(meta.id).first();
    if (prev && prev.hash === hash) continue;

    const units = audioUnits(JSON.parse(raw));
    const now = Date.now(), stmts = [];
    for (let ui = 0; ui < units.length; ui++) {
      const segs = units[ui].segs;
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        if (!s.text) continue;
        const vid = vmap[s.sp];
        if (!vid) throw new Error(`VOICES thiếu voice cho speaker "${s.sp}" (${meta.id})`);
        const key = await segKey(env, vid, s.text);
        stmts.push(env.DB.prepare(
          "INSERT OR IGNORE INTO tts_job(key,sp,voice_id,text,chars,prio,created_at) VALUES(?,?,?,?,?,?,?)"
        ).bind(key, s.sp, vid, s.text, [...s.text].length, ei * 1_000_000 + ui * 100 + si, now));
      }
    }
    for (let i = 0; i < stmts.length; i += 50) {
      const res = await env.DB.batch(stmts.slice(i, i + 50));
      added += res.reduce((a, r) => a + (r.meta?.changes || 0), 0);
    }
    await env.DB.prepare("INSERT OR REPLACE INTO exam_sync(exam_id,hash,synced_at) VALUES(?,?,?)").bind(meta.id, hash, now).run();
  }
  return added;
}

// ---------- ElevenLabs ----------
export async function getSubscription(env) {
  const r = await fetch(`${apiBase(env)}/v1/user/subscription`, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
  if (!r.ok) throw new Error(`subscription HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return {
    tier: j.tier,
    used: j.character_count,
    limit: j.character_limit,
    remaining: j.character_limit - j.character_count,
    reset_at: j.next_character_count_reset_unix ? j.next_character_count_reset_unix * 1000 : null,
  };
}

async function tts(env, job) {
  const url = `${apiBase(env)}/v1/text-to-speech/${job.voice_id}?output_format=${env.TTS_FORMAT}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: job.text,
      model_id: env.TTS_MODEL,
      language_code: "ja",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    }),
  });
  if (r.ok) return { ok: true, body: await r.arrayBuffer() };
  const txt = await r.text();
  let status = "";
  try { status = JSON.parse(txt)?.detail?.status || ""; } catch {}
  // Lỗi do tài khoản/credit/rate → dừng cả lượt, không tính là lỗi của job.
  const fatal = r.status === 401 || r.status === 429 || /quota|limit|unusual_activity|payment/i.test(status);
  return { ok: false, fatal, msg: `HTTP ${r.status} ${status} ${txt.slice(0, 200)}` };
}

// ---------- Một lượt chạy ----------
export async function runTTS(env, { maxJobs } = {}) {
  const log = { at: Date.now(), jobs_done: 0, credits: 0, remaining: null, reset_at: null, note: "" };
  const finish = async note => {
    log.note = note;
    await env.DB.prepare("INSERT INTO tts_run(at,remaining,reset_at,jobs_done,credits,note) VALUES(?,?,?,?,?,?)")
      .bind(log.at, log.remaining, log.reset_at, log.jobs_done, log.credits, note).run();
    return log;
  };

  if (!env.ELEVENLABS_API_KEY) return finish("thiếu secret ELEVENLABS_API_KEY");
  const vmap = voices(env);
  if (!Object.values(vmap).some(Boolean)) return finish("chưa cấu hình VOICES");

  // Khóa 10 phút
  const now = Date.now();
  const lk = await env.DB.prepare(
    "INSERT INTO lock(name,until) VALUES('tts',?) ON CONFLICT(name) DO UPDATE SET until=excluded.until WHERE lock.until < ?"
  ).bind(now + 600_000, now).run();
  if (!lk.meta.changes) return { ...log, note: "đang có lượt khác chạy" };

  try {
    try { await syncQueue(env); } catch (e) { return await finish("sync lỗi: " + e.message); }

    const rate = parseFloat(env.CREDIT_PER_CHAR || "0.5");
    const reserve = parseInt(env.CREDIT_RESERVE || "200");
    const limit = maxJobs || parseInt(env.MAX_JOBS_PER_RUN || "15");

    const { results: jobs } = await env.DB.prepare(
      "SELECT key,sp,voice_id,text,chars,attempts FROM tts_job WHERE status='pending' ORDER BY prio LIMIT ?"
    ).bind(limit).all();
    if (!jobs.length) return await finish("hàng đợi trống");

    const sub = await getSubscription(env);
    log.remaining = sub.remaining; log.reset_at = sub.reset_at;
    let remaining = sub.remaining;

    for (const job of jobs) {
      const cost = Math.ceil(job.chars * rate);
      if (remaining - cost < reserve) return await finish(`hết credit (còn ${remaining}, cần ${cost}+${reserve})`);
      const res = await tts(env, job);
      if (res.ok) {
        await env.AUDIO.put(r2Key(job.key), res.body, {
          httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
          customMetadata: { sp: job.sp, chars: String(job.chars) },
        });
        await env.DB.prepare("UPDATE tts_job SET status='done', bytes=?, done_at=?, error=NULL WHERE key=?")
          .bind(res.body.byteLength, Date.now(), job.key).run();
        remaining -= cost; log.jobs_done++; log.credits += cost;
      } else if (res.fatal) {
        return await finish("dừng: " + res.msg);
      } else {
        const a = job.attempts + 1;
        await env.DB.prepare("UPDATE tts_job SET attempts=?, error=?, status=? WHERE key=?")
          .bind(a, res.msg, a >= 3 ? "error" : "pending", job.key).run();
      }
    }
    return await finish("ok");
  } catch (e) {
    return await finish("lỗi: " + e.message);
  } finally {
    await env.DB.prepare("UPDATE lock SET until=0 WHERE name='tts'").run();
  }
}

export async function ttsStatus(env, live) {
  const { results: counts } = await env.DB.prepare(
    "SELECT status, COUNT(*) n, SUM(chars) chars FROM tts_job GROUP BY status"
  ).all();
  const { results: runs } = await env.DB.prepare("SELECT * FROM tts_run ORDER BY id DESC LIMIT 10").all();
  const { results: errors } = await env.DB.prepare(
    "SELECT key,sp,text,attempts,error FROM tts_job WHERE error IS NOT NULL ORDER BY prio LIMIT 10"
  ).all();
  const rate = parseFloat(env.CREDIT_PER_CHAR || "0.5");
  const pending = counts.find(c => c.status === "pending");
  let sub = null;
  if (live && env.ELEVENLABS_API_KEY) { try { sub = await getSubscription(env); } catch (e) { sub = { error: e.message }; } }
  return { counts, pending_credits: pending ? Math.ceil(pending.chars * rate) : 0, subscription: sub, runs, errors };
}
