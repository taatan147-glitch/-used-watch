// セカスト取得用Worker。認証付き /fetch と、手動のRRL診断。定期実行・通知はGitHub側で行います。
const SEARCH_URL = "https://www.2ndstreet.jp/search?keyword=RRL&sortBy=arrival";
const VERIFY_URL = "https://www.2ndstreet.jp/_sec/verify?provider=interstitial";
const MAX_BYTES = 3 * 1024 * 1024;
const SOURCE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0";
let reportPromise;

export function parseChallenge(html) {
  const i = html.match(/\bvar\s+i\s*=\s*(\d{1,16})\s*;/);
  const j = html.match(/\bvar\s+j\s*=\s*i\s*\+\s*Number\(\s*"(\d{1,12})"\s*\+\s*"(\d{1,12})"\s*\)\s*;/);
  const token = html.match(/\{\s*"bm-verify"\s*:\s*("(?:[^"\\]|\\.){1,8192}")\s*,\s*"pow"\s*:\s*j\s*\}/);
  if (!i || !j || !token) return null;
  const pow = BigInt(i[1]) + BigInt(j[1] + j[2]);
  if (pow > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  try { return { "bm-verify": JSON.parse(token[1]), pow: Number(pow) }; }
  catch { return null; }
}

export function inspect(html, status) {
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const title = (clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "").replace(/<[^>]*>/g, "").trim().slice(0, 150);
  const ids = new Set();
  for (const m of clean.matchAll(/<li\b[^>]*\bgoodsid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) ids.add(m[1] || m[2] || m[3]);
  let links = 0;
  for (const m of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    try {
      const url = new URL(m[1] || m[2], SEARCH_URL);
      if (url.origin === "https://www.2ndstreet.jp" && url.pathname.startsWith("/goods/detail/")) links++;
    } catch {}
  }
  const classification = status === 403 || /^access denied\b/i.test(title) ? "access_denied"
    : status !== 200 ? "http_error"
      : ids.size && links ? "product_html_received"
        : /bm-verify|akamai-interstitialchallenge|\/_sec\/verify/.test(html) ? "verification_page" : "product_html_not_confirmed";
  return { classification, httpStatus: status, cardCount: ids.size, productLinkCount: links, title };
}

export async function diagnose(userAgent, fetchImpl = fetch, keyword = "RRL", receiveHtml) {
  const searchUrl = new URL(SEARCH_URL);
  searchUrl.searchParams.set("keyword", keyword);
  const report = { testVersion: "cloudflare-fetch-v2", classification: "network_error", stages: [] };
  const jar = new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const ua = userAgent && /^[\x20-\x7e]{1,512}$/.test(userAgent) ? userAgent : "CHASE-Monitor-Diagnostic/2.0";
  async function request(url, payload) {
    const headers = { Accept: payload ? "application/json" : "text/html,application/xhtml+xml", "Accept-Language": "ja", "User-Agent": ua };
    const cookies = [...jar.values()].filter((c) => new URL(url).pathname.startsWith(c.path)).map((c) => c.pair);
    if (cookies.length) headers.Cookie = cookies.join("; ");
    if (payload) Object.assign(headers, { "Content-Type": "application/json", Origin: "https://www.2ndstreet.jp", Referer: searchUrl.href });
    const response = await fetchImpl(url, { method: payload ? "POST" : "GET", headers,
      body: payload ? JSON.stringify(payload) : undefined, redirect: "manual", signal: controller.signal });
    const receivedCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.getAll("Set-Cookie");
    for (const line of receivedCookies) {
      const pair = line.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const domain = line.match(/;\s*domain=([^;]+)/i)?.[1]?.trim().replace(/^\./, "").toLowerCase();
      if (domain && domain !== "2ndstreet.jp" && domain !== "www.2ndstreet.jp") continue;
      const path = line.match(/;\s*path=([^;]+)/i)?.[1]?.trim() || new URL(url).pathname.replace(/\/[^/]*$/, "/");
      const key = pair.slice(0, separator) + "|" + path;
      const expires = line.match(/;\s*expires=([^;]+)/i)?.[1];
      const maxAge = line.match(/;\s*max-age=(-?\d+)/i)?.[1];
      if ((maxAge !== undefined && Number(maxAge) <= 0) || (maxAge === undefined && expires && Date.parse(expires) <= Date.now())) jar.delete(key);
      else jar.set(key, { pair, path });
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let html = "", bytes = 0;
    try {
      if (reader) while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("response_too_large");
        html += decoder.decode(part.value, { stream: true });
      }
      html += decoder.decode();
    } finally { if (reader) await reader.cancel().catch(() => {}); }
    report.stages.push({ step: payload ? "verification" : "search", httpStatus: response.status, receivedBytes: bytes });
    return { html, status: response.status };
  }
  try {
    let response = await request(searchUrl.href);
    Object.assign(report, inspect(response.html, response.status));
    if (report.classification === "verification_page") {
      const payload = parseChallenge(response.html);
      report.verificationFormatSupported = !!payload;
      if (payload) {
        const verification = await request(VERIFY_URL, payload);
        if (verification.status >= 200 && verification.status < 300) {
          response = await request(searchUrl.href);
          Object.assign(report, inspect(response.html, response.status));
        } else report.classification = "verification_rejected";
      }
    }
    if (receiveHtml && report.httpStatus === 200 &&
        ["product_html_received", "product_html_not_confirmed"].includes(report.classification)) {
      receiveHtml(response.html);
    }
  } catch (error) {
    report.classification = controller.signal.aborted ? "network_timeout" : error.message === "response_too_large" ? error.message : "network_error";
  } finally {
    clearTimeout(timer);
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Bridge-Colo": request.cf?.colo || "unknown" };
    if (request.method === "POST" && url.pathname === "/fetch") {
      if (typeof env.WATCH_TOKEN !== "string" || env.WATCH_TOKEN.length < 16) {
        return Response.json({ error: "bridge_not_configured" }, { status: 503, headers });
      }
      if (request.headers.get("Authorization") !== "Bearer " + env.WATCH_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers });
      }
      let keyword;
      try {
        const input = await request.json();
        if (typeof input.keyword !== "string") throw new Error();
        keyword = input.keyword.trim();
        if (!keyword || keyword.length > 200 || /[\u0000-\u001f]/.test(keyword)) throw new Error();
      } catch {
        return Response.json({ error: "invalid_keyword" }, { status: 400, headers });
      }
      let html;
      const report = await diagnose(env.SOURCE_USER_AGENT || SOURCE_UA, fetch, keyword, (value) => { html = value; });
      if (html === undefined) {
        return Response.json({ error: report.classification, sourceStatus: report.httpStatus }, { status: 502, headers });
      }
      return new Response(html, { headers: {
        ...headers, "Content-Type": "text/html; charset=utf-8",
        "X-Bridge-Classification": report.classification,
      } });
    }
    if (request.method === "GET" && url.pathname === "/") return new Response(
      '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>セカスト取得Worker</title><h1>セカスト取得Worker</h1><p>RRLだけを確認します。通知・定期監視は開始しません。</p><form method="post" action="/run"><button>RRLを1回確認</button></form></html>',
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'" } });
    if (request.method !== "POST" || url.pathname !== "/run") return new Response("Not found", { status: 404, headers });
    if (request.headers.get("Origin") !== url.origin) return new Response("診断ページのボタンから実行してください。", { status: 403, headers });
    reportPromise ||= diagnose(request.headers.get("User-Agent"));
    return Response.json({
      ...(await reportPromise),
      workerColo: request.cf?.colo || "unknown",
      placement: request.headers.get("cf-placement") || "default",
    }, { headers });
  },
};
