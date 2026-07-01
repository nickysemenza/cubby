import type { WScrapedRecipe } from "@cubby/recipebridge";
import { sanitizeSectionName } from "@cubby/schemas/codec";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { wasm } from "~/lib/wasm";

const isChefStepsHost = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "chefsteps.com" || host === "www.chefsteps.com";
  } catch {
    return false;
  }
};

// Hostnames that always name the local machine, regardless of DNS.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

// Is a literal IPv4 dotted-quad in a private / loopback / link-local range?
// (10/8, 127/8, 169.254/16 incl. the 169.254.169.254 cloud-metadata address,
// 172.16/12, 192.168/16, and 0.0.0.0.)
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// Is a literal IPv6 address loopback / link-local / unique-local?
// URL hostnames arrive already normalized (lowercased, brackets stripped by
// new URL().hostname → but we re-strip defensively).
function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  // Unique-local fc00::/7 (fc.. and fd..).
  if (/^f[cd]/.test(h)) return true;
  // IPv4-mapped (::ffff:169.254.169.254 etc.) — reuse the v4 check on the tail.
  const tail = h.split(":").pop();
  if (tail?.includes(".") && isPrivateIPv4(tail)) return true;
  return false;
}

/**
 * Guard the server-side scrape fetch against SSRF. The scrape runs from the
 * trusted Worker context, and the URL is fully user-controlled (a shared link or
 * the "Import from URL" entry point can auto-fire the fetch on page load), so a
 * crafted URL must not be able to reach internal/metadata addresses.
 *
 * This is a proportional literal-host check for a single-user app: it rejects
 * non-http(s) schemes and hostnames that literally are (or, for localhost/.local,
 * name) private/loopback/link-local/metadata targets. It intentionally does NOT
 * defend against DNS rebinding (a public hostname resolving to a private IP) or
 * an HTTP redirect to an internal address — closing those needs resolve-then-pin
 * and redirect interception, which is overkill here. Throws so getErrorMessage
 * surfaces the reason in the existing scrape-failure toast.
 */
export function assertScrapableUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Only http(s) URLs can be scraped (got ${parsed.protocol}).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local")) {
    throw new Error(`Refusing to scrape a local address: ${host}`);
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    throw new Error(`Refusing to scrape a private/internal address: ${host}`);
  }
}

const scrapeRecipe = async (url: string) => {
  if (isChefStepsHost(url)) {
    // transform https://www.chefsteps.com/activities/rich-and-moist-cornbread
    // into https://www.chefsteps.com/api/v0/activities/rich-and-moist-cornbread
    const activityId = url.split("/").pop();
    url = `https://www.chefsteps.com/api/v0/activities/${activityId}`;
  }
  // SSRF guard runs on the final URL (post-chefsteps-rewrite), before the fetch.
  assertScrapableUrl(url);
  const response = await fetch(url, { method: "GET" });
  const html = await response.text();
  // Note: wasm.parse_scraped_recipe already has tracing via the wasm proxy
  return wasm.parse_scraped_recipe(html, url);
};

export const scrapeToImportRecipe = async (
  url: string,
): Promise<ImportRecipe> => {
  const scraped = await scrapeRecipe(url);
  return scrapedToImportRecipe(scraped);
};

// Parse-only path for pasted HTML — skips the server fetch (which some sites
// block) and runs the same WASM parser + converter as a URL scrape. `url` is
// required: it's the source provenance kept on the recipe and is also used by
// the parser to resolve relative image/source links.
export const htmlToImportRecipe = (html: string, url: string): ImportRecipe =>
  scrapedToImportRecipe(wasm.parse_scraped_recipe(html, url));

// The scraper's WASM output → the shared `ImportRecipe` carrier. Yield arrives
// already structured (`{value, unit}`) — the union's object branch; the import
// converter uses it directly without re-parsing.
export const scrapedToImportRecipe = (w: WScrapedRecipe): ImportRecipe => {
  return {
    meta: {
      title: w.name ?? "",
      description: w.description,
      recipe_yield: w.recipe_yield,
    },
    sections: w.sections.map((section) => ({
      name: sanitizeSectionName(section.name) ?? undefined,
      ingredients: section.ingredients,
      instructions: section.instructions,
    })),
    references: [],
    servings: w.servings,
    image: w.image,
    // Carried for provenance; the converter doesn't store it yet (see docs/todos).
    url: w.url,
  };
};
