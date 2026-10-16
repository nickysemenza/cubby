import { z } from "zod";

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

export const nativeBridgeSchema = z.object({
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
