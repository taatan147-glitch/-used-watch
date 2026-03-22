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

    document.querySelectorAll("li.itemCard[goodsid], li[goodsid]").forEach((card) => {
      const goodsId = card.getAttribute("goodsid") || "";
      if (!goodsId || seen.has(goodsId)) return;
      seen.add(goodsId);

      // URL（goodsId + shopsId が含まれている）
      const link = card.querySelector("a.itemCard_inner, a[href*=goodsId]");
      const url = link?.href || "";

      // サムネ：loading=lazyなのでsrc属性を直接取得
      const img = card.querySelector(".itemCard_img img");
      const imgSrc = img?.getAttribute("src") || img?.src || "";
      // srcがbase64やblankの場合はgoodsIdからURL構築
      const thumbnail = imgSrc.startsWith("https://cdn2") ? imgSrc : "";

      // タイトル：itemCard_labelListの最初のli（ブランド名/商品名の部分）
      const labelList = card.querySelector(".itemCard_labelList, .itemCard_body");
      // itemCard_bodyのテキストから最初の行だけ取る
      const bodyText = labelList?.textContent?.trim().replace(/\s+/g, " ") || "";
      // 「サイズ」や「商品の状態」より前の部分がタイトル
      const title = bodyText.split(/サイズ|商品の状態/)[0].trim() || `セカスト商品 ${goodsId}`;

      // 価格：¥マーク付きの数値を探す
      const priceEl = card.querySelector("[class*=price], [class*=Price]");
      const priceText = priceEl?.textContent || "";
      const priceMatch = priceText.match(/([\d,]+)/);
      const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

      if (url) {
        results.push({ site: "2ndstreet", id: goodsId, title, price, url, thumbnail });
      }
    });

    return results;
  });

  // サムネが取れていない商品はgoodsIdからURL構築を試みる
  // cdn2.2ndstreet.jp/img/pc/goods/XXXXXX/XX/XXXXX/1.jpg 形式
  // goodsId例: 2337943794993 → 233794/37/94993
  for (const item of items) {
    if (!item.thumbnail && item.id.length >= 10) {
      const id = item.id;
      const part1 = id.slice(0, 6);
      const part2 = id.slice(6, 8);
      const part3 = id.slice(8);
      item.thumbnail = `https://cdn2.2ndstreet.jp/img/pc/goods/${part1}/${part2}/${part3}/1.jpg`;
    }
  }

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

  const text = [
    `🆕 **${label}** ／ ${rule.keyword}`,
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
