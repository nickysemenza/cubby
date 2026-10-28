import { vendorOut } from "@cubby/schemas/entities/vendor";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fetchVendorLogoInput } from "@cubby/schemas/vendor";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { vendor } from "~/integrations/tanstack-query/domains/vendor";
import { DropdownMenuItem } from "~/ui/primitives/dropdown-menu";

import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

const missingLogoWebsiteReason = "Add a website in Edit to fetch a logo.";
export const productionLogoOperations = {
  fetchLogo: vendor.fetchLogo.mutationOptions,
};
export type VendorLogoFetchOperations = typeof productionLogoOperations;

/** Every surface observes the same record's in-flight operation. */
export function useFetchVendorLogo(
  operations: VendorLogoFetchOperations = productionLogoOperations,
) {
  const client = useQueryClient();
  const filters = useMemo(
    () => ({
      exact: true,
      mutationKey: operations.fetchLogo().mutationKey,
      status: "pending" as const,
    }),
    [operations],
  );
  const pending = useMutationState({
    filters,
    select: (mutation) =>
      fetchVendorLogoInput.safeParse(mutation.state.variables),
  });
  const mutation = useActionMutation({
    mutationFn: operations.fetchLogo,
    success: "Vendor logo saved",
  });
  const mutateAsync = mutation.mutateAsync;
  const fetch = useCallback(
    async (id: string) => {
      const input = { id: parseShortcodeFor("vendor", id) };
      if (
        client
          .getMutationCache()
          .findAll(filters)
          .some((item) => {
            const variables = fetchVendorLogoInput.safeParse(
              item.state.variables,
            );
            return variables.success && variables.data.id === id;
          })
      )
        return;
      await mutateAsync(input);
    },
    [client, filters, mutateAsync],
  );
  return {
    fetch,
    isPending: (id: string) =>
      pending.some((item) => item.success && item.data.id === id),
  };
}

const logoTarget = vendorOut.pick({ id: true, website: true, logo: true });

function useVendorLogoAction(refresh: boolean): EntityActionHandles {
  const logo = useFetchVendorLogo();
  const availability = (row: EntityActionRow) => {
    const target = logoTarget.safeParse(row);
    if (!target.success)
      return refresh
        ? ({ status: "hidden" } as const)
        : ({
            status: "disabled",
            reason: "Loading vendor logo details…",
          } as const);
    if (Boolean(target.data.logo) !== refresh)
      return { status: "hidden" } as const;
    if (!target.data.website)
      return {
        status: "disabled",
        reason: missingLogoWebsiteReason,
        recovery: (
          <Link
            className="text-link hover:underline"
            to="/vendors/$shortcode"
            params={{ shortcode: target.data.id }}
          >
            Open vendor to edit website
          </Link>
        ),
      } as const;
    if (logo.isPending(row.id))
      return { status: "disabled", reason: "Fetching logo…" } as const;
    return { status: "available" } as const;
  };
  const run = async (rows: readonly EntityActionRow[]) => {
    const row = rows[0];
    if (!row || availability(row).status !== "available")
      return { success: false };
    try {
      await logo.fetch(row.id);
      return { success: true };
    } catch {
      return { success: false };
    } // The shared mutation shows raw diagnostics and permits retry.
  };
  return {
    run,
    availability: ({ rows }) =>
      rows[0] ? availability(rows[0]) : { status: "hidden" },
    dialog: null,
    rowMenuItem: (row) => {
      const state = availability(row);
      if (state.status === "hidden") return null;
      return (
        <>
          <VerbMenuItem
            verb={refresh ? "refreshLogo" : "fetchLogo"}
            disabledReason={
              state.status === "disabled" ? state.reason : undefined
            }
            onSelect={() => void run([row])}
          />
          {state.status === "disabled" && "recovery" in state && (
            <DropdownMenuItem
              render={
                <Link
                  className="text-link hover:underline"
                  to="/vendors/$shortcode"
                  params={{ shortcode: parseShortcodeFor("vendor", row.id) }}
                />
              }
            >
              Open vendor to edit website
            </DropdownMenuItem>
          )}
        </>
      );
    },
  };
}

export const vendorLogoEntityActionDefinitions = [false, true].map((refresh) =>
  defineEntityAction({
    verb: refresh ? "refreshLogo" : "fetchLogo",
    entities: ["vendor"],
    arity: "single",
    surfaces: ["row", "detail", "inspector"],
    group: "organize",
    priority: 100,
    readFields: ["website", "logo"],
    use: () => useVendorLogoAction(refresh),
  }),
);
