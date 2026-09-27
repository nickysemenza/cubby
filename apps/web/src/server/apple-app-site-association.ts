import {
  LEGACY_SHORTCODE_PREFIX,
  LEGACY_SHORTCODE_BODY_LENGTH,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_PREFIX,
  SHORTCODE_TYPES,
} from "@cubby/shared";

import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";

/**
 * Apple's team/bundle pair for universal links and shared web credentials. Kept as one named
 * constant so the two AASA services cannot drift — see
 * `apps/apple/project.yml` (`DEVELOPMENT_TEAM: Y9A97FXT63`,
 * `PRODUCT_BUNDLE_IDENTIFIER: com.nickysemenza.cubby`) for the source of truth.
 */
const APPLE_APP_ID = "Y9A97FXT63.com.nickysemenza.cubby";

const BODY_PLACEHOLDERS = [
  "?".repeat(LEGACY_SHORTCODE_BODY_LENGTH),
  "?".repeat(SHORTCODE_BODY_LENGTH),
];

interface AasaComponent {
  "/": string;
  comment?: string;
}

/**
 * Both accepted body lengths for each canonical and legacy prefix. Printed
 * four-character labels and newly minted five-character codes both deep-link.
 */
function shortcodeComponents(): AasaComponent[] {
  const canonical = Object.entries(SHORTCODE_PREFIX).flatMap(([type, prefix]) =>
    BODY_PLACEHOLDERS.map((body) => ({
      "/": `/${prefix}${body}`,
      comment: type,
    })),
  );

  const legacy = Object.entries(LEGACY_SHORTCODE_PREFIX).flatMap(
    ([prefix, type]) =>
      BODY_PLACEHOLDERS.map((body) => ({
        "/": `/${prefix}${body}`,
        comment: `${type} (legacy)`,
      })),
  );

  return [...canonical, ...legacy];
}

/**
 * Both body lengths for every routed entity, so old and new detail links open
 * in the app. `generatedBrowserRoutes` is the generated route lookup.
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
    for (const body of BODY_PLACEHOLDERS) {
      components.push({
        "/": `/${route.basePath}/${SHORTCODE_PREFIX[type]}${body}`,
        comment: `${type} detail`,
      });
    }
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
    webcredentials: {
      apps: [APPLE_APP_ID],
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
