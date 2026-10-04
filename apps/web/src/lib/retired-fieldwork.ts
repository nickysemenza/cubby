import { locationShortcode } from "@cubby/schemas/identifiers";

/**
 * Barcode/QR scanning, the location recount session (with its sweep), and the
 * location photo pass are native-app workflows; their web routes remain only
 * as redirects so old bookmarks, home-screen shortcuts, and links in notes
 * land on a surviving page instead of a 404.
 *
 * The "moved" notice rides in the URL fragment: it survives the server-side
 * redirect (a fragment is never sent to the server, so the Location header
 * carries it through) and never reaches a route's search validation.
 */
const RETIRED_FIELDWORK_HASH_PREFIX = "moved-to-app:";

const NOTICES = {
  scan: "Scanning moved to the Cubby app. Use it to look up or add a product and to identify a label.",
  recount:
    "Recounts moved to the Cubby app. Open this location there to recount and sweep it.",
  "photo-pass":
    "The location photo pass moved to the Cubby app. Photos can still be added from any location here.",
} as const;

type RetiredFieldwork = keyof typeof NOTICES;

const hashFor = (kind: RetiredFieldwork) =>
  `${RETIRED_FIELDWORK_HASH_PREFIX}${kind}`;

export type RetiredFieldworkTarget =
  | { to: "/"; hash: string }
  | { to: "/inventory"; hash: string }
  | { to: "/locations"; hash: string }
  | {
      to: "/locations/$shortcode";
      params: { shortcode: string };
      hash: string;
    };

function locationOrFallback(
  parent: string | undefined,
  kind: RetiredFieldwork,
  fallback: "/inventory" | "/locations",
): RetiredFieldworkTarget {
  const parsed = locationShortcode.safeParse(parent);
  return parsed.success
    ? {
        to: "/locations/$shortcode",
        params: { shortcode: parsed.data },
        hash: hashFor(kind),
      }
    : { to: fallback, hash: hashFor(kind) };
}

export function retiredScanTarget(): RetiredFieldworkTarget {
  return { to: "/", hash: hashFor("scan") };
}

/** `/inventory/session`: a recount rooted at `parent`, or a saved-view worklist. */
export function retiredRecountTarget(search: {
  parent?: string;
  worklist?: string;
}): RetiredFieldworkTarget {
  return locationOrFallback(search.parent, "recount", "/inventory");
}

/** `/locations/photo-pass`: a walk scoped to `parent`'s descendants, or the house. */
export function retiredPhotoPassTarget(search: {
  parent?: string;
}): RetiredFieldworkTarget {
  return locationOrFallback(search.parent, "photo-pass", "/locations");
}

/** The notice for a redirect fragment (no leading `#`), or null for any other hash. */
export function retiredFieldworkNotice(hash: string): string | null {
  if (!hash.startsWith(RETIRED_FIELDWORK_HASH_PREFIX)) return null;
  const kind = hash.slice(RETIRED_FIELDWORK_HASH_PREFIX.length);
  return Object.entries(NOTICES).find(([key]) => key === kind)?.[1] ?? null;
}
