import { imageWithEntitySchema } from "@cubby/schemas/image";
import { testUserId } from "@cubby/schemas/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { createRequestContext, requireActor } from "~/server/request-context";
import type {
  AuthenticatedStartOperationContext,
  StartOperationRequest,
} from "~/server/start-operation.server";

import {
  createImageHandlers,
  type ImageBrowserPorts,
} from "./image-browser.server";
import type {
  OperationExecutionAdapter,
  OperationExecutionOptions,
} from "./operation-domain.server";

type OutputSchemaResolver<Input, OutputSchema extends z.ZodType> = (
  input: Input,
) => OutputSchema;

function isOutputSchemaResolver<Input, OutputSchema extends z.ZodType>(
  schema: OutputSchema | OutputSchemaResolver<Input, OutputSchema>,
): schema is OutputSchemaResolver<Input, OutputSchema> {
  return typeof schema === "function";
}

class InMemoryOperationAdapter implements OperationExecutionAdapter {
  constructor(private readonly context: AuthenticatedStartOperationContext) {}

  async execute<Input, OutputSchema extends z.ZodType>(
    options: OperationExecutionOptions<Input, OutputSchema>,
  ) {
    const input = options.inputSchema.parse(options.input);
    const rawOutput = await options.run(this.context, input);
    const outputSchema = isOutputSchemaResolver(options.outputSchema)
      ? options.outputSchema(input)
      : options.outputSchema;
    return { ok: true as const, data: outputSchema.parse(rawOutput) };
  }
}

const request: StartOperationRequest = {
  headers: new Headers(),
  signal: new AbortController().signal,
};

const refreshedImage = mock(imageWithEntitySchema, {
  seed: 8,
  overrides: {
    id: "IMG-4K7M",
    filename: "renamed.jpg",
    entityType: "PRODUCT",
    entityId: "PRD-4K7M",
  },
});

let context: AuthenticatedStartOperationContext;

beforeAll(async () => {
  context = requireActor(
    await createRequestContext({
      headers: new Headers(),
      actor: {
        userId: testUserId("image-browser-user"),
        sessionId: null,
        source: "ui",
      },
    }),
  );
});

describe("Image browser operations", () => {
  it("reloads the enriched projection after updating the row", async () => {
    const commands: string[] = [];
    const ports = {
      async update() {
        commands.push("update");
      },
      async get() {
        commands.push("get");
        return refreshedImage;
      },
    } satisfies Partial<ImageBrowserPorts>;
    const handlers = createImageHandlers(
      ports,
      new InMemoryOperationAdapter(context),
    );

    await expect(
      handlers.operations.update({
        data: { id: "IMG-4K7M", data: { filename: "renamed.jpg" } },
        request,
      }),
    ).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        id: "IMG-4K7M",
        entityType: "PRODUCT",
      }),
    });

    expect(commands).toEqual(["update", "get"]);
  });
});
