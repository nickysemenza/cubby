import { productShortcodeInput } from "@cubby/schemas/product";
import { createServerFn } from "@tanstack/react-start";
import { createRequestDomainClient } from "~/server/api/request-caller";

/**
 * Request-authenticated product detail read for the SSR route loader.
 *
 * TanStack Start executes this handler in-process during SSR and compiles the
 * client call as a server-function RPC. Product detail only invokes it in the
 * SSR branch; client navigations keep using the existing batched tRPC client.
 */
export const getProductDetailForSsr = createServerFn({ method: "GET" })
  .validator(productShortcodeInput)
  .handler(async ({ data }) => {
    const client = createRequestDomainClient();
    return client.product.getByShortcode.query(data);
  });
