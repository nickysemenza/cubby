import { financialAccountOut } from "@cubby/schemas/financial-account";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entity/entity-contracts";
import { entityMutation } from "~/integrations/tanstack-query/generated/catalog.gen";
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
      sideEffects: {},
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
  it("preserves sibling drafts through a same-record refresh and resets when changing records", () => {
    const harness = createBrowserTestHarness();
    const { mutationPort } = financialAccountMutationPort();
    const { result, rerender } = renderHook(
      ({ name, id, dueDate }) =>
        useEntityEditSession(
          {
            ...request(name),
            record: { ...request(name).record, id, dueDate },
          },
          { mutationPort },
        ),
      {
        initialProps: { name: "saved", id: "TSK-4K7M", dueDate: "2026-08-20" },
        wrapper: harness.wrapper,
      },
    );
    act(() => {
      result.current.form.register("dueDate");
      result.current.set("name", "draft name");
    });
    rerender({ name: "server refresh", id: "TSK-4K7M", dueDate: "2026-08-22" });
    expect(result.current.form.getValues("name")).toBe("draft name");
    expect(result.current.form.getValues("dueDate")).toBe("2026-08-22");
    // An explicitly saved field acknowledges only its new persisted baseline.
    act(() =>
      result.current.form.resetField("dueDate", { defaultValue: "2026-08-23" }),
    );
    act(() => result.current.reset());
    expect(result.current.form.getValues("name")).toBe("server refresh");
    expect(result.current.form.getValues("dueDate")).toBe("2026-08-23");
    act(() => result.current.set("name", "another draft"));
    rerender({
      name: "other saved task",
      id: "TSK-8K7M",
      dueDate: "2026-08-24",
    });
    expect(result.current.form.getValues("name")).toBe("other saved task");
    expect(result.current.form.getValues("dueDate")).toBe("2026-08-24");
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
