import type { LinkProps } from "@tanstack/react-router";
import { completeNavLeaves, findActiveTo } from "./nav-items";

type MobileTabId = "today" | "inventory" | "scan" | "search" | "more";
type MobilePresentation = "standard" | "immersive";

export interface MobileRouteDescriptor {
  label: string;
  parentTo: LinkProps["to"] | null;
  tab: MobileTabId;
  presentation: MobilePresentation;
}

const INVENTORY_PREFIXES = [
  "/inventory",
  "/products",
  "/locations",
  "/collections",
  "/pantry-view",
] as const;

const IMMERSIVE_PREFIXES = [
  "/scan",
  "/pantry-view",
  "/inventory/session",
] as const;

function segmentMatches(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function titleFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return "Cubby";
  return segment
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function labelForPath(pathname: string) {
  if (pathname.startsWith("/account/")) return "Account";
  const activeTo = findActiveTo(pathname);
  return (
    completeNavLeaves.find((item) => item.to === activeTo)?.label ??
    titleFromPath(pathname)
  );
}

function parentForPath(pathname: string): LinkProps["to"] | null {
  if (pathname === "/") return null;
  if (pathname.startsWith("/account/")) return "/settings";

  const activeTo = findActiveTo(pathname);
  if (activeTo && pathname !== activeTo) return activeTo as LinkProps["to"];
  return "/";
}

/**
 * Resolve phone chrome from URL semantics instead of component ancestry. Every
 * authenticated route receives a descriptor, including direct deep links and
 * utility routes that are intentionally grouped under More.
 */
export function resolveMobileRoute(pathname: string): MobileRouteDescriptor {
  const inventoryOwned = INVENTORY_PREFIXES.some((prefix) =>
    segmentMatches(pathname, prefix),
  );
  const presentation = IMMERSIVE_PREFIXES.some((prefix) =>
    segmentMatches(pathname, prefix),
  )
    ? "immersive"
    : "standard";

  if (pathname === "/") {
    return {
      label: "Today",
      parentTo: null,
      tab: "today",
      presentation,
    };
  }
  if (segmentMatches(pathname, "/scan")) {
    return { label: "Scan", parentTo: "/", tab: "scan", presentation };
  }
  if (segmentMatches(pathname, "/search")) {
    return { label: "Search", parentTo: "/", tab: "search", presentation };
  }
  return {
    label: labelForPath(pathname),
    parentTo: parentForPath(pathname),
    tab: inventoryOwned ? "inventory" : "more",
    presentation,
  };
}

export const mobileInventoryPrefixesForTest = INVENTORY_PREFIXES;
