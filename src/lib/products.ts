export type Category = "Comics" | "Trading Cards" | "Memorabilia";

export interface Product {
  id: string;
  title: string;
  price: number;
  currency: string;
  condition: string | null;
  category: Category;
  images: string[];
  description: string;
  specifics: Record<string, string>;
  itemWebUrl: string;
  createdAt: string | null;
  justIn: boolean;
  grail: boolean;
  updatedAt: string;
}

export interface Chip {
  label: string;
  bg: string;
  fg: string;
}

/** Band color per category, plus the text color that stays legible on it
 *  (brand rule: red/blue take white text, mint/gold/pink take ink). */
export const CATEGORY_BAND: Record<Category, { bg: string; fg: string }> = {
  Comics: { bg: "var(--reed-red)", fg: "#ffffff" },
  "Trading Cards": { bg: "var(--vault-blue)", fg: "#ffffff" },
  Memorabilia: { bg: "var(--mint)", fg: "var(--ink)" },
};

export const CATEGORY_SLUG: Record<Category, string> = {
  Comics: "comics",
  "Trading Cards": "cards",
  Memorabilia: "memorabilia",
};

/** Inline SVG path data per category, drawn in currentColor (from the brand's icon set). */
export const CATEGORY_ICON: Record<Category, string> = {
  Comics:
    '<path d="M12 6.5C10 5 7 5 4 5.6V18.4C7 17.8 10 17.8 12 19.3"/><path d="M12 6.5C14 5 17 5 20 5.6V18.4C17 17.8 14 17.8 12 19.3"/><line x1="12" y1="6.5" x2="12" y2="19.3"/>',
  "Trading Cards": '<rect x="6" y="4" width="12" height="16" rx="2"/><line x1="6" y1="13" x2="18" y2="13"/>',
  Memorabilia:
    '<path d="M8.5 4 4 6.5 2.6 10 6 11.6 6.5 10.2V20a.5 .5 0 0 0 .5 .5H17a.5 .5 0 0 0 .5-.5V10.2L18 11.6 21.4 10 20 6.5 15.5 4C14.8 5.5 9.2 5.5 8.5 4Z"/>',
};

/** A real, honest status signal only — every value here is sourced from eBay data,
 *  never inferred/fabricated. Priority: curated (Grail) > recency (Just in).
 *  ("Last one" was removed: nearly every listing here is a unique 1-of-1 item, so
 *  estimatedAvailableQuantity === 1 was true for almost everything and never actually
 *  differentiated anything — it just cluttered every card.) */
export function chipOf(product: Pick<Product, "grail" | "justIn">): Chip | null {
  if (product.grail) return { label: "Grail", bg: "var(--foil-gold)", fg: "var(--ink)" };
  if (product.justIn) return { label: "Just in", bg: "var(--bubblegum)", fg: "var(--ink)" };
  return null;
}

/** eBay CDN URLs encode size in the filename suffix (e.g. s-l225.jpg, s-l1600.jpg). */
export function resizeImage(url: string, size: "s-l500" | "s-l1600"): string {
  return url.replace(/s-l\d+\.jpg$/i, `${size}.jpg`);
}

export function formatPrice(price: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(price);
}

/** eBay itemIds look like "v1|306599018770|0" — "|" is not a safe bare URL/sitemap
 *  character, so routes use a hyphenated slug instead of the raw id. */
export function itemSlug(id: string): string {
  return id.replace(/\|/g, "-");
}

export function itemPath(id: string): string {
  return `/item/${itemSlug(id)}/`;
}

/** Union of all specifics keys and their distinct values, sorted, for facet filter UI. */
export function buildFacets(products: Product[]): [string, string[]][] {
  const facets = new Map<string, Set<string>>();
  for (const product of products) {
    for (const [key, value] of Object.entries(product.specifics)) {
      if (!facets.has(key)) facets.set(key, new Set());
      facets.get(key)!.add(value);
    }
  }
  return [...facets.entries()]
    .map(([key, values]): [string, string[]] => [key, [...values].sort((a, b) => a.localeCompare(b))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}
