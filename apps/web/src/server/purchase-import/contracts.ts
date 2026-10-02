import {
  browserBridgeClientMessage,
  browserBridgeResult,
  browserBridgeServerMessage,
  type BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

export type { PurchaseImportDurableObjectRpc } from "./rpc";

export { browserBridgeResult };
export type { BrowserBridgeResult };

export const decodeBrowserBridgeMessage = (message: string | ArrayBuffer) => {
  try {
    const stringMessage = z.string().safeParse(message);
    const text = stringMessage.success
      ? stringMessage.data
      : new TextDecoder().decode(
          new Uint8Array(z.instanceof(ArrayBuffer).parse(message)),
        );
    return browserBridgeClientMessage.safeParse(JSON.parse(text));
  } catch {
    return browserBridgeClientMessage.safeParse(null);
  }
};

export const bridgeServerMessage = browserBridgeServerMessage;
