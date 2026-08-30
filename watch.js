/**
 * watch.js — Puppeteer版（GitHub Actions用）
 * puppeteer-extra + stealth でBot検出回避
 */

import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
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

// Fisher-Yatesシャッフル（配列を破壊的にランダムな順序へ並び替える）
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL が未設定です");

  const worker = process.env.WORKER_URL;
if (!worker) throw new Error("WORKER_URL が未設定です");

  console.log(`設定を取得中: ${worker}/settings`);
  const settingsRes = await fetch(`${worker}/settings`);
  if (!settingsRes.ok) throw new Error(`設定取得失敗: ${settingsRes.status}`);
  const settings = await settingsRes.json();
  const rules = Array.isArray(settings.rules) ? settings.rules : [];
  if (!rules.length) throw new Error("rulesが0件です");
  shuffleArray(rules); // 毎回同じ場所でエラーが起きても影響するルールが偏らないよう、監視順をランダム化
  console.log(`ルール${rules.length}件を取得しました（監視順はランダム化済み）`);
  const seen = loadSeen();

  // stealth プラグインを適用
  const puppeteerExtra = addExtra(puppeteer);
  puppeteerExtra.use(StealthPlugin());

  let browser = await puppeteerExtra.launch({
    headless: true,
    protocolTimeout: 180000,
    timeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-networking",
      "--memory-pressure-off",
    ],
  });

  // ブラウザが切断/クラッシュした場合に自動で再起動するヘルパー
  // （--single-process を外したことで単一ページのクラッシュがブラウザ全体を道連れにしなくなったが、
  //   568件規模の長時間実行では念のための保険として用意）
  async function ensureBrowser() {
    if (!browser || !browser.connected) {
      console.log("  → ブラウザが切断されていたため再起動します...");
      try { await browser.close(); } catch (e) {}
      browser = await puppeteerExtra.launch({
        headless: true,
        protocolTimeout: 180000,
        timeout: 60000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--disable-extensions",
          "--disable-background-networking",
          "--memory-pressure-off",
        ],
      });
    }
    return browser;
  }

  let notified = 0;
  let skipped = 0;
  let secondStreetBlockedUntil = 0; // ブロック解除予定時刻

  try {
    for (const rule of rules) {
      const site = String(rule.site || "").toLowerCase();
      console.log(`\n[${site}] "${rule.keyword}" を監視中...`);

      // ブラウザが切断されていないか確認し、必要なら再起動
      await ensureBrowser();

      // セカストがブロック中なら解除まで待機
      if (site === "2ndstreet" && Date.now() < secondStreetBlockedUntil) {
        const waitSec = Math.ceil((secondStreetBlockedUntil - Date.now()) / 1000);
        console.log(`  → ブロック解除待ち（残り約${waitSec}秒）...`);
        await sleep(secondStreetBlockedUntil - Date.now());
      }

      let items = [];
      try {
        const page = await browser.newPage();

        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({
          "accept-language": "ja-JP,ja;q=0.9",
        });

        if (site === "mercari")        items = await searchMercari(page, rule);
        else if (site === "2ndstreet") {
          // Akamai対策：ランダム待機（5〜10秒）
          await sleep(5000 + Math.floor(Math.random() * 5000));
          items = await search2ndStreet(page, rule);
          // Access Deniedの場合は90秒待機してから次のキーワードへ
          if (items.length === 0) {
            const check = await page.evaluate(() => document.body?.innerText?.slice(0, 100) || "").catch(() => "");
            if (check.includes("Access Denied") || check.includes("permission")) {
              console.log("  → Access Denied検出。90秒後に再開します...");
              secondStreetBlockedUntil = Date.now() + 90000;
              await page.close();
              await sleep(90000);
              continue;
            }
          }
        }
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

        if (!existing) {
          try {
            await sendDiscord(webhookUrl, item, rule, "new");
            seen[key] = { price: item.price, ts: Date.now() };
            notified++;
            console.log(`  → 新着通知: ${item.title}`);
            await sleep(2000);
          } catch (e) {
            console.error(`  → Discord送信エラー: ${e.message}`);
          }
          continue;
        }

        const prevPrice = existing.price || 0;
        const curPrice = item.price || 0;

        if (prevPrice > 0 && curPrice > 0) {
          if (curPrice > prevPrice) {
            seen[key] = { ...existing, price: curPrice, ts: Date.now() };
            console.log(`  → 値上がり（記録更新のみ）: ${item.title} ¥${prevPrice}→¥${curPrice}`);
            continue;
          }

          if (curPrice < prevPrice) {
            if (site === "mercari") {
              const lastNotifiedPrice = existing.lastNotifiedPrice || prevPrice;
              const totalDrop = lastNotifiedPrice - curPrice;
              if (totalDrop < 1000) {
                seen[key] = { ...existing, price: curPrice, ts: Date.now() };
                console.log(`  → メルカリ累計値下げ ${totalDrop}円（1000円未満のためスキップ）: ${item.title}`);
                continue;
              }
              try {
                await sendDiscord(webhookUrl, item, rule, "price_down", lastNotifiedPrice);
                seen[key] = { price: curPrice, lastNotifiedPrice: curPrice, ts: Date.now() };
                notified++;
                console.log(`  → メルカリ累計値下げ通知 -${totalDrop}円: ${item.title}`);
                await sleep(2000);
              } catch (e) {
                console.error(`  → Discord送信エラー: ${e.message}`);
              }
              continue;
            }

            try {
              await sendDiscord(webhookUrl, item, rule, "price_down", prevPrice);
              seen[key] = { price: curPrice, lastNotifiedPrice: curPrice, ts: Date.now() };
              notified++;
              console.log(`  → 値下げ通知: ${item.title} ¥${prevPrice}→¥${curPrice}`);
              await sleep(2000);
            } catch (e) {
              console.error(`  → Discord送信エラー: ${e.message}`);
            }
            continue;
          }
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
  const searchUrl = "https://jp.mercari.com/search?" + new URLSearchParams({
    keyword: rule.keyword,
    status: "on_sale",
    sort: "created_time",
    order: "desc",
  });

  const apiItems = [];
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (url.includes("api.mercari.jp") && url.includes("search")) {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const data = await res.json().catch(() => null);
          if (data?.items?.length) {
            apiItems.push(...data.items);
          }
        }
      }
    } catch (e) {}
  });

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(1500);
  }

  if (apiItems.length > 0) {
    const seen = new Set();
    return apiItems
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .map((item) => ({
        site: "mercari",
        id: String(item.id || ""),
        title: String(item.name || ""),
        price: Number(item.price || 0),
        url: /^m\d+$/.test(String(item.id || ""))
  ? `https://jp.mercari.com/item/${item.id}`
  : `https://jp.mercari.com/shops/product/${item.id}`,
        thumbnail: item.thumbnails?.[0] || "",
      }))
      .filter((i) => i.id && i.title)
      .filter((i) => matchRule(i, rule));
  }

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('li[data-testid="item-cell"]').forEach((cell) => {
      const link = cell.querySelector("a");
      const img = cell.querySelector("img");
      const href = link?.href || "";
      const idMatch = href.match(/\/item\/(m\w+)/);
      const id = idMatch ? idMatch[1] : "";
      if (!id || seen.has(id)) return;
      seen.add(id);
      const title = img?.alt?.trim() || "";
      const priceEl = cell.querySelector('[data-testid="price"]');
      const priceText = priceEl?.textContent?.replace(/[^0-9]/g, "") || "0";
      const price = Number(priceText) || 0;
      if (id && title) {
        results.push({ site: "mercari", id, title, price, url: href, thumbnail: img?.src || "" });
      }
    });
    return results;
  });

  return items.filter((i) => matchRule(i, rule));
}

// ============================================================
// セカンドストリート検索（stealth対応版）
// ============================================================
async function search2ndStreet(page, rule) {
  const keyword = String(rule.keyword || "").trim();
  const searchUrl =
    "https://www.2ndstreet.jp/search?keyword=" +
    encodeURIComponent(keyword).replace(/%20/g, "+") +
    "&sortBy=arrival";

  await page.setCookie({
    name: "OptanonAlertBoxClosed",
    value: new Date().toISOString(),
    domain: ".2ndstreet.jp",
  });

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);

  // Access Denied チェック
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
  if (bodyText.includes("Access Denied") || bodyText.includes("permission")) {
    console.log(`  → セカストAccess Denied（stealthでも検出）`);
    return [];
  }

  const dataLayerMap = await page.evaluate(() => {
    const map = {};
    try {
      if (!window.dataLayer) return map;
      window.dataLayer.forEach((entry) => {
        const impressions = entry?.ecommerce?.impressions || entry?.ecommerce?.items || [];
        impressions.forEach((item) => {
          const id = String(item.id || item.item_id || "");
          if (id) map[id] = { name: item.name || item.item_name || "", price: Number(item.price || 0) };
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

      const link = card.querySelector("a.itemCard_inner, a[href*='goodsId']");
      const url = link?.href || "";
      const img = card.querySelector(".itemCard_img img, img");
      const imgSrc = img?.getAttribute("src") || "";
      const thumbnail = imgSrc.startsWith("http") ? imgSrc : "";
      const body = card.querySelector(".itemCard_body");
      const bodyText = (body?.textContent || "").trim().replace(/\s+/g, " ");
      const titleFromHtml = img?.alt?.trim() || bodyText.split(/サイズ|商品の状態|¥|￥/)[0].trim();

      const priceElWithContent = card.querySelector("[itemprop='price'][content]");
      let price = 0;
      if (priceElWithContent) {
        price = Number(priceElWithContent.getAttribute("content")) || 0;
      } else {
        const priceNumEl = card.querySelector("[class*=priceNum], [class*=price-num]");
        const priceMatch = (priceNumEl?.textContent || "").match(/^[\s¥￥]*([\d,]+)/);
        price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;
      }

      if (goodsId) {
        results.push({ site: "2ndstreet", id: goodsId, titleFromHtml, price, url, thumbnail });
      }
    });
    return results;
  });

  const enriched = items.map((item) => {
    const dl = dataLayerMap[item.id];
    const title = (item.titleFromHtml && item.titleFromHtml.length > 3)
      ? item.titleFromHtml
      : (dl?.name || `セカスト商品 ${item.id}`);
    const price = item.price || dl?.price || 0;
    let thumbnail = item.thumbnail;
    if (!thumbnail && item.id.length >= 10) {
      const id = item.id;
      thumbnail = `https://cdn2.2ndstreet.jp/img/pc/goods/${id.slice(0,6)}/${id.slice(6,8)}/${id.slice(8)}/1.jpg`;
    }
    return { site: "2ndstreet", id: item.id, title, price, url: item.url, thumbnail };
  });

  return enriched.filter((i) => matchRule(i, rule));
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
    document.querySelectorAll("li.p-itemlist_item").forEach((card) => {
      const link = card.querySelector("a.p-itemlist_btn");
      const href = link?.href || "";
      if (!href) return;
      const idMatch = href.match(/\/store\/(\d+)\//);
      if (!idMatch) return;
      const id = idMatch[1];
      if (seen.has(id)) return;
      seen.add(id);
      const img = card.querySelector("p.p-itemlist_img img, .p-itemlist_img img");
      const thumbnail = img?.src || img?.getAttribute("src") || "";
      const title = img?.alt?.trim() || `トレファク商品 ${id}`;
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
  const label = { mercari: "メルカリ", "2ndstreet": "セカスト", trefac: "トレファク" }[item.site] ?? item.site;
  const curPriceText = item.price ? `¥${Number(item.price).toLocaleString("ja-JP")}` : "価格不明";
  const priceText = type === "price_down"
    ? `~~¥${Number(prevPrice).toLocaleString("ja-JP")}~~ → **${curPriceText}** 📉`
    : curPriceText;
  const emoji = type === "price_down" ? "📉" : "🆕";

  const text = [`${emoji} **${label}** ／ ${rule.keyword}`, item.title, priceText, item.url].join("\n");

  const sendWithRetry = async (fetchFn, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      const res = await fetchFn();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || "5");
        await sleep(retryAfter * 1000 + 500);
        continue;
      }
      if (!res.ok) throw new Error(`discord: ${res.status}`);
      return res;
    }
    throw new Error("discord: 429 リトライ上限");
  };

  const needsDownload = item.site === "2ndstreet" || item.site === "trefac";

  if (item.thumbnail && !needsDownload) {
    await sendWithRetry(() => fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    }));
    return;
  }

  if (item.thumbnail && needsDownload) {
    try {
      const imgRes = await fetch(item.thumbnail, {
        headers: { "referer": "https://www.2ndstreet.jp/" },
      });
      if (imgRes.ok) {
        const imgBuf = await imgRes.arrayBuffer();
        const imgBytes = new Uint8Array(imgBuf);
        const ext = item.thumbnail.split(".").pop() || "jpg";
        const filename = `thumb.${ext}`;
        const boundary = "----DiscordBoundary" + Date.now();
        const payloadBytes = new TextEncoder().encode(JSON.stringify({ content: text }));
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
        await sendWithRetry(() => fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body: body,
        }));
        return;
      }
    } catch (e) {}
  }

  await sendWithRetry(() => fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  }));
}

// ============================================================
// ユーティリティ
// ============================================================
function matchRule(item, rule) {
  const title = (item.title || "").toLowerCase();
  const keyword = (rule.keyword || "").toLowerCase();
  if (item.site !== "2ndstreet") {
    if (!title.includes(keyword)) return false;
  }
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
