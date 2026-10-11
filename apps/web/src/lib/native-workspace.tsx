import { parseShortcode } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { createContext, useContext, useEffect } from "react";
import { z } from "zod";

import { exactRippleTags } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

export const NativeRunEvidenceContext = createContext(false);
export const useNativeRunEvidence = () => useContext(NativeRunEvidenceContext);

export function isNativeRunEvidence(
  pathname: string,
  mode: "run-evidence" | undefined,
) {
  if (mode !== "run-evidence") return false;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 1 && !(parts.length === 2 && parts[0] === "runs"))
    return false;
  return parseShortcode(parts.at(-1) ?? "")?.type === "run";
}

const nativeWorkspaceMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    entity: z.string(),
    id: z.string(),
    replace: z.boolean().optional(),
  }),
  z.object({ type: z.literal("changed") }),
  z.object({ type: z.enum(["ready", "authRequired", "updateRequired"]) }),
]);
const nativeWorkspaceWireSchema = nativeWorkspaceMessageSchema.and(
  z.object({ version: z.literal(1) }),
);
export type NativeWorkspaceMessage = z.infer<
  typeof nativeWorkspaceMessageSchema
>;

const nativeBridgeSchema = z.object({
  webkit: z.object({
    messageHandlers: z.object({
      cubbyWorkspace: z.object({
        postMessage: z.function({
          input: [nativeWorkspaceWireSchema],
          output: z.void(),
        }),
      }),
    }),
  }),
});

declare global {
  interface Window {
    webkit?: z.infer<typeof nativeBridgeSchema>["webkit"];
  }
}

function postNativeWorkspaceMessage(message: NativeWorkspaceMessage) {
  if (import.meta.env.SSR) return;
  const parsed = nativeBridgeSchema.safeParse(window);
  if (!parsed.success || !window.webkit) return;
  const handler = window.webkit.messageHandlers.cubbyWorkspace;
  // WebKit message handlers are origin-checked by native; this is not Window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  handler.postMessage({ version: 1, ...message });
}

export function notifyNativeWorkspaceResponse(response: Response) {
  if (response.status === 401)
    postNativeWorkspaceMessage({ type: "authRequired" });
  if (response.status === 426)
    postNativeWorkspaceMessage({ type: "updateRequired" });
  return response;
}

function recordDestination(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length === 2 &&
    parts[0] === "usda" &&
    /^\d+$/u.test(parts[1] ?? "")
  ) {
    return { entity: "usda-food", id: parts[1] ?? "" };
  }
  if (parts.length !== 1 && parts.length !== 2) return null;
  const parsed = parseShortcode(parts.at(-1) ?? "");
  return parsed ? { entity: parsed.type, id: parsed.shortcode } : null;
}

/** One adapter owns both record links and imperative SPA transitions. Native
 * retains record history; hashes/search inside one record remain web-owned. */
export function NativeWorkspaceBridge() {
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    const handoff = (next: URL, replace = false) => {
      if (next.origin !== window.location.origin) return false;
      const destination = recordDestination(next);
      const current = recordDestination(new URL(window.location.href));
      if (
        !destination ||
        (current?.entity === destination.entity &&
          current.id === destination.id)
      )
        return false;
      postNativeWorkspaceMessage({ type: "navigate", ...destination, replace });
      return true;
    };
    const blockNavigation = (next: URL, replace = false) => {
      if (handoff(next, replace)) return true;
      if (next.origin !== window.location.origin) return false;
      if (next.pathname.startsWith("/auth")) {
        postNativeWorkspaceMessage({ type: "authRequired" });
        return true;
      }
      const current = new URL(window.location.href);
      const insideEvidence =
        next.pathname === current.pathname &&
        next.search === current.search &&
        (!next.hash ||
          next.hash === "#evidence" ||
          document.getElementById(next.hash.slice(1)) !== null);
      return !insideEvidence;
    };
    const click = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        event.defaultPrevented ||
        event.button !== 0
      )
        return;
      if (blockNavigation(new URL(target.href))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", click, true);
    const unblock = router.history.block({
      blockerFn: ({ nextLocation, action }) =>
        blockNavigation(
          new URL(nextLocation.href, window.location.origin),
          action === "REPLACE",
        ),
      enableBeforeUnload: false,
    });
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") {
        postNativeWorkspaceMessage({ type: "changed" });
      }
    });
    const refresh = () => {
      void invalidateOperationTags(
        queryClient,
        exactRippleTags(
          queryClient
            .getQueryCache()
            .getAll()
            .flatMap((query) => query.meta?.cacheTags ?? []),
        ),
      );
    };
    window.addEventListener("cubby-workspace-refresh", refresh);
    if (window.location.pathname.startsWith("/auth/"))
      postNativeWorkspaceMessage({ type: "authRequired" });
    else postNativeWorkspaceMessage({ type: "ready" });
    return () => {
      unblock();
      unsubscribe();
      document.removeEventListener("click", click, true);
      window.removeEventListener("cubby-workspace-refresh", refresh);
    };
  }, [queryClient, router]);
  return null;
}
