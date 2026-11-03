import type { ShipmentId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { MailReadContent } from "@cubby/schemas/mailbox-research";
import type {
  RetainedShipmentEvidence,
  ShipmentCarrierClaim,
} from "@cubby/schemas/shipment-evidence";
import { SHIPMENT_IDENTITY_PERIOD_DAYS } from "@cubby/schemas/shipment-fields";
import { and, eq, isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  vendor,
  email,
  shipmentSourceCapture,
  shipmentSourcePackage,
} from "~/server/db/retained-tables";
import { shipmentCarrierEvidence } from "~/server/domains/shipment/repo/carrier-packets";
import { vendorNamedSql } from "~/server/domains/vendor/repo/vendor-name-match";
import { wasm } from "~/server/wasm";

export const normalizeCarrierReference = (value: string) =>
  value.replaceAll(/\s/g, "").toUpperCase();

/** Exact existing identities only: carrier evidence must never create a brand Vendor. */
export async function resolveCarrierName(db: Database, name: string | null) {
  if (!name?.trim()) return null;
  const rows = await getDb(db)
    .select({
      id: vendor.id,
      shortcode: vendor.shortcode,
      name: vendor.name,
      aliases: vendor.aliases,
    })
    .from(vendor)
    .where(and(notDeleted(vendor), vendorNamedSql(name.trim())));
  const row = rows.length === 1 ? rows[0] : undefined;
  return row
    ? { ...row, code: parseShortcodeFor("vendor", row.shortcode) }
    : null;
}

const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const referencePattern = (value: string) =>
  `(?<![a-z0-9_-])${[...normalizeCarrierReference(value)].map(escapePattern).join("\\s*")}(?![a-z0-9_-])`;

/** Verify positive package attribution, not just a brand and number in the same excerpt. */
export function retainedCarrierClaim(
  claim: ShipmentCarrierClaim,
  content: string,
) {
  if (
    claim.role !== "carrier" ||
    (claim.evidence.kind !== "statement" && claim.evidence.kind !== "label")
  )
    return false;
  const quote = claim.evidence.quote;
  if (
    quote.length > 500 ||
    !content.includes(quote) ||
    !new RegExp(
      `(?<![a-z0-9_-])${escapePattern(quote)}(?![a-z0-9_-])`,
      "i",
    ).test(content)
  )
    return false;
  // A URL supplies no attribution by itself, even when submitted as a statement/label.
  const reference = referencePattern(claim.trackingNumber);
  // A selected excerpt cannot clip the negation from its enclosing source statement.
  const offset = content.indexOf(quote);
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  const after = content.indexOf("\n", offset + quote.length);
  const context = content.slice(
    lineStart,
    after === -1 ? content.length : after,
  );
  if (context.length > 1500) return false;
  const attributionText = context
    .replace(/https?:\/\/\S+/gi, "")
    .replace(new RegExp(reference, "gi"), "");
  if (
    /\b(?:not|never|neither|wrong|incorrect|example|sample|instead|except|formerly|previously)\b/i.test(
      attributionText,
    )
  )
    return false;
  const name = escapePattern(claim.carrierName).replaceAll(/\s+/g, "\\s+");
  const service = claim.service
    ? `(?:\\s+${escapePattern(claim.service).replaceAll(/\s+/g, "\\s+")})?`
    : "";
  const carrier = `(?<![a-z0-9_-])${name}${service}(?![a-z0-9_-])`;
  const tracking = `(?:tracking(?:\\s*(?:number|no\\.?|id))?\\s*[:#]?|trk\\s*#)\\s*${reference}`;
  // Only complete, bounded attribution statements authorize writes. A clipped
  // quote such as "UPS tracking …" inside "Maybe UPS tracking …" is not proof.
  const separator = "[\\s;,.·:—-]+";
  const attribution = `(?:(?:shipping\\s+)?carrier\\s*:\\s*|(?:shipped|shipping|delivered|delivery|sent|dispatched)\\s+(?:via|with|by)\\s+)?${carrier}`;
  return new RegExp(
    `^\\s*${attribution}${separator}${tracking}\\s*[.;]?\\s*$`,
    "i",
  ).test(context);
}

type CarrierSourceEvidence = Pick<MailReadContent, "links"> & {
  texts: readonly string[];
};

export async function assessCarrierPacket(
  db: Database,
  packet: RetainedShipmentEvidence,
  source: CarrierSourceEvidence,
) {
  const references = new Set(
    [
      packet.trackingNumber,
      ...packet.extraTrackingNumbers.map((ref) => ref.trackingNumber),
    ]
      .filter((number) => number !== null)
      .map(normalizeCarrierReference),
  );
  const claims = packet.carrierClaims ?? [];
  const explicit: {
    claim: ShipmentCarrierClaim;
    carrier: Awaited<ReturnType<typeof resolveCarrierName>>;
  }[] = [];
  for (const claim of claims) {
    if (
      claim.role !== "carrier" ||
      !references.has(normalizeCarrierReference(claim.trackingNumber))
    )
      continue;
    const carrier = await resolveCarrierName(db, claim.carrierName);
    if (claim.evidence.kind === "link") {
      const href = claim.evidence.href;
      if (!source.links.some((link) => link.href === href)) continue;
      const named = carrierTrackingLink(
        claim.evidence.href,
        claim.trackingNumber,
      );
      const linkCarrier = named ? await resolveCarrierName(db, named) : null;
      if (!linkCarrier || carrier?.id !== linkCarrier.id) continue;
    } else {
      if (!source.texts.some((text) => retainedCarrierClaim(claim, text)))
        continue;
      if (
        (claim.evidence.kind === "statement" ||
          claim.evidence.kind === "label") &&
        [...references].some(
          (number) =>
            number !== normalizeCarrierReference(claim.trackingNumber) &&
            normalizeCarrierReference(
              claim.evidence.kind === "statement" ||
                claim.evidence.kind === "label"
                ? claim.evidence.quote
                : "",
            ).includes(number),
        )
      )
        continue;
    }
    explicit.push({ claim, carrier });
  }
  const forReference = (number: string | null) => {
    const matches = explicit.filter(
      ({ claim }) =>
        number !== null &&
        normalizeCarrierReference(claim.trackingNumber) ===
          normalizeCarrierReference(number),
    );
    const ids = new Set(
      matches.map(
        ({ carrier, claim }) =>
          carrier?.id ?? `unresolved:${claim.carrierName.trim().toLowerCase()}`,
      ),
    );
    return {
      carrier: ids.size === 1 ? (matches[0]?.carrier ?? null) : null,
      conflict: ids.size > 1,
    };
  };
  return {
    explicit,
    primary: forReference(packet.trackingNumber),
    forReference,
  };
}

// Carrier identity and aliases remain Vendors. Only advisory published-format knowledge lives here.
const carrierFormatRules = [
  {
    name: "UPS",
    names: ["ups", "united parcel service"],
    source: "https://www.ups.com/us/en/support/tracking-support",
    matches: (number: string) =>
      /^(1Z[A-Z0-9]{16}|T\d{10}|\d{9}|\d{12})$/.test(number),
  },
  {
    name: "FedEx",
    names: ["fedex", "federal express", "fedex ground", "fedex ground economy"],
    source: "https://developer.fedex.com/api/en-us/catalog/ship/docs.html",
    matches: (number: string) => /^\d{12}$/.test(number),
  },
];

/** Advisory coverage only; matching a Vendor's name/aliases never establishes or excludes identity. */
export function carrierFormatEvidence(
  number: string,
  vendorNames: readonly string[] = [],
) {
  const names = new Set(vendorNames.map((name) => name.trim().toLowerCase()));
  const applicable = vendorNames.length
    ? carrierFormatRules.filter((rule) =>
        rule.names.some((name) => names.has(name)),
      )
    : carrierFormatRules;
  const matched = applicable.filter((rule) =>
    rule.matches(normalizeCarrierReference(number)),
  );
  return {
    outcome:
      matched.length > 1
        ? "ambiguous_match"
        : matched.length === 1
          ? "documented_match"
          : "unsupported_format",
    carriers: matched.map((rule) => rule.name),
    sources: applicable.map((rule) => rule.source),
  };
}

/** Package-level references remain available even when individual events omit them. */
export const carrierPacketReferenceSql = (
  packet: SQLWrapper,
  number: string,
) => sql`(
  upper(regexp_replace(${packet}->>'trackingNumber', '[[:space:]]', '', 'g')) = ${normalizeCarrierReference(number)}
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${packet}->'extraTrackingNumbers', '[]'::jsonb)) ref
    WHERE upper(regexp_replace(ref->>'trackingNumber', '[[:space:]]', '', 'g')) = ${normalizeCarrierReference(number)})
)`;

/** Unresolved literal names are evidence too; lack of a Vendor must not hide a conflict. */
export function carrierClaimsConflict(
  claims: Awaited<ReturnType<typeof assessCarrierPacket>>["explicit"],
) {
  const byReference = new Map<string, Set<string>>();
  for (const { claim, carrier } of claims) {
    const number = normalizeCarrierReference(claim.trackingNumber);
    const identities = byReference.get(number) ?? new Set<string>();
    identities.add(
      carrier?.id ?? `unresolved:${claim.carrierName.trim().toLowerCase()}`,
    );
    byReference.set(number, identities);
  }
  return [...byReference.values()].some((identities) => identities.size > 1);
}

/** Only links in the checksum-verified Email original are independent URL evidence.
 * The submitted tracking-page URL and strings synthesized during extraction are not.
 */
export function carrierCaptureEvidence(
  capture: Pick<
    typeof shipmentSourceCapture.$inferSelect,
    "source" | "originalContent"
  >,
): CarrierSourceEvidence {
  if (capture.source.kind !== "email")
    return {
      texts: [
        capture.source.content,
        wasm.compact_email_html(capture.source.content).text,
      ],
      links: [],
    };
  const original = capture.originalContent;
  const compact = original?.bodyHtml
    ? wasm.compact_email_html(original.bodyHtml)
    : null;
  const texts = [original?.bodyText ?? "", compact?.text ?? ""].filter(Boolean);
  const plainLinks = [
    ...(original?.bodyText ?? "").matchAll(/https?:\/\/[^\s<>"']+/g),
  ].map(([href]) => ({ href, text: "" }));
  return {
    texts,
    links: [...(compact?.links ?? []), ...plainLinks],
  };
}

/** Bounded documented/public tracking routes, not a number-format or existence check.
 * FedEx's published fulfillment example: developer-sandbox.supplychain.fedex.com/sandbox/getorder.
 * UPS's public tracker: www.ups.com/track. Unsupported routes remain unproven.
 */
function carrierTrackingLink(
  href: string,
  number: string,
): "UPS" | "FedEx" | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const keys =
    host === "ups.com" && /^\/track\/?$/.test(url.pathname)
      ? ["tracknum"]
      : host === "fedex.com" &&
          /^\/(?:apps\/)?fedextrack\/?$/.test(url.pathname)
        ? ["trknbr", "tracknumbers"]
        : [];
  const values = keys.flatMap((key) => url.searchParams.getAll(key));
  if (
    values.length !== 1 ||
    normalizeCarrierReference(values[0] ?? "") !==
      normalizeCarrierReference(number)
  )
    return null;
  return host === "ups.com" ? "UPS" : host === "fedex.com" ? "FedEx" : null;
}

const carrierHistoryWindow = z.object({
  id: z.uuid(),
  first: z.string().nullable(),
  last: z.string().nullable(),
});

/** Include retained unresolved claims for the same reference/period, not only admitted bindings. */
export async function loadCarrierHistory(
  db: Database,
  scope: { references: readonly string[] } & (
    | { shipmentId: ShipmentId }
    | { window: Omit<z.infer<typeof carrierHistoryWindow>, "id"> }
  ),
) {
  const database = getDb(db);
  const shipmentId = "shipmentId" in scope ? scope.shipmentId : null;
  const current = shipmentId
    ? await database.execute(
        sql`SELECT first_day::text AS first, last_day::text AS last FROM shipment_identity_window(${shipmentId}::uuid)`,
      )
    : null;
  const window = carrierHistoryWindow
    .omit({ id: true })
    .parse("window" in scope ? scope.window : current?.rows[0]);
  const rows = await database
    .select({
      id: shipmentCarrierEvidence.id,
      packet: shipmentCarrierEvidence.packet,
      source: shipmentSourceCapture.source,
      originalContent: shipmentSourceCapture.originalContent,
      boundShipmentId: shipmentSourcePackage.shipmentId,
      receivedAt: email.receivedAt,
    })
    .from(shipmentCarrierEvidence)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentCarrierEvidence.captureId),
    )
    .leftJoin(
      shipmentSourcePackage,
      and(
        eq(shipmentSourcePackage.sourceKey, shipmentSourceCapture.sourceKey),
        eq(
          shipmentSourcePackage.packageKey,
          shipmentCarrierEvidence.packageKey,
        ),
      ),
    )
    .leftJoin(email, eq(email.id, shipmentSourceCapture.emailId))
    .where(
      or(
        shipmentId
          ? eq(shipmentSourcePackage.shipmentId, shipmentId)
          : undefined,
        and(
          isNull(shipmentSourcePackage.id),
          or(
            ...scope.references.map((number) =>
              carrierPacketReferenceSql(shipmentCarrierEvidence.packet, number),
            ),
          ),
        ),
      ),
    )
    .limit(2001);
  const selected = rows.slice(0, 2000);
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- time and fallback are keys in the bounded source-event JSON payload, not enum values.
  const windows = await database.execute(sql`SELECT p->>'id' AS id,
    coalesce(min(shipment_event_day(event)), shipment_event_day(jsonb_build_object('time', p->'fallback')))::text AS first,
    coalesce(max(shipment_event_day(event)), shipment_event_day(jsonb_build_object('time', p->'fallback')))::text AS last
    FROM jsonb_array_elements(${JSON.stringify(
      selected.map((row) => ({
        id: row.id,
        events: row.packet.observations,
        fallback:
          row.source.kind === "email" && row.receivedAt
            ? { kind: "instant", value: row.receivedAt.toISOString() }
            : row.source.kind === "sms_export"
              ? row.source.sentAt
              : { kind: "unknown" },
      })),
    )}::jsonb) p CROSS JOIN LATERAL jsonb_array_elements(p->'events') event GROUP BY p`);
  const periods = z.array(carrierHistoryWindow).parse(windows.rows);
  const packets = selected.filter((row) => {
    if (shipmentId && row.boundShipmentId === shipmentId) return true;
    const period = periods.find((period) => period.id === row.id);
    if (!period?.first || !period.last || !window.first || !window.last)
      return true;
    const days = [period.first, period.last, window.first, window.last].map(
      (day) => Date.parse(day),
    );
    return (
      Math.max(...days) - Math.min(...days) <=
      SHIPMENT_IDENTITY_PERIOD_DAYS * 86400000
    );
  });
  const claims: Awaited<ReturnType<typeof assessCarrierPacket>>["explicit"] =
    [];
  for (const row of packets)
    claims.push(
      ...(
        await assessCarrierPacket(db, row.packet, carrierCaptureEvidence(row))
      ).explicit,
    );
  return { claims, truncated: rows.length > 2000, window };
}
