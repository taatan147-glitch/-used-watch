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

  // ネットワークリクエストを傍受して商品APIのレスポンスを取得
  const apiResponses = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => req.continue());
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (url.includes("searchapi") || url.includes("getGoods") || url.includes("search/goods")) {
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const body = await res.json().catch(() => null);
          if (body) apiResponses.push(body);
        }
      }
    } catch (e) {}
  });

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(4000);

  // ページ内の__NEXT_DATA__またはwindow変数からデータを取得
  const pageData = await page.evaluate(() => {
    // Next.jsのデータ
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData) {
      try { return { type: "next", data: JSON.parse(nextData.textContent) }; }
      catch (e) {}
    }
    // script内のJSONデータを探す
    const scripts = document.querySelectorAll("script:not([src])");
    for (const s of scripts) {
      const text = s.textContent || "";
      // 商品データっぽいJSONを探す
      const match = text.match(/window\.__(?:INITIAL|PAGE|STORE)_(?:DATA|STATE)__\s*=\s*(\{.+?\});/s);
      if (match) {
        try { return { type: "window", data: JSON.parse(match[1]) }; }
        catch (e) {}
      }
    }
    // HTML内の構造化データ（JSON-LD）
    const jsonlds = document.querySelectorAll('script[type="application/ld+json"]');
    for (const j of jsonlds) {
      try {
        const d = JSON.parse(j.textContent);
        if (d["@type"] === "ItemList" || d.itemListElement) {
          return { type: "jsonld", data: d };
        }
      } catch (e) {}
    }
    // viewHistory cookieから既存goodsIdを取得
    const vh = document.cookie.match(/viewHistory=([^;]+)/);
    if (vh) {
      try { return { type: "cookie", data: JSON.parse(decodeURIComponent(vh[1])) }; }
      catch (e) {}
    }
    return null;
  });

  // ページ内のdataLayerから商品情報を取得（Googleアナリティクス用データ）
  const dataLayerItems = await page.evaluate(() => {
    try {
      if (!window.dataLayer) return [];
      const impressions = [];
      window.dataLayer.forEach((entry) => {
        if (entry.ecommerce && entry.ecommerce.impressions) {
          impressions.push(...entry.ecommerce.impressions);
        }
        if (entry.ecommerce && entry.ecommerce.items) {
          impressions.push(...entry.ecommerce.items);
        }
      });
      return impressions;
    } catch (e) { return []; }
  });

  const items = [];
  const seen = new Set();

  // dataLayerから商品情報を取得（最も信頼性が高い）
  if (dataLayerItems.length > 0) {
    for (const dl of dataLayerItems) {
      const id = String(dl.id || dl.item_id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // URLはdataLayerに含まれないので別途組み立て
      // shopsIdはURLから取得する必要があるため一旦IDのみのURLを設定
      items.push({
        site: "2ndstreet",
        id,
        title: dl.name || dl.item_name || `セカスト商品 ${id}`,
        price: Number(dl.price || 0),
        url: `https://www.2ndstreet.jp/goods/detail/goodsId/${id}/`,
        thumbnail: "",
      });
    }
  }

  // dataLayerで取れなかった場合はHTMLのリンクからshopsId付きURLを構築
  if (items.length === 0) {
    const pairs = await page.evaluate(() => {
      const seen = new Set();
      const pairs = [];
      // ページのHTMLソースから直接パターンを検索
      const html = document.documentElement.innerHTML;
      const re = /goodsId["\/=]+(\d{10,})["\/]*(?:[^}]*shopsId["\/=]+(\d+))?/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const goodsId = m[1];
        const shopsId = m[2] || "";
        if (seen.has(goodsId)) continue;
        seen.add(goodsId);
        pairs.push({ goodsId, shopsId });
      }
      return pairs.slice(0, 30);
    });

    for (const { goodsId, shopsId } of pairs) {
      if (seen.has(goodsId)) continue;
      seen.add(goodsId);
      items.push({
        site: "2ndstreet",
        id: goodsId,
        title: `セカスト商品 ${goodsId}`,
        price: 0,
        url: shopsId
          ? `https://www.2ndstreet.jp/goods/detail/goodsId/${goodsId}/shopsId/${shopsId}/`
          : `https://www.2ndstreet.jp/goods/detail/goodsId/${goodsId}/`,
        thumbnail: "",
      });
    }
  }

  // shopsIdとサムネをHTMLソースから補完
  if (items.length > 0) {
    const supplementData = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const result = {};

      // goodsId と shopsId のペアを抽出
      // パターン例: goodsId/2339213273061/shopsId/31295
      const pairRe = /goodsId["\/]+(\d{10,})["\/]+shopsId["\/]+(\d+)/g;
      let m;
      while ((m = pairRe.exec(html)) !== null) {
        const gid = m[1], sid = m[2];
        if (!result[gid]) result[gid] = { shopsId: sid, thumbnail: "" };
      }

      // サムネURL抽出（imgのsrcかdata-srcから）
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || img.dataset?.src || img.dataset?.lazySrc || "";
        if (!src.includes("2ndstreet") && !src.includes("cdn2")) return;
        // URLからgoodsIdを推測
        const gm = src.match(/(\d{10,})/);
        if (gm && result[gm[1]]) {
          result[gm[1]].thumbnail = src;
        }
      });

      return result;
    });

    // itemsにshopsIdとサムネを補完
    for (const item of items) {
      const sup = supplementData[item.id];
      if (sup) {
        if (sup.shopsId) {
          item.url = `https://www.2ndstreet.jp/goods/detail/goodsId/${item.id}/shopsId/${sup.shopsId}/`;
        }
        if (sup.thumbnail && !item.thumbnail) {
          item.thumbnail = sup.thumbnail;
        }
      }
    }
  }

  await page.setRequestInterception(false);
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
