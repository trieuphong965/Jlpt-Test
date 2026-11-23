// Trích "audio unit" từ đề: mỗi unit = 1 chuỗi đoạn (segment) phát liên tiếp.
//   mondai.script  → unit "m<index>"   (lời dẫn đầu 問題, dùng chung giữa các đề → hash trùng, chỉ sinh 1 lần)
//   group.script   → unit "g<q đầu>"   (bài nghe dùng chung cho nhiều câu, vd 統合理解 3番 質問1・2)
//   item.script    → unit "q<q>"
// Segment: {sp, text} hoặc {pause: giây}.

export function audioUnits(exam) {
  const units = [];
  exam.mondai.forEach((m, mi) => {
    if (m.section !== "聴解") return;
    if (m.script) units.push({ id: "m" + mi, segs: m.script });
    for (const g of m.groups) {
      if (g.script && g.items.length) units.push({ id: "g" + g.items[0].q, segs: g.script });
      for (const it of g.items) if (it.script) units.push({ id: "q" + it.q, segs: it.script });
    }
  });
  return units;
}

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function voices(env) {
  try { return JSON.parse(env.VOICES || "{}"); } catch { return {}; }
}

// Khóa nội dung: đổi model / voice / định dạng / câu chữ → file mới.
export async function segKey(env, voiceId, text) {
  return (await sha256hex(`${env.TTS_MODEL}|${voiceId}|${env.TTS_FORMAT}|${text}`)).slice(0, 40);
}

export const r2Key = k => `tts/${k}.mp3`;

export async function loadIndex(env, base) {
  const r = await env.ASSETS.fetch(new URL("/exams/index.json", base));
  return r.ok ? r.json() : [];
}

export async function loadExamRaw(env, base, meta) {
  const r = await env.ASSETS.fetch(new URL("/" + meta.file.replace(/^\//, ""), base));
  return r.ok ? r.text() : null;
}
