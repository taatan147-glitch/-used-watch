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
        else if (site === "2ndstreet") {
          // セカストは連続アクセスでAccess Deniedになりやすいため、少し待つ
          await sleep(8000 + Math.floor(Math.random() * 7000));
          items = await search2ndStreet(page, rule);
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

        // 新着判定
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

        // 値下げ判定
        const prevPrice = existing.price || 0;
        const curPrice = item.price || 0;

        if (prevPrice > 0 && curPrice > 0) {
          if (curPrice > prevPrice) {
            // 値上がり → 通知しない・記録だけ更新（セカストのセール終了など）
            seen[key] = { ...existing, price: curPrice, ts: Date.now() };
            console.log(`  → 値上がり（記録更新のみ）: ${item.title} ¥${prevPrice}→¥${curPrice}`);
            continue;
          }

          if (curPrice < prevPrice) {
            const drop = prevPrice - curPrice;

            // メルカリは累計1000円以上値下がりした時のみ通知
            if (site === "mercari") {
              const lastNotifiedPrice = existing.lastNotifiedPrice || prevPrice;
              const totalDrop = lastNotifiedPrice - curPrice;
              if (totalDrop < 1000) {
                // 累計未達 → 記録更新のみ
                seen[key] = { ...existing, price: curPrice, ts: Date.now() };
                console.log(`  → メルカリ累計値下げ ${totalDrop}円（1000円未満のためスキップ）: ${item.title}`);
                continue;
              }
              // 累計1000円以上 → 通知＋lastNotifiedPriceをリセット
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

            // セカスト・トレファクは即通知
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

  // APIレスポンスを傍受
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

  // スクロールして追加読み込み
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await sleep(1500);
  }

  // APIから取れた場合はそちらを優先
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
        // ShopsはURLが異なる
        url: item.shopName
          ? `https://jp.mercari.com/shops/product/${item.id}`
          : `https://jp.mercari.com/item/${item.id}`,
        thumbnail: item.thumbnails?.[0] || "",
      }))
      .filter((i) => i.id && i.title)
      .filter((i) => matchRule(i, rule));
  }

  // APIから取れなかった場合はHTMLから取得
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
      // 価格：data-testid="price"内のspan（通貨記号以外）
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
// セカンドストリート検索
// ============================================================
async function search2ndStreet(page, rule) {
  const keyword = String(rule.keyword || "").trim();

  // ブラウザ手入力に近いURL形式にする（スペースは +）
  const searchUrl =
    "https://www.2ndstreet.jp/search?keyword=" +
    encodeURIComponent(keyword).replace(/%20/g, "+");

  await page.setCookie({
    name: "OptanonAlertBoxClosed",
    value: new Date().toISOString(),
    domain: ".2ndstreet.jp",
  });

  // 連続アクセス感を減らす
  await sleep(5000 + Math.floor(Math.random() * 5000));

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(7000);

  // 遅延描画・追加読み込み対策
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1200);
  }

  // Access Denied / 表示内容確認用ログ
  const pageInfo = await page.evaluate(() => ({
    url: location.href,
    bodyText: document.body.innerText.slice(0, 240),
  }));
  console.log(`  → セカスト表示URL: ${pageInfo.url}`);
  console.log(`  → セカスト本文先頭: ${pageInfo.bodyText.replace(/\n/g, " ").slice(0, 180)}`);

  // dataLayerから商品名・価格を取得（取れる場合は補完に使う）
  const dataLayerMap = await page.evaluate(() => {
    const map = {};
    try {
      if (!window.dataLayer) return map;
      window.dataLayer.forEach((entry) => {
        const impressions = entry?.ecommerce?.impressions || entry?.ecommerce?.items || [];
        impressions.forEach((item) => {
          const id = String(item.id || item.item_id || "");
          if (id) {
            map[id] = {
              name: item.name || item.item_name || "",
              price: Number(item.price || 0),
            };
          }
        });
      });
    } catch (e) {}
    return map;
  });

  const items = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // 旧仕様の goodsid 付きカードを最優先
    document.querySelectorAll("li.itemCard[goodsid], li[goodsid], div.itemCard[goodsid], div[goodsid]").forEach((card) => {
      const goodsId = card.getAttribute("goodsid") || "";
      if (!goodsId || seen.has(goodsId)) return;
      seen.add(goodsId);

      const link =
        card.querySelector("a.itemCard_inner, a[href*='goodsId'], a[href*='/goods/detail/']") ||
        card.querySelector("a[href]");
      const url = link?.href || "";

      const img = card.querySelector(".itemCard_img img, img");
      const imgSrc = img?.getAttribute("src") || img?.getAttribute("data-src") || "";
      const thumbnail = imgSrc.startsWith("http") ? imgSrc : "";

      const body = card.querySelector(".itemCard_body, [class*='body'], [class*='Body']");
      const bodyText = (body?.textContent || card.textContent || "").trim().replace(/\s+/g, " ");
      const titleFromHtml =
        img?.alt?.trim() ||
        bodyText.split(/サイズ|商品の状態|¥|￥/)[0].trim();

      const priceElWithContent = card.querySelector("[itemprop='price'][content]");
      let price = 0;
      if (priceElWithContent) {
        price = Number(priceElWithContent.getAttribute("content")) || 0;
      } else {
        const priceNumEl = card.querySelector("[class*=priceNum], [class*=price-num], [class*=price]");
        const priceMatch = (priceNumEl?.textContent || card.textContent || "").match(/[¥￥]?\s*([\d,]{3,})/);
        price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;
      }

      if (url || goodsId) {
        results.push({
          site: "2ndstreet",
          id: goodsId,
          titleFromHtml,
          price,
          url: url || `https://www.2ndstreet.jp/goods/detail/goodsId/${goodsId}/`,
          thumbnail
        });
      }
    });

    // 新しめのリンク構造にも対応
    document.querySelectorAll("a[href*='/goods/detail/'], a[href*='goodsId']").forEach((link) => {
      const url = link.href || "";
      const goodsId =
        url.match(/goodsId\/(\d+)/)?.[1] ||
        url.match(/goodsId=(\d+)/)?.[1] ||
        url.match(/goods\/detail\/goodsId\/(\d+)/)?.[1] ||
        url.match(/\/goods\/detail\/(\d+)/)?.[1] ||
        "";

      if (!goodsId || seen.has(goodsId)) return;
      seen.add(goodsId);

      let card = link;
      for (let i = 0; i < 8; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        const txt = card.textContent || "";
        if (
          txt.includes("商品の状態") ||
          txt.includes("サイズ") ||
          txt.includes("¥") ||
          txt.includes("￥") ||
          card.querySelector("img")
        ) {
          break;
        }
      }

      const img = card.querySelector("img") || link.querySelector("img");
      const rawText = (card.textContent || "").replace(/\s+/g, " ").trim();

      const titleFromHtml =
        img?.alt?.trim() ||
        rawText.split(/サイズ|商品の状態|¥|￥/)[0].trim();

      const priceContent =
        card.querySelector("[itemprop='price'][content]")?.getAttribute("content") ||
        card.querySelector("[class*='priceNum']")?.textContent ||
        card.querySelector("[class*='price']")?.textContent ||
        rawText.match(/[¥￥]\s*([\d,]+)/)?.[1] ||
        "";

      const priceText = String(priceContent).replace(/[^\d]/g, "");
      const price = priceText ? Number(priceText) : 0;

      results.push({
        site: "2ndstreet",
        id: goodsId,
        titleFromHtml,
        price,
        url,
        thumbnail: img?.src || img?.getAttribute("data-src") || ""
      });
    });

    return results;
  });

  console.log(`  → セカスト生取得 ${items.length} 件`);

  // dataLayerの商品名でタイトルを補完、サムネURLを構築
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

  // Discord送信（429レート制限時はリトライ）
  const sendWithRetry = async (fetchFn, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      const res = await fetchFn();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || "5");
        console.log(`  レート制限: ${retryAfter}秒待機...`);
        await sleep(retryAfter * 1000 + 500);
        continue;
      }
      if (!res.ok) throw new Error(`discord: ${res.status}`);
      return res;
    }
    throw new Error("discord: 429 リトライ上限");
  };

  // メルカリはサムネURLをそのまま使う（static.mercdn.netはDiscordが読める）
  // セカストはダウンロードして添付
  const needsDownload = item.site === "2ndstreet" || item.site === "trefac";

  if (item.thumbnail && !needsDownload) {
    // URLのまま埋め込み送信
    const payload = {
      content: `${text}`,
    };
    await sendWithRetry(() => fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    return;
  }

  // サムネがある場合は画像をダウンロードしてDiscordに添付
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

        await sendWithRetry(() => fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body: body,
        }));
        return;
      }
    } catch (e) {
      // 画像取得失敗時はテキストのみで送信
    }
  }

  // テキストのみで送信
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

  // セカストは検索結果ページ自体がキーワードで絞られているため、
  // 「テンシー」検索で商品タイトルが「Ten-C」など、表記がズレても通す
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
