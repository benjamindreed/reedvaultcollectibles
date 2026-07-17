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
  if (path.includes("trading card") || path.includes("sports card")) return "Sports Cards";
  return "Memorabilia";
}

function normalizeItem(detail) {
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
    updatedAt: new Date().toISOString(),
  };
}

async function main() {
  const clientId = requireEnv("EBAY_CLIENT_ID");
  const clientSecret = requireEnv("EBAY_CLIENT_SECRET");
  const seller = requireEnv("EBAY_SELLER");

  console.log("Requesting OAuth token...");
  const token = await getAccessToken(clientId, clientSecret);

  console.log(`Searching listings for seller "${seller}"...`);
  const itemIds = await searchAllItemIds(token, seller);
  console.log(`Found ${itemIds.length} item id(s).`);

  console.log(`Fetching item detail (concurrency ${DETAIL_CONCURRENCY})...`);
  const details = await mapWithConcurrency(itemIds, DETAIL_CONCURRENCY, (itemId) =>
    fetchItemDetail(token, itemId)
  );

  const products = details.map(normalizeItem);
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
