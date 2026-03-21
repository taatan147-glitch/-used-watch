/**
 * watch.js — GitHub Actions 上で動く監視スクリプト
 * Node.js 18以上で動作（fetch built-in）
 *
 * GitHub Secrets に登録する環境変数:
 *   DISCORD_WEBHOOK_URL  — Discord の Webhook URL
 *   WATCH_RULES          — 監視ルールのJSON文字列（下記参照）
 *
 * WATCH_RULES の例:
 * [
 *   {"keyword":"ansnam","site":"mercari"},
 *   {"keyword":"ansnam","site":"2ndstreet"},
 *   {"keyword":"ansnam","site":"trefac"},
 *   {"keyword":"Andrea Ya'aqov","site":"mercari"},
 *   {"keyword":"Andrea Ya'aqov","site":"2ndstreet"},
 *   {"keyword":"Andrea Ya'aqov","site":"trefac"},
 *   {"keyword":"Andrea Incontri","site":"mercari"},
 *   {"keyword":"Andrea Incontri","site":"2ndstreet"},
 *   {"keyword":"Andrea Incontri","site":"trefac"}
 * ]
 *
 * サイトを追加したい場合は下部の「サイト追加ガイド」を参照
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// ============================================================
// 既読管理（seen.json → Actionsのキャッシュで永続化）
// ============================================================
const SEEN_FILE = "seen.json";

function loadSeen() {
  if (!existsSync(SEEN_FILE)) return {};
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); }
  catch { return {}; }
}

function saveSeen(seen) {
  writeFileSync(SEEN_FILE, JSON.stringify(seen), "utf8");
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL が未設定です");

  const rulesRaw = process.env.WATCH_RULES;
  if (!rulesRaw) throw new Error("WATCH_RULES が未設定です");

  const rules = JSON.parse(rulesRaw);
  const seen = loadSeen();
  let notified = 0;
  let skipped = 0;

  for (const rule of rules) {
    const site = String(rule.site || "").toLowerCase();
    console.log(`\n[${site}] "${rule.keyword}" を監視中...`);

    let items = [];
    try {
      if      (site === "mercari")   items = await searchMercari(rule);
      else if (site === "2ndstreet") items = await search2ndStreet(rule);
      else if (site === "trefac")    items = await searchTrefac(rule);
      // ↓ サイト追加時はここに追記
      // else if (site === "offmall")   items = await searchOffmall(rule);
      else { console.log("  → 未対応サイト（スキップ）"); continue; }
      console.log(`  → ${items.length} 件取得`);
    } catch (e) {
      console.error(`  → エラー: ${e.message}`);
      continue;
    }

    for (const item of items) {
      const key = `${site}:${rule.keyword}:${item.id}`;
      if (seen[key]) { skipped++; continue; }

      try {
        await sendDiscord(webhookUrl, item, rule);
        seen[key] = Date.now();
        notified++;
        console.log(`  → 通知済: ${item.title}`);
        await sleep(500); // Discord レート制限対策
      } catch (e) {
        console.error(`  → Discord送信エラー: ${e.message}`);
      }
    }
  }

  saveSeen(seen);
  console.log(`\n✅ 完了: 通知${notified}件 / スキップ${skipped}件`);
}

// ============================================================
// メルカリ検索
// 正式URL: https://jp.mercari.com/
// API:     https://api.mercari.jp/v2/entities:search
// ============================================================
async function searchMercari(rule) {
  const url = "https://api.mercari.jp/v2/entities:search?" + new URLSearchParams({
    keyword: rule.keyword,
    limit: "30",
    sort: "SORT_CREATED_TIME",
    order: "ORDER_DESC",
    status: "STATUS_ON_SALE",
  });

  const res = await fetchWithRetry(url, {
    headers: {
      "accept": "application/json",
      "accept-language": "ja-JP,ja;q=0.9",
      "x-platform": "web",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "referer": "https://jp.mercari.com/",
      "origin": "https://jp.mercari.com",
    },
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const data = await res.json();
  return (data?.items ?? [])
    .map((item) => ({
      site: "mercari",
      id: String(item.id || ""),
      title: String(item.name || ""),
      price: Number(item.price || 0),
      url: `https://jp.mercari.com/item/${item.id}`,
    }))
    .filter((i) => i.id && i.title)
    .filter((i) => matchRule(i, rule));
}

// ============================================================
// セカンドストリート検索
// 正式検索URL: https://www.2ndstreet.jp/search?keyword=ANSNAM
// ============================================================
async function search2ndStreet(rule) {
  const url = "https://www.2ndstreet.jp/search?" + new URLSearchParams({
    keyword: rule.keyword,
  });

  const res = await fetchWithRetry(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "ja-JP,ja;q=0.9",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "referer": "https://www.2ndstreet.jp/",
    },
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();
  return parse2ndStreetHtml(html).filter((i) => matchRule(i, rule));
}

// ============================================================
// トレファクファッション検索
// 正式検索URL: https://www.trefac.jp/store/search_result.html?q=ANSNAM&searchbox=1
// ============================================================
async function searchTrefac(rule) {
  const url = "https://www.trefac.jp/store/search_result.html?" + new URLSearchParams({
    q: rule.keyword,
    searchbox: "1",
    step: "1",
  });

  const res = await fetchWithRetry(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "ja-JP,ja;q=0.9",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "referer": "https://www.trefac.jp/",
    },
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();
  return parseTrefacHtml(html).filter((i) => matchRule(i, rule));
}

// ============================================================
// HTML パーサー: セカンドストリート
// ============================================================
function parse2ndStreetHtml(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(\/goods\/(\d+)\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, path, id] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const block = html.slice(Math.max(0, m.index - 2000), m.index + 5000);
    const title = decodeHtml(firstMatch(block, /alt="([^"]{4,100})"/) ?? "タイトル不明");
    const price = yenToNumber(firstMatch(block, /[¥￥]\s*([\d,]+)/) ?? "") ?? 0;
    out.push({ site: "2ndstreet", id, title, price, url: "https://www.2ndstreet.jp" + path });
  }
  return out;
}

// ============================================================
// HTML パーサー: トレファクファッション
// 商品URL例: /store/detail.html?item=XXXXX
// ============================================================
function parseTrefacHtml(html) {
  const out = [];
  const seen = new Set();

  // パターン1: /store/detail.html?item=XXX
  const re1 = /href="(\/store\/detail\.html\?[^"]*item=([^"&\s]+)[^"]*)"/gi;
  // パターン2: /store/tcXXXpsb/?item=XXX 形式
  const re2 = /href="(\/store\/[^"]*\?[^"]*item=([^"&\s]+)[^"]*)"/gi;

  for (const re of [re1, re2]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const [, path, id] = m;
      if (seen.has(id)) continue;
      seen.add(id);

      const block = html.slice(Math.max(0, m.index - 2000), m.index + 5000);

      const title = decodeHtml(
        firstMatch(block, /alt="([^"]{4,100})"/) ??
        firstMatch(block, /<p[^>]*class="[^"]*(?:item|goods)[_-]?name[^"]*"[^>]*>\s*([^<]{4,80})/) ??
        firstMatch(block, /<h[23][^>]*>\s*([^<]{4,80})\s*<\/h[23]>/i) ??
        "タイトル不明"
      );

      const price = yenToNumber(
        firstMatch(block, /[¥￥]\s*([\d,]+)/) ?? ""
      ) ?? 0;

      if (title === "タイトル不明") continue;

      out.push({
        site: "trefac",
        id,
        title,
        price,
        url: "https://www.trefac.jp" + path,
      });
    }
  }
  return out;
}

// ============================================================
// Discord 通知
// ============================================================
async function sendDiscord(webhookUrl, item, rule) {
  const label = { mercari: "メルカリ", "2ndstreet": "セカスト", trefac: "トレファク" }[item.site] ?? item.site;
  const text = [
    `🆕 **${label}** ／ ${rule.keyword}`,
    item.title,
    item.price ? `¥${Number(item.price).toLocaleString("ja-JP")}` : "価格不明",
    item.url,
  ].join("\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) throw new Error(`discord: ${res.status}`);
}

// ============================================================
// ユーティリティ
// ============================================================
async function fetchWithRetry(url, opts, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fetch(url, opts); }
    catch (e) {
      if (i === retries) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

function matchRule(item, rule) {
  const title = (item.title || "").toLowerCase();
  const keyword = (rule.keyword || "").toLowerCase();
  if (!title.includes(keyword)) return false;
  for (const ng of rule.excludes || []) {
    if (title.includes(String(ng).toLowerCase())) return false;
  }
  if (rule.maxPriceYen) {
    const max = Number(rule.maxPriceYen);
    if (max > 0 && Number(item.price || 0) > max) return false;
  }
  return true;
}

function firstMatch(text, re) { return text.match(re)?.[1] ?? null; }

function decodeHtml(t) {
  return String(t)
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function yenToNumber(v) {
  const n = String(v || "").replace(/[^\d]/g, "");
  return n ? Number(n) : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });

// ============================================================
// サイト追加ガイド（あとから追加するときはここを参考に）
// ============================================================
//
// 1. async function searchXxx(rule) { ... } を追加
//    - fetchWithRetry でHTMLかJSONを取得
//    - 商品を { site, id, title, price, url } の配列で返す
//    - .filter((i) => matchRule(i, rule)) を忘れずに
//
// 2. main() の if/else if チェーンに追記:
//    else if (site === "xxx") items = await searchXxx(rule);
//
// 3. WATCH_RULES に {"keyword":"...","site":"xxx"} を追加
//
// 例: オフモール追加の場合
// async function searchOffmall(rule) {
//   const url = "https://www.offmall.jp/item/search/?" + new URLSearchParams({
//     keyword: rule.keyword, sort: "newer"
//   });
//   const res = await fetchWithRetry(url, { headers: { "user-agent": "Mozilla/5.0..." } });
//   if (!res.ok) throw new Error(`offmall: ${res.status}`);
//   const html = await res.text();
//   // HTMLをパースして配列を返す...
// }
