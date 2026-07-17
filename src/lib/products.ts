export type Category = "Comics" | "Sports Cards" | "Memorabilia";

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
  updatedAt: string;
}

/** Band color per category, plus the text color that stays legible on it
 *  (brand rule: red/blue take white text, mint/gold/pink take ink). */
export const CATEGORY_BAND: Record<Category, { bg: string; fg: string }> = {
  Comics: { bg: "var(--reed-red)", fg: "#ffffff" },
  "Sports Cards": { bg: "var(--vault-blue)", fg: "#ffffff" },
  Memorabilia: { bg: "var(--mint)", fg: "var(--ink)" },
};

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
