// Fetches all active listings for EBAY_SELLER via the eBay Browse API and
// writes a normalized src/data/products.json. Run with:
//   node --env-file=.env scripts/fetch-ebay.mjs
//
// Node 20 ESM, no external dependencies (global fetch, node:fs, node:path only).

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "src", "data", "products.json");

const MARKETPLACE_ID = "EBAY_US";
const SEARCH_LIMIT = 200;
const DETAIL_CONCURRENCY = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a URL, retrying on 429/5xx with exponential backoff.
 * Throws on non-retryable errors or after retries are exhausted.
 */
async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    const isLastAttempt = attempt >= RETRY_DELAYS_MS.length;
    if (!retryable || isLastAttempt) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${url}${body ? ` — ${body.slice(0, 500)}` : ""}`
      );
    }

    const delay = RETRY_DELAYS_MS[attempt];
    console.error(`Request to ${url} failed with ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
    await sleep(delay);
  }
}

async function getAccessToken(clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchWithRetry("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`OAuth token response missing access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

/**
 * Exchanges the long-lived (~18mo) EBAY_REFRESH_TOKEN for a short-lived (~2h) user access
 * token, used to authenticate Trading API calls (see getStoreCategoryIds). This is what
 * makes Grail detection work unattended: the refresh token itself never touches the API,
 * so there's nothing to manually refresh before each sync run.
 */
async function getUserAccessToken(clientId, clientSecret, refreshToken) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchWithRetry("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Refresh token exchange missing access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function searchAllItemIds(token, seller) {
  const itemIds = [];
  let offset = 0;

  while (true) {
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    // The Browse API rejects a bare `sellers` filter (errorId 12001): it requires
    // one of q/category_ids/charity_ids/epid/gtin too. A whitespace `q` satisfies
    // that requirement without narrowing results, leaving `sellers` as the only
    // real filter.
    url.searchParams.set("q", " ");
    url.searchParams.set("filter", `sellers:{${seller}}`);
    url.searchParams.set("limit", String(SEARCH_LIMIT));
    url.searchParams.set("offset", String(offset));

    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      },
    });
    const data = await res.json();
    const page = data.itemSummaries ?? [];

    for (const item of page) {
      itemIds.push(item.itemId);
    }

    if (page.length < SEARCH_LIMIT) break;
    offset += SEARCH_LIMIT;
  }

  return itemIds;
}

async function fetchItemDetail(token, itemId) {
  const url = `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    },
  });
  return res.json();
}

// The "Featured" eBay Store Category, per its numeric ID (eBay's GetItem response only
// ever returns StoreCategoryID/StoreCategory2ID -- never a name string -- so matching has
// to be by ID, not by regex against category text). Overridable via env in case the store
// category ever gets recreated with a different ID.
const FEATURED_STORE_CATEGORY_ID = process.env.EBAY_FEATURED_CATEGORY_ID || "4259660619";

/**
 * Store Category IDs (e.g. a seller-defined "Featured" category) aren't exposed by the
 * public Browse API — only by the legacy Trading API, authenticated as the seller via a
 * short-lived user access token (minted from EBAY_REFRESH_TOKEN in main(), see
 * getUserAccessToken). This is optional enrichment: a missing/expired/revoked refresh
 * token just disables Grail detection without breaking the core sync, so failures here
 * are logged and swallowed rather than aborting the whole run.
 */
async function getStoreCategoryIds(userToken, legacyItemId) {
  if (!userToken || !legacyItemId) return [];

  // OAuth user tokens authenticate to the Trading API via the X-EBAY-API-IAF-TOKEN header,
  // not the legacy RequesterCredentials/eBayAuthToken XML field (that's for old Auth'n'Auth
  // tokens only, and rejects OAuth tokens with a generic "Invalid IAF token" error).
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${legacyItemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

  try {
    const res = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-IAF-TOKEN": userToken,
      },
      body,
    });
    const xml = await res.text();
    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      const message = xml.match(/<LongMessage>([^<]*)<\/LongMessage>/)?.[1] ?? "unknown error";
      throw new Error(message);
    }
    return [...xml.matchAll(/<StoreCategoryID>([^<]*)<\/StoreCategoryID>|<StoreCategory2ID>([^<]*)<\/StoreCategory2ID>/g)]
      .map((m) => m[1] || m[2])
      .filter((id) => id && id !== "0");
  } catch (err) {
    console.error(`Store category lookup failed for item ${legacyItemId} (Grail detection skipped): ${err.message ?? err}`);
    return [];
  }
}

/** Runs fn over items with a bounded number of concurrent in-flight calls. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Buckets eBay's own category taxonomy into the brand's 3 bands. */
function categorize(categoryPath) {
  const path = (categoryPath ?? "").toLowerCase();
  if (path.includes("comic")) return "Comics";
  if (path.includes("trading card") || path.includes("sports card")) return "Trading Cards";
  return "Memorabilia";
}

const JUST_IN_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

function normalizeItem(detail, storeCategoryIds) {
  const images = [];
  if (detail.image?.imageUrl) images.push(detail.image.imageUrl);
  for (const extra of detail.additionalImages ?? []) {
    if (extra.imageUrl) images.push(extra.imageUrl);
  }

  const specifics = {};
  for (const aspect of detail.localizedAspects ?? []) {
    if (aspect.name && aspect.value !== undefined) {
      specifics[aspect.name] = aspect.value;
    }
  }

  const createdAt = detail.itemCreationDate ?? null;
  const justIn = createdAt !== null && Date.now() - new Date(createdAt).getTime() <= JUST_IN_WINDOW_MS;
  const grail = storeCategoryIds.includes(FEATURED_STORE_CATEGORY_ID);

  return {
    id: detail.itemId,
    title: detail.title,
    price: Number(detail.price?.value),
    currency: detail.price?.currency ?? "USD",
    condition: detail.condition ?? null,
    category: categorize(detail.categoryPath),
    images,
    description: stripHtml(detail.shortDescription ?? detail.description ?? ""),
    specifics,
    itemWebUrl: detail.itemWebUrl,
    createdAt,
    justIn,
    grail,
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const clientId = requireEnv("EBAY_CLIENT_ID");
  const clientSecret = requireEnv("EBAY_CLIENT_SECRET");
  const seller = requireEnv("EBAY_SELLER");
  const refreshToken = process.env.EBAY_REFRESH_TOKEN || null;

  console.log("Requesting OAuth token...");
  const token = await getAccessToken(clientId, clientSecret);

  // Optional enrichment: mint a short-lived user access token from the long-lived refresh
  // token once per run. Never blocks the core sync -- a missing/expired/revoked refresh
  // token just disables Grail detection for this run, logged but non-fatal.
  let userToken = null;
  if (refreshToken) {
    try {
      userToken = await getUserAccessToken(clientId, clientSecret, refreshToken);
    } catch (err) {
      console.error(`Refresh token exchange failed (Grail detection disabled for this run): ${err.message ?? err}`);
    }
  }

  console.log(`Searching listings for seller "${seller}"...`);
  const itemIds = await searchAllItemIds(token, seller);
  console.log(`Found ${itemIds.length} item id(s).`);

  console.log(
    `Fetching item detail (concurrency ${DETAIL_CONCURRENCY})${userToken ? ", including Store Category for Grail detection" : ""}...`
  );
  const results = await mapWithConcurrency(itemIds, DETAIL_CONCURRENCY, async (itemId) => {
    const detail = await fetchItemDetail(token, itemId);
    const storeCategoryIds = await getStoreCategoryIds(userToken, detail.legacyItemId);
    return { detail, storeCategoryIds };
  });

  const products = results.map(({ detail, storeCategoryIds }) => normalizeItem(detail, storeCategoryIds));
  products.sort((a, b) => a.title.localeCompare(b.title));

  if (products.length === 0) {
    throw new Error(
      "Fetched 0 products but the API returned success. This is almost certainly a filter/header bug, not a real empty catalog — refusing to write products.json."
    );
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(products, null, 2) + "\n", "utf8");
  console.log(`Wrote ${products.length} product(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("fetch-ebay failed:", err.message ?? err);
  process.exit(1);
});
