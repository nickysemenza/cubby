import { financialAccountOut } from "@cubby/schemas/financial-account";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { createEntityMutationPort } from "./use-entity-commands";
import { useEntityEditSession } from "./use-entity-edit-session";

function financialAccountMutationPort() {
  const item = mock(financialAccountOut, {
    seed: 41,
    overrides: {
      id: "FAC-4K7M",
      name: "Renamed card",
      provisional: false,
      sourceAliases: [
        { source: "statement", alias: "Primary card", externalAccountId: null },
      ],
      notes: null,
    },
  });
  const transport = vi.fn(async () =>
    entityBrowserMutationResultSchema.parse({
      action: "update",
      entity: "financialAccount",
      item,
      sideEffects: { backgroundBatches: [] },
    }),
  );
  const mutation = entityMutation.mutate.withTransport(transport);
  const entityTransport: EntityMutationTransport = {
    execute: async (command) =>
      await mutation.forEntity(command.entity).call(command),
  };
  return { mutationPort: createEntityMutationPort(entityTransport), transport };
}

const request = (name = "saved") => ({
  entity: "task" as const,
  operation: "update" as const,
  intent: "schedule" as const,
  surface: "calendar" as const,
  record: {
    id: "TSK-4K7M",
    name,
    status: "not_started" as const,
    dueDate: "2026-08-20",
    dueEndDate: null,
  },
});

describe("useEntityEditSession", () => {
  it("keeps a draft through an equivalent inline request and resets for record changes", () => {
    const harness = createBrowserTestHarness();
    const { mutationPort } = financialAccountMutationPort();
    const { result, rerender } = renderHook(
      ({ name }) => useEntityEditSession(request(name), { mutationPort }),
      { initialProps: { name: "saved" }, wrapper: harness.wrapper },
    );

    act(() => result.current.set("name", "draft name"));
    expect(result.current.form.getValues("name")).toBe("draft name");

    rerender({ name: "saved" });
    expect(result.current.form.getValues("name")).toBe("draft name");

    rerender({ name: "server refresh" });
    expect(result.current.form.getValues("name")).toBe("server refresh");
    harness.dispose();
  });

  it("does not report an untouched array field as changed after RHF clones it", async () => {
    const harness = createBrowserTestHarness();
    const { mutationPort, transport } = financialAccountMutationPort();
    const sourceAliases = [
      { source: "statement", alias: "Primary card", externalAccountId: null },
    ];
    const { result } = renderHook(
      () =>
        useEntityEditSession(
          {
            entity: "financialAccount",
            operation: "update",
            intent: "full",
            surface: "dialog",
            record: {
              id: "FAC-4K7M",
              name: "Household card",
              providerVendorId: null,
              provisional: false,
              inventoryOwnerDefaultEnabled: false,
              sourceAliases,
              notes: null,
            },
          },
          { mutationPort },
        ),
      { wrapper: harness.wrapper },
    );

    const unchanged = await act(() => result.current.submit());
    expect(unchanged).toMatchObject({ ok: true, changed: false });
    expect(transport).not.toHaveBeenCalled();

    act(() => result.current.set("name", "Renamed card"));
    await act(() => result.current.submit());

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          action: "update",
          entity: "financialAccount",
          id: "FAC-4K7M",
          data: { name: "Renamed card" },
        },
      }),
    );
    harness.dispose();
  });
});
