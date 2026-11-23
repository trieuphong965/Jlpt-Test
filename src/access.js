// Xác thực JWT của Cloudflare Access (header Cf-Access-Jwt-Assertion).
// Lớp bảo vệ thứ 2: nếu Access bị gỡ/cấu hình sai, hoặc ai đó gọi qua URL không được Access bảo vệ,
// API vẫn từ chối.

let certCache = { at: 0, keys: [] };

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function certs(team) {
  if (Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

export async function verifyAccess(req, env) {
  // Chỉ dùng cho `wrangler dev` (đặt trong .dev.vars). KHÔNG đặt biến này trên production.
  if (env.DEV_NO_AUTH === "1") return { ok: true, email: "dev" };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, why: "Access chưa cấu hình (ACCESS_TEAM_DOMAIN / ACCESS_AUD)" };
  const jwt = req.headers.get("cf-access-jwt-assertion") ||
    (req.headers.get("cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
  if (!jwt) return { ok: false, why: "thiếu Access token" };
  const [h, p, s] = jwt.split(".");
  if (!s) return { ok: false, why: "token sai định dạng" };
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  } catch { return { ok: false, why: "token sai định dạng" }; }

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, why: "sai audience" };
  if (payload.exp * 1000 < Date.now()) return { ok: false, why: "token hết hạn" };
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return { ok: false, why: "sai issuer" };

  const jwk = (await certs(env.ACCESS_TEAM_DOMAIN)).find(k => k.kid === header.kid);
  if (!jwk) return { ok: false, why: "không tìm thấy khóa ký" };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? { ok: true, email: payload.email } : { ok: false, why: "chữ ký không hợp lệ" };
}
