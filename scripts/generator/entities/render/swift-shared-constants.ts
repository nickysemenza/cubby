import {
  HOUSEHOLD_TIMEZONE,
  IMAGE_WIDTHS,
} from "../../../../packages/shared/src/client-constants.ts";
import {
  WAYFINDING_DOMAINS,
  WAYFINDING_DOMAIN_PRESENTATION,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { readR2PublicUrlFromWrangler } from "../../../../apps/web/tooling/wrangler-public-config.ts";
import { generatedHeader } from "../../artifacts.ts";
import type { EntityArtifacts } from "../declarations.ts";

const swiftString = (value: string): string => JSON.stringify(value);

/**
 * Renders the constants and vocabulary the native app must not restate: the
 * image-transform rungs and media host, the household time zone, and each
 * wayfinding line's title and SF Symbol. Everything here is read from the
 * same declaration the web client imports, so the two cannot drift.
 */
export const renderSwiftSharedConstants = (): EntityArtifacts[] => {
  const domainCases = (property: "label" | "sfSymbol") =>
    WAYFINDING_DOMAINS.map(
      (domain) =>
        `        case .${domain}: ${swiftString(WAYFINDING_DOMAIN_PRESENTATION[domain][property])}`,
    ).join("\n");
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/SharedConstants.swift",
      source:
        generatedHeader +
        "// swift-format-ignore-file\n\n" +
        "/// Constants declared once in TypeScript (`packages/shared/src/client-constants.ts`,\n" +
        "/// `apps/web/wrangler.jsonc`) and shared with the web client.\n" +
        "public enum SharedConstants {\n" +
        "    /// Cloudflare image-transform rungs (`IMAGE_WIDTHS`).\n" +
        `    public static let imageWidths: [Int] = [${IMAGE_WIDTHS.join(", ")}]\n` +
        "    /// The R2 bucket's public origin (`R2_PUBLIC_URL` in wrangler.jsonc).\n" +
        `    public static let mediaOrigin = ${swiftString(readR2PublicUrlFromWrangler())}\n` +
        "    /// The household's IANA time zone (`HOUSEHOLD_TIMEZONE`).\n" +
        `    public static let householdTimeZoneIdentifier = ${swiftString(HOUSEHOLD_TIMEZONE)}\n` +
        "}\n\n" +
        "extension WayfindingDomain {\n" +
        "    /// The line's name (`WAYFINDING_DOMAIN_PRESENTATION.label`).\n" +
        "    public var title: String {\n" +
        "        switch self {\n" +
        `${domainCases("label")}\n` +
        "        }\n" +
        "    }\n\n" +
        "    /// The group glyph (`WAYFINDING_DOMAIN_PRESENTATION.sfSymbol`).\n" +
        "    public var sfSymbol: String {\n" +
        "        switch self {\n" +
        `${domainCases("sfSymbol")}\n` +
        "        }\n" +
        "    }\n" +
        "}\n",
    },
  ];
};
