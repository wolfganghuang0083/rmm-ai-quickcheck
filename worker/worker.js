import TOOL_HTML from "../index.html";

/**
 * RMM AI 神秘客快篩 API（Cloudflare Worker）
 * POST /audit {url} → 靜態檢查（55 分）＋ AI 讀站評估（45 分）＝ 100 分
 * 計分 rubric v2（與前端顯示一致，改分數要同步前端說明）：
 *   靜態：robots+sitemap 10｜llms.txt 10｜服務四件套 15（title/meta 5＋預約 CTA 5＋報價線索 5）｜FAQ 10｜表單清楚 10
 *   AI 讀站：講得出賣什麼 15｜講得出適合誰 15｜找得到預約入口 15
 */

const ALLOW_ORIGINS = [
  "https://audit.runningmatemarketing.com",
  "https://wolfganghuang0083.github.io",
  "https://runningmatemarketing.com",
  "https://www.runningmatemarketing.com",
];

const cors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
});

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: cors(origin) });

function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  // SSRF 防護：擋 IP 直連、內網與本機名稱
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return null;
  if (/^\[/.test(h)) return null; // IPv6 literal
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
  u.hash = ""; u.search = "";
  return u;
}

async function fetchText(url, cap = 600000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RMM-AI-QuickCheck/1.0; +https://runningmatemarketing.com/agent-ready-website-audit/)" },
    });
    clearTimeout(t);
    const text = (await r.text()).slice(0, cap);
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "" };
  }
}

function extractVisibleText(html, cap = 6500) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, cap);
}

function staticChecks(home, robots, sitemapOk, llmsOk, origin) {
  const html = home.text || "";
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
  const metaDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html) ||
                   /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(html);
  const ldTypes = [...html.matchAll(/"@type"\s*:\s*("([A-Za-z]+)"|\[[^\]]{0,120}\])/g)]
    .flatMap((m) => m[2] ? [m[2]] : [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]));
  const hasFaq = /常見問題|FAQPage|rank-math-faq|class=["'][^"']*faq/i.test(html);
  const hasForm = /<form[\s>]/i.test(html);
  const inputCount = (html.match(/<(input|textarea|select)[\s>]/gi) || []).length;
  const hasPlaceholders = (html.match(/placeholder=/gi) || []).length >= 3 || (html.match(/<label[\s>]/gi) || []).length >= 3;
  const ctaHit = /(line\.me|lin\.ee|預約|諮詢|contact|聯絡|book)/i.test(html);
  const priceHit = /(NT\$|報價|價格|費用|方案|pricing|price)/i.test(html);
  const robotsOk = robots.ok && robots.text.trim().length > 0;
  const robotsBlockAll = /user-agent:\s*\*[\s\S]{0,40}disallow:\s*\/\s*$/im.test(robots.text || "");

  const items = [
    { key: "robots_sitemap", label: "robots.txt＋sitemap", max: 10,
      score: (robotsOk && !robotsBlockAll ? 5 : 0) + (sitemapOk ? 5 : 0),
      note: robotsBlockAll ? "robots.txt 疑似封鎖全部爬蟲" : (robotsOk ? (sitemapOk ? "都有" : "缺 sitemap") : "缺 robots.txt") },
    { key: "llms", label: "llms.txt（AI 導覽）", max: 10, score: llmsOk ? 10 : 0,
      note: llmsOk ? "有" : "沒有——多數網站都還沒有，補了就是領先" },
    { key: "service4", label: "服務四件套線索", max: 15,
      score: (title && metaDesc ? 5 : 0) + (ctaHit ? 5 : 0) + (priceHit ? 5 : 0),
      note: `title/描述 ${title && metaDesc ? "✓" : "✗"}・行動入口 ${ctaHit ? "✓" : "✗"}・報價線索 ${priceHit ? "✓" : "✗"}` },
    { key: "faq", label: "FAQ 區塊", max: 10, score: hasFaq ? 10 : 0, note: hasFaq ? "有" : "沒偵測到" },
    { key: "form", label: "表單清楚度", max: 10,
      score: (hasForm && inputCount >= 2 ? 5 : 0) + (hasForm && hasPlaceholders ? 5 : 0),
      note: hasForm ? `表單 ✓・欄位標示 ${hasPlaceholders ? "✓" : "✗"}` : "首頁沒偵測到表單（若在其他頁不計分，屬快篩限制）" },
  ];
  const schemaNote = ldTypes.length ? `結構化資料：${[...new Set(ldTypes)].slice(0, 6).join("/")}` : "沒有偵測到結構化資料";
  return { items, title: title.trim().slice(0, 120), schemaNote };
}

async function aiAssess(env, siteUrl, title, text) {
  const prompt = `你是一個幫消費者找廠商的 AI 助理。以下是網站 ${siteUrl} 首頁的文字內容（可能不完整）。
只根據這些內容回答，讀不出來就給低分，不要腦補。回傳嚴格 JSON（不要 markdown）：
{"sell_score":0-15 整數（我讀完能不能明確講出這家在賣什麼服務/產品）,
"fit_score":0-15 整數（能不能講出適合誰、跟同業差在哪）,
"action_score":0-15 整數（能不能告訴消費者下一步怎麼預約/購買/聯絡，入口越明確分越高）,
"brand_summary":"用一句話介紹這家（30 字內）",
"booking_path":"你會叫消費者怎麼聯絡（20 字內，讀不出來寫：找不到明確入口）",
"top_fixes":["最該補的 1","2","3"]}

網站標題：${title || "(無)"}
首頁內容：${text}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const d = await r.json();
  const out = JSON.parse(d.choices[0].message.content);
  const clamp = (v) => Math.max(0, Math.min(15, parseInt(v, 10) || 0));
  return {
    sell_score: clamp(out.sell_score),
    fit_score: clamp(out.fit_score),
    action_score: clamp(out.action_score),
    brand_summary: String(out.brand_summary || "").slice(0, 60),
    booking_path: String(out.booking_path || "").slice(0, 40),
    top_fixes: (Array.isArray(out.top_fixes) ? out.top_fixes : []).slice(0, 3).map((s) => String(s).slice(0, 60)),
  };
}

async function rateLimit(env, ip) {
  if (!env.RATELIMIT) return { allowed: true };
  const day = new Date().toISOString().slice(0, 10);
  const [ipCountRaw, dayCountRaw] = await Promise.all([
    env.RATELIMIT.get(`ip:${ip}:${day}`),
    env.RATELIMIT.get(`day:${day}`),
  ]);
  const ipCount = parseInt(ipCountRaw || "0", 10);
  const dayCount = parseInt(dayCountRaw || "0", 10);
  if (ipCount >= parseInt(env.PER_IP_CAP || "8", 10)) return { allowed: false, why: "今天測太多次了，明天再來（或直接找狼大做完整版）" };
  if (dayCount >= parseInt(env.DAILY_CAP || "200", 10)) return { allowed: false, why: "今日名額已滿，明天再來" };
  await Promise.all([
    env.RATELIMIT.put(`ip:${ip}:${day}`, String(ipCount + 1), { expirationTtl: 172800 }),
    env.RATELIMIT.put(`day:${day}`, String(dayCount + 1), { expirationTtl: 172800 }),
  ]);
  return { allowed: true };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET") {
      return new Response(TOOL_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405, origin);

    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const rl = await rateLimit(env, ip);
    if (!rl.allowed) return json({ error: rl.why }, 429, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, origin); }
    const u = normalizeUrl(body.url);
    if (!u) return json({ error: "請輸入有效的網站網址（例：yourbrand.com）" }, 400, origin);

    const base = `${u.protocol}//${u.hostname}`;
    const [home, robots, sitemap1, sitemap2, llms] = await Promise.all([
      fetchText(u.toString()),
      fetchText(`${base}/robots.txt`, 20000),
      fetchText(`${base}/sitemap.xml`, 2000),
      fetchText(`${base}/sitemap_index.xml`, 2000),
      fetchText(`${base}/llms.txt`, 2000),
    ]);
    if (!home.ok) return json({ error: `打不開這個網站（HTTP ${home.status || "逾時"}）——請確認網址正確且對外開放` }, 422, origin);

    const sitemapOk = sitemap1.ok || sitemap2.ok || /sitemap:/i.test(robots.text || "");
    const llmsOk = llms.ok && (llms.text || "").trim().length > 20 && !/<html/i.test(llms.text || "");
    const st = staticChecks(home, robots, sitemapOk, llmsOk, base);
    const staticScore = st.items.reduce((a, b) => a + b.score, 0);

    let ai = null, aiScore = 0, aiError = null;
    try {
      ai = await aiAssess(env, base, st.title, extractVisibleText(home.text));
      aiScore = ai.sell_score + ai.fit_score + ai.action_score;
    } catch (e) {
      aiError = "AI 評估暫時無法使用，以下為靜態檢查結果（滿分 55）";
    }

    const total = staticScore + aiScore;
    const outOf = ai ? 100 : 55;
    const pct = total / outOf;
    const grade = pct < 0.4 ? "red" : pct < 0.7 ? "yellow" : "green";
    return json({ url: base, total, outOf, grade, static: { score: staticScore, items: st.items, schemaNote: st.schemaNote }, ai, aiError }, 200, origin);
  },
};
