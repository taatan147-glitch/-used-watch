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
  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2), "utf8");
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
        const existing = seen[key];

        // 新着判定
        if (!existing) {
          try {
            await sendDiscord(webhookUrl, item, rule, "new");
            seen[key] = { price: item.price, ts: Date.now() };
            notified++;
            console.log(`  → 新着通知: ${item.title}`);
            await sleep(500);
          } catch (e) {
            console.error(`  → Discord送信エラー: ${e.message}`);
          }
          continue;
        }

        // 値下げ判定（価格が記録されていて、かつ下がっている場合）
        const prevPrice = existing.price || 0;
        const curPrice = item.price || 0;
        if (prevPrice > 0 && curPrice > 0 && curPrice < prevPrice) {
          try {
            await sendDiscord(webhookUrl, item, rule, "price_down", prevPrice);
            seen[key] = { price: curPrice, ts: Date.now() };
            notified++;
            console.log(`  → 値下げ通知: ${item.title} ¥${prevPrice}→¥${curPrice}`);
            await sleep(500);
          } catch (e) {
            console.error(`  → Discord送信エラー: ${e.message}`);
          }
          continue;
        }

        skipped++;
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
      // 価格取得：data-testid="price" → span の数値
      const priceSpan = cell.querySelector('[data-testid="price"] span:not([class*="currency"]), [data-testid="item-cell-price"] span');
      const priceText2 = priceSpan?.textContent?.trim() || priceEl?.textContent?.trim() || "";
      const priceMatch = priceText2.match(/([\d,]+)/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

      if (id && title) {
        results.push({
          site: "mercari",
          id,
          title,
          price,
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

  // dataLayerから商品名・価格を取得（最も信頼性が高い）
  const dataLayerMap = await page.evaluate(() => {
    const map = {};
    try {
      if (!window.dataLayer) return map;
      window.dataLayer.forEach((entry) => {
        const impressions = entry?.ecommerce?.impressions || entry?.ecommerce?.items || [];
        impressions.forEach((item) => {
          const id = String(item.id || item.item_id || "");
          if (id) map[id] = {
            name: item.name || item.item_name || "",
            price: Number(item.price || 0),
          };
        });
      });
    } catch (e) {}
    return map;
  });

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll("li.itemCard[goodsid], li[goodsid]").forEach((card) => {
      const goodsId = card.getAttribute("goodsid") || "";
      if (!goodsId || seen.has(goodsId)) return;
      seen.add(goodsId);

      const link = card.querySelector("a.itemCard_inner, a[href*=goodsId]");
      const url = link?.href || "";

      const img = card.querySelector(".itemCard_img img");
      const imgSrc = img?.getAttribute("src") || "";
      const thumbnail = imgSrc.startsWith("https://cdn2") ? imgSrc : "";

      // タイトル：itemCard_bodyのテキストから「サイズ」より前を取得
      const body = card.querySelector(".itemCard_body");
      const bodyText = body?.textContent?.trim().replace(/\s+/g, " ") || "";
      const titleFromHtml = bodyText.split(/サイズ|商品の状態/)[0].trim();

      // 価格
      const priceEl = card.querySelector("[class*=price], [class*=Price]");
      const priceMatch = (priceEl?.textContent || "").match(/([\d,]+)/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

      if (url) {
        results.push({ site: "2ndstreet", id: goodsId, titleFromHtml, price, url, thumbnail });
      }
    });
    return results;
  });

  // dataLayerの商品名でタイトルを補完、サムネURLを構築
  const enriched = items.map((item) => {
    const dl = dataLayerMap[item.id];
    const title = (item.titleFromHtml && item.titleFromHtml.length > 3)
      ? item.titleFromHtml
      : (dl?.name || `セカスト商品 ${item.id}`);
    const price = item.price || dl?.price || 0;

    // サムネがない場合はgoodsIdから構築
    let thumbnail = item.thumbnail;
    if (!thumbnail && item.id.length >= 10) {
      const id = item.id;
      thumbnail = `https://cdn2.2ndstreet.jp/img/pc/goods/${id.slice(0,6)}/${id.slice(6,8)}/${id.slice(8)}/1.jpg`;
    }

    return { site: "2ndstreet", id: item.id, title, price, url: item.url, thumbnail };
  });

  return enriched;
}
// ============================================================
// トレファクファッション検索
// ============================================================
async function searchTrefac(page, rule) {
  const url = "https://www.trefac.jp/store/tcpsb/?" + new URLSearchParams({
    srchword: rule.keyword,
    step: "1",
    order: "new",
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // li.p-itemlist_item が商品カード
    document.querySelectorAll("li.p-itemlist_item").forEach((card) => {
      // URL: a.p-itemlist_btn[href]
      const link = card.querySelector("a.p-itemlist_btn");
      const href = link?.href || "";
      if (!href) return;

      // IDはURLから抽出
      const idMatch = href.match(/\/store\/(\d+)\//);
      if (!idMatch) return;
      const id = idMatch[1];
      if (seen.has(id)) return;
      seen.add(id);

      // サムネ・タイトル: p.p-itemlist_img img
      const img = card.querySelector("p.p-itemlist_img img, .p-itemlist_img img");
      const thumbnail = img?.src || img?.getAttribute("src") || "";
      const title = img?.alt?.trim() || `トレファク商品 ${id}`;

      // 価格
      const priceEl = card.querySelector("[class*=price], [class*=Price]");
      const priceMatch = (priceEl?.textContent || card.textContent).match(/([\d,]+)(?=\s*(?:円|税))/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

      results.push({ site: "trefac", id, title, price, url: href, thumbnail });
    });

    return results;
  });

  return items.filter((i) => matchRule(i, rule));
}
// ============================================================
// Discord 通知
// ============================================================
async function sendDiscord(webhookUrl, item, rule, type = "new", prevPrice = 0) {
  const label = {
    mercari: "メルカリ",
    "2ndstreet": "セカスト",
    trefac: "トレファク",
  }[item.site] ?? item.site;

  const curPriceText = item.price ? `¥${Number(item.price).toLocaleString("ja-JP")}` : "価格不明";
  const priceText = type === "price_down"
    ? `~~¥${Number(prevPrice).toLocaleString("ja-JP")}~~ → **${curPriceText}** 📉`
    : curPriceText;
  const emoji = type === "price_down" ? "📉" : "🆕";

  const text = [
    `${emoji} **${label}** ／ ${rule.keyword}`,
    item.title,
    priceText,
    item.url,
  ].join("\n");

  // サムネがある場合は画像をダウンロードしてDiscordに添付
  if (item.thumbnail) {
    try {
      const imgRes = await fetch(item.thumbnail, {
        headers: { "referer": "https://www.2ndstreet.jp/" },
      });
      if (imgRes.ok) {
        const imgBuf = await imgRes.arrayBuffer();
        const imgBytes = new Uint8Array(imgBuf);
        const ext = item.thumbnail.split(".").pop() || "jpg";
        const filename = `thumb.${ext}`;

        // FormDataで画像を添付して送信
        const boundary = "----DiscordBoundary" + Date.now();
        const payloadJson = JSON.stringify({ content: text });
        const payloadBytes = new TextEncoder().encode(payloadJson);

        // multipart/form-data を手動構築
        const parts = [];
        const enc = (s) => new TextEncoder().encode(s);
        parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n`));
        parts.push(payloadBytes);
        parts.push(enc(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`));
        parts.push(imgBytes);
        parts.push(enc(`\r\n--${boundary}--`));

        const totalLen = parts.reduce((a, b) => a + b.length, 0);
        const body = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) { body.set(p, offset); offset += p.length; }

        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body: body,
        });
        if (!res.ok) throw new Error(`discord multipart: ${res.status}`);
        return;
      }
    } catch (e) {
      // 画像取得失敗時はテキストのみで送信
    }
  }

  // テキストのみで送信
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
