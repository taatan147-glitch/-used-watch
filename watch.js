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

  // 少し下にスクロールして追加読み込みを促す
  await page.evaluate(() => window.scrollBy(0, 1000));
  await sleep(2000);

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

  // goodsIdとshopsIdのペアをリンクから収集
  const goodsPairs = await page.evaluate(() => {
    const seen = new Set();
    const pairs = [];
    document.querySelectorAll("a").forEach((link) => {
      const href = link.href || "";
      if (!href.includes("2ndstreet.jp")) return;
      const gm = href.match(/goodsId[/=](\d+)/);
      const sm = href.match(/shopsId[/=](\d+)/);
      if (!gm || seen.has(gm[1])) return;
      seen.add(gm[1]);
      const card = link.closest("li,article,div") || link.parentElement;
      const img = card?.querySelector("img");
      const thumb = img?.src || img?.dataset?.src || "";
      pairs.push({ goodsId: gm[1], shopsId: sm ? sm[1] : "", thumb });
    });
    return pairs;
  });

  // 各商品の詳細をAPIで取得
  const items = [];
  for (const { goodsId, shopsId, thumb } of goodsPairs) {
    let title = `セカスト商品 ${goodsId}`;
    let price = 0;
    let thumbnail = thumb;
    const itemUrl = shopsId
      ? `https://www.2ndstreet.jp/goods/detail/goodsId/${goodsId}/shopsId/${shopsId}/`
      : `https://www.2ndstreet.jp/goods/detail/goodsId/${goodsId}/`;

    try {
      const apiUrl = `https://www.2ndstreet.jp/searchapi/getGoodsDetail?goodsId=${goodsId}` +
                     (shopsId ? `&shopsId=${shopsId}` : "");
      const res = await fetch(apiUrl, {
        headers: {
          "accept": "application/json",
          "x-requested-with": "XMLHttpRequest",
          "referer": searchUrl,
        },
      });
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = await res.json();
          const g = data.goods || data.item || data;
          if (g.name || g.goodsName) title = g.name || g.goodsName;
          if (g.price || g.sellingPrice) price = Number(g.price || g.sellingPrice);
          if (g.image || g.imageUrl) thumbnail = g.image || g.imageUrl;
        }
      }
    } catch (e) {}

    items.push({ site: "2ndstreet", id: goodsId, title, price, url: itemUrl, thumbnail });
  }

  return items;
}

// ============================================================
// トレファクファッション検索
// ============================================================
async function searchTrefac(page, rule) {
  const url = "https://www.trefac.jp/store/search_result.html?" + new URLSearchParams({
    q: rule.keyword,
    searchbox: "1",
    step: "1",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const links = document.querySelectorAll('a[href*="item="]');
    links.forEach((link) => {
      const href = link.href;
      const idMatch = href.match(/item=([^&]+)/);
      if (!idMatch) return;
      const id = idMatch[1];
      if (seen.has(id)) return;
      seen.add(id);

      const card = link.closest("li, article, div") || link;
      const img = card.querySelector("img");

      const title =
        img?.alt?.trim() ||
        card.querySelector('[class*="name"],[class*="title"]')?.textContent?.trim() ||
        link.textContent?.trim() || "";

      const priceMatch = card.textContent.match(/[¥￥]([\d,]+)/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

      if (title && title.length > 2) {
        results.push({ site: "trefac", id, title, price, url: href });
      }
    });
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

  // サムネがある場合はEmbedで送信（画像付き）
  if (item.thumbnail) {
    const payload = {
      content: `🆕 **${label}** ／ ${rule.keyword}`,
      embeds: [{
        title: item.title,
        url: item.url,
        description: priceText,
        thumbnail: { url: item.thumbnail },
      }],
    };
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`discord: ${res.status}`);
  } else {
    // サムネなしはテキストのみ
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
