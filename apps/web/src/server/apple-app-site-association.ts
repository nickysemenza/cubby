import {
  LEGACY_SHORTCODE_PREFIX,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_PREFIX,
  SHORTCODE_TYPES,
} from "@cubby/shared";

import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";

/**
 * Apple's universal-link team/bundle pair. Kept as one named constant because
 * it appears once here and nowhere else server-side — see
 * `apps/apple/project.yml` (`DEVELOPMENT_TEAM: Y9A97FXT63`,
 * `PRODUCT_BUNDLE_IDENTIFIER: com.nickysemenza.cubby`) for the source of truth.
 */
const APPLE_APP_ID = "Y9A97FXT63.com.nickysemenza.cubby";

// A shortcode body is fixed-length over a closed alphabet (see
// shortcode-alphabet.ts), so "one `?` per body character" is exact — never a
// hardcoded 4.
const BODY_PLACEHOLDER = "?".repeat(SHORTCODE_BODY_LENGTH);

interface AasaComponent {
  "/": string;
  comment?: string;
}

/**
 * One `/<PREFIX>????` component per canonical shortcode prefix (what a
 * printed label QR code actually encodes, per `getShortcodeUrl`), plus one
 * `/<PREFIX>????` component per legacy single-letter prefix still out on old
 * location/product labels. Deliberately no catch-all `/*` component: every
 * other web URL must keep opening in Safari, not the app.
 */
function shortcodeComponents(): AasaComponent[] {
  const canonical = Object.entries(SHORTCODE_PREFIX).map(([type, prefix]) => ({
    "/": `/${prefix}${BODY_PLACEHOLDER}`,
    comment: type,
  }));

  const legacy = Object.entries(LEGACY_SHORTCODE_PREFIX).map(
    ([prefix, type]) => ({
      "/": `/${prefix}${BODY_PLACEHOLDER}`,
      comment: `${type} (legacy)`,
    }),
  );

  return [...canonical, ...legacy];
}

/**
 * One `/<basePath>/<PREFIX>????` component per entity that has a web detail
 * route, so a shortcode a viewer navigated to inside the web app (rather than
 * scanned raw off a label) still deep-links. `generatedBrowserRoutes` is a
 * plain generated lookup keyed by entity name, so this stays a cheap map —
 * no per-entity branching to maintain.
 */
function detailRouteComponents(): AasaComponent[] {
  const components: AasaComponent[] = [];
  // SHORTCODE_TYPES is already ShortcodeType[] (no Object.entries widening to
  // string), and every one of its members is a literal key of
  // generatedBrowserRoutes (both are generated from the same entity roster),
  // so this indexes without a cast.
  for (const type of SHORTCODE_TYPES) {
    const route = generatedBrowserRoutes[type];
    if (!route) continue;
    components.push({
      "/": `/${route.basePath}/${SHORTCODE_PREFIX[type]}${BODY_PLACEHOLDER}`,
      comment: `${type} detail`,
    });
  }
  return components;
}

/** Pure builder for the AASA document — kept separate from the Response so the shape is unit-testable without a fetch handler. */
export function buildAppleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: [APPLE_APP_ID],
          components: [...shortcodeComponents(), ...detailRouteComponents()],
        },
      ],
    },
  };
}

/**
 * Serves the AASA document. iOS/macOS fetch this unauthenticated, over HTTPS,
 * from the site root — no CORS needed (it's a same-origin OS fetch, not a
 * browser one), unlike the OAuth discovery documents next to this file.
 */
export function GET() {
  return new Response(JSON.stringify(buildAppleAppSiteAssociation()), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
