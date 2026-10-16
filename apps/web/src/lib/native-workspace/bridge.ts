import { nativeBridgeSchema, type NativeWorkspaceMessage } from "./contract";

export function postNativeWorkspaceMessage(message: NativeWorkspaceMessage) {
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
