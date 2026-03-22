/**
 * watch.js — Puppeteer版（GitHub Actions用）
 * Node.js 20 + puppeteer で動作
 *
 * GitHub Secrets:
 *   DISCORD_WEBHOOK_URL  — Discord Webhook URL
 *   WATCH_RULES          — 監視ルールJSON
 *
 * WATCH_RULES例:
 * [
 *   {"keyword":"ansnam","site":"mercari"},
 *   {"keyword":"ansnam","site":"2ndstreet"},
 *   {"keyword":"ansnam","site":"trefac"},
 *   ...
 * ]
 */

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, existsSync } from "fs";

const SEEN_FILE = "seen.json";

function loadSeen() {
  if (!existsSync(SEEN_FILE)) return {};
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); }
  catch { return {}; }
}

function saveSeen(seen) {
  writeFileSync(SEEN_FILE, JSON.stringify(seen), "utf8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL が未設定です");

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) throw new Error("WORKER_URL が未設定です");

  // WorkerのKVから最新のルールを取得
  console.log(`設定を取得中: ${workerUrl}/settings`);
  const settingsRes = await fetch(`${workerUrl}/settings`);
  if (!settingsRes.ok) throw new Error(`設定取得失敗: ${settingsRes.status}`);
  const settings = await settingsRes.json();
  const rules = Array.isArray(settings.rules) ? settings.rules : [];
  if (!rules.length) throw new Error("rulesが0件です");
  console.log(`ルール${rules.length}件を取得しました`);
  const seen = loadSeen();

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  });

  let notified = 0;
  let skipped = 0;

  try {
    for (const rule of rules) {
      const site = String(rule.site || "").toLowerCase();
      console.log(`\n[${site}] "${rule.keyword}" を監視中...`);

      let items = [];
      try {
        const page = await browser.newPage();

        // Bot検知対策
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({
          "accept-language": "ja-JP,ja;q=0.9",
        });

        if (site === "mercari")        items = await searchMercari(page, rule);
        else if (site === "2ndstreet") items = await search2ndStreet(page, rule);
        else if (site === "trefac")    items = await searchTrefac(page, rule);
        else {
          console.log("  → 未対応サイト");
          await page.close();
          continue;
        }

        await page.close();
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
          console.log(`  → 通知: ${item.title}`);
          await sleep(500);
        } catch (e) {
          console.error(`  → Discord送信エラー: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  saveSeen(seen);
  console.log(`\n✅ 完了: 通知${notified}件 / スキップ${skipped}件`);
}

// ============================================================
// メルカリ検索
// ============================================================
async function searchMercari(page, rule) {
  const url = "https://jp.mercari.com/search?" + new URLSearchParams({
    keyword: rule.keyword,
    status: "on_sale",
    sort: "created_time",
    order: "desc",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 商品一覧が表示されるまで待機
  await page.waitForSelector('li[data-testid="item-cell"], [data-testid="no-result"]', {
    timeout: 15000,
  }).catch(() => {});

  // 複数回スクロールして追加読み込みを促す
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(1500);
  }

  const items = await page.evaluate((keyword) => {
    const cells = document.querySelectorAll('li[data-testid="item-cell"]');
    const results = [];
    cells.forEach((cell) => {
      const link = cell.querySelector("a");
      const img = cell.querySelector("img");
      const priceEl = cell.querySelector('[data-testid="item-cell-price"], .merPrice, [class*="price"]');

      const href = link?.href || "";
      const idMatch = href.match(/\/item\/(m\w+)/);
      const id = idMatch ? idMatch[1] : "";
      const title = img?.alt || link?.textContent?.trim() || "";
      const priceText = priceEl?.textContent?.replace(/[^\d]/g, "") || "0";

      if (id && title) {
        results.push({
          site: "mercari",
          id,
          title,
          price: Number(priceText) || 0,
          url: href,
        });
      }
    });
    return results;
  }, rule.keyword);

  return items.filter((i) => matchRule(i, rule));
}

// ============================================================
// セカンドストリート検索
// ============================================================
async function search2ndStreet(page, rule) {
  const searchUrl = "https://www.2ndstreet.jp/search?" + new URLSearchParams({
    keyword: rule.keyword,
    sortBy: "arrival",
  });

  await page.setCookie({
    name: "OptanonAlertBoxClosed",
    value: new Date().toISOString(),
    domain: ".2ndstreet.jp",
  });

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(4000);

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // li.itemCard[goodsid] から直接取得
    document.querySelectorAll("li.itemCard[goodsid], li[goodsid], li[class*=itemCard]").forEach((card) => {
      const goodsId = card.getAttribute("goodsid") || "";
      if (!goodsId || seen.has(goodsId)) return;
      seen.add(goodsId);

      // URL: a.itemCard_inner[href]
      const link = card.querySelector("a.itemCard_inner, a[href*=goodsId]");
      const url = link?.href || "";

      // サムネ: div.itemCard_img img
      const img = card.querySelector(".itemCard_img img, img");
      const thumbnail = img?.src || img?.currentSrc || img?.dataset?.src || "";

      // タイトル: .itemCard_body 内のテキスト
      const body = card.querySelector(".itemCard_body, .itemCard_label, [class*=itemCard_name]");
      const title = body?.textContent?.trim().replace(/\s+/g, " ").slice(0, 100) || "";

      // 価格
      const priceEl = card.querySelector("[class*=price], [class*=Price]");
      const priceMatch = (priceEl?.textContent || card.textContent).match(/[\d,]{3,}(?=\s*(?:円|税))/);
      const price = priceMatch ? Number(priceMatch[0].replace(/,/g, "")) : 0;

      if (url) {
        results.push({ site: "2ndstreet", id: goodsId, title: title || `セカスト商品 ${goodsId}`, price, url, thumbnail });
      }
    });

    return results;
  });

  return items;
}
// ============================================================
// トレファクファッション検索
// ============================================================
async function searchTrefac(page, rule) {
  const url = "https://www.trefac.jp/store/tcpsb/?" + new URLSearchParams({
    srchword: rule.keyword,
    step: "1",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // トレファクの商品リンクパターンを複数試す
    const allLinks = document.querySelectorAll("a");
    allLinks.forEach((link) => {
      const href = link.href || "";
      // 商品詳細ページのパターン：/store/detail.html?item=XXX または /item/XXX
      const idMatch =
        href.match(/[?&]item=([^&]+)/) ||
        href.match(/\/item\/([^/?]+)/) ||
        href.match(/detail[^?]*[?&]?.*item[=\/]([^&/]+)/);
      if (!idMatch) return;
      const id = idMatch[1];
      if (seen.has(id) || id.length < 3) return;
      seen.add(id);

      const card = link.closest("li, article, div") || link;
      const img = card?.querySelector("img");

      const title =
        img?.alt?.trim() ||
        card?.querySelector('[class*="name"],[class*="item"],[class*="title"]')?.textContent?.trim() ||
        link.textContent?.trim() || "";

      const priceMatch = card?.textContent?.match(/[¥￥]([\d,]+)/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;
      const thumbnail = img?.src || img?.dataset?.src || "";

      if (title && title.length > 2) {
        results.push({ site: "trefac", id, title, price, url: href, thumbnail });
      }
    });

    // デバッグ：リンク数とサンプルを返す
    if (results.length === 0) {
      const linkCount = document.querySelectorAll("a").length;
      const sampleHrefs = Array.from(document.querySelectorAll("a"))
        .map(a => a.href).filter(h => h.includes("trefac")).slice(0, 5);
      console.log("trefac debug: links=" + linkCount + " samples=" + JSON.stringify(sampleHrefs));
    }

    return results;
  });

  return items.filter((i) => matchRule(i, rule));
}

// ============================================================
// Discord 通知
// ============================================================
async function sendDiscord(webhookUrl, item, rule) {
  const label = {
    mercari: "メルカリ",
    "2ndstreet": "セカスト",
    trefac: "トレファク",
  }[item.site] ?? item.site;

  const priceText = item.price ? `¥${Number(item.price).toLocaleString("ja-JP")}` : "価格不明";

  // テキストのみで送信 → DiscordがURLのOGPからサムネを自動取得
  const text = [
    `🆕 **${label}** ／ ${rule.keyword}`,
    item.title,
    priceText,
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

main().catch((e) => { console.error(e); process.exit(1); });
