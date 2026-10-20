import { connectionEndpointKinds } from "@cubby/schemas/entity-connections";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { financialAccountShortcode } from "@cubby/schemas/identifiers";
import {
  SWEEP_FAMILY_LABEL,
  type sweepFieldTargets,
} from "@cubby/schemas/run-fields";
import type { SweepStartInput } from "@cubby/schemas/sweep";
import { countLabel } from "@cubby/shared/pluralize";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { Picker } from "~/entity/picker/picker";
import { useEntityListSource } from "~/entity/picker/with-search-hook";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { run } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";

type Family = SweepStartInput["families"][number]["family"];
type SweepFieldTarget = z.infer<typeof sweepFieldTargets>[number];
// Undefined filter values drop out, as they would on the wire.
const jsonFilters = z
  .record(z.string(), z.json().optional())
  .transform((filters) =>
    Object.fromEntries(
      Object.entries(filters).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
    ),
  );

/** Entities with at least one declared decision field, and those fields. */
const DECISION_FIELDS = shortcodeEntities.flatMap((entity) => {
  const fields = entityFieldModels[entity].fields.flatMap((field) =>
    field.control?.suggest ? [{ value: field.key, label: field.label }] : [],
  );
  return fields.length ? [{ entity, fields }] : [];
});
const DECISION_ENTITY_OPTIONS = DECISION_FIELDS.map(({ entity }) => ({
  value: entity,
  label: entitySummary[entity].singular,
}));
const CONNECTION_KIND_OPTIONS = shortcodeEntities
  .filter((entity) => connectionEndpointKinds.includes(entity))
  .map((entity) => ({ value: entity, label: entitySummary[entity].singular }));

const FAMILY_ROWS = [
  {
    family: "statement_transaction",
    label: SWEEP_FAMILY_LABEL.statement_transaction,
    hint: "create, attach, settle and void holds",
  },
  {
    family: "transfer_pair",
    label: SWEEP_FAMILY_LABEL.transfer_pair,
    hint: "opposite money movements across accounts",
  },
  {
    family: "recommendation",
    label: SWEEP_FAMILY_LABEL.recommendation,
    hint: "acquisitions, settlements, Emails, placements",
  },
  {
    family: "field",
    label: SWEEP_FAMILY_LABEL.field,
    hint: "categories and other decision fields",
  },
] as const satisfies readonly { family: Family; label: string; hint: string }[];

const FAMILY_NOUN = {
  statement_transaction: "charge",
  transfer_pair: "pair",
  recommendation: "record",
  field: "field",
} satisfies Record<Family, string>;

/** The dialog's starting scope; an entity list presets its own fields. */
export type FindSuggestionsPreset = {
  families?: readonly Family[];
  field?: {
    entity: ShortcodeEntity;
    fields?: readonly string[];
    /** The list's current filters, so the Sweep covers what is shown. */
    filters?: SweepFieldTarget["filters"];
  };
};

function FamilyRow({
  checked,
  onChecked,
  label,
  hint,
  children,
}: {
  checked: boolean;
  onChecked: (checked: boolean) => void;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-b py-2.5 last:border-b-0">
      <Checkbox
        checked={checked}
        onCheckedChange={onChecked}
        aria-label={label}
        className="mt-0.5"
      />
      <div className="text-sm">
        <span className="font-medium">{label}</span>{" "}
        <span className="text-muted-foreground">· {hint}</span>
      </div>
      {checked ? (
        <div className="col-start-2 flex flex-wrap items-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * An entity list's way into a Sweep of its own decision fields, scoped to
 * the list's current filters; the started Sweep is followed on Suggestions.
 */
export function FindSuggestionsAction({
  entity,
  filters,
  inline = false,
}: {
  entity: ShortcodeEntity;
  filters: object;
  /** A compact action in the list's totals and suggestion status line. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!DECISION_FIELDS.some((item) => item.entity === entity)) return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={
          inline
            ? "h-5 px-0 text-xs font-normal text-muted-foreground"
            : undefined
        }
        onClick={() => setOpen(true)}
      >
        Find suggestions…
      </Button>
      {open ? (
        <FindSuggestionsDialog
          open
          onOpenChange={setOpen}
          preset={{
            families: ["field"],
            // The list's filter patch as the Sweep's JSON target filters.
            field: { entity, filters: jsonFilters.parse(filters) },
          }}
          onStarted={(runId) =>
            void navigate({
              to: "/suggestions",
              search: { family: "field", sweep: runId },
            })
          }
        />
      ) : null}
    </>
  );
}

/**
 * Starts one Sweep over the chosen families and scopes. The estimate reads
 * stored coverage before anything runs; Start creates the Sweep Run, whose
 * Steps show each family's progress and retry.
 */
export function FindSuggestionsDialog({
  open,
  onOpenChange,
  preset,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: FindSuggestionsPreset;
  onStarted: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [families, setFamilies] = useState<ReadonlySet<Family>>(
    () => new Set(preset?.families ?? FAMILY_ROWS.map((row) => row.family)),
  );
  const [accounts, setAccounts] = useState<ComboboxItem[]>([]);
  const [since, setSince] = useState("");
  const [transferAccounts, setTransferAccounts] = useState<ComboboxItem[]>([]);
  const [transferSince, setTransferSince] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [fieldEntity, setFieldEntity] = useState<string | null>(
    preset?.field?.entity ?? null,
  );
  const [fields, setFields] = useState<string[]>([
    ...(preset?.field?.fields ?? []),
  ]);
  const accountSource = useEntityListSource("financialAccount");

  const toggle = (family: Family, checked: boolean) =>
    setFamilies((previous) => {
      const next = new Set(previous);
      if (checked) next.add(family);
      else next.delete(family);
      return next;
    });
  const entityFields =
    DECISION_FIELDS.find(({ entity }) => entity === fieldEntity)?.fields ?? [];
  const input: SweepStartInput | null = families.size
    ? {
        families: FAMILY_ROWS.flatMap(
          ({ family }): SweepStartInput["families"] => {
            if (!families.has(family)) return [];
            if (family === "transfer_pair")
              return [
                {
                  family,
                  ...(transferAccounts.length
                    ? {
                        accountIds: transferAccounts.map((item) =>
                          financialAccountShortcode.parse(item.id),
                        ),
                      }
                    : {}),
                  ...(transferSince ? { since: `${transferSince}-01` } : {}),
                },
              ];
            if (family === "statement_transaction")
              return [
                {
                  family,
                  ...(accounts.length
                    ? {
                        accountIds: accounts.map((item) =>
                          financialAccountShortcode.parse(item.id),
                        ),
                      }
                    : {}),
                  ...(since ? { since: `${since}-01` } : {}),
                },
              ];
            if (family === "recommendation")
              return [
                { family, ...(kinds.length ? { entityKinds: kinds } : {}) },
              ];
            return [
              {
                family,
                ...(fieldEntity
                  ? {
                      targets: [
                        {
                          entity: fieldEntity,
                          fields: fields.length
                            ? fields
                            : entityFields.map((field) => field.value),
                          filters: preset?.field?.filters ?? {},
                        },
                      ],
                    }
                  : {}),
              },
            ];
          },
        ),
      }
    : null;
  const [debounced] = useDebouncedValue(input, { wait: 300 });
  const estimate = useQuery({
    ...run.sweepEstimate.queryOptions(debounced ?? { families: [] }),
    enabled: open && debounced !== null,
  });

  return (
    <>
      {accountSource.dialog}
      <Overlay
        open={open}
        onOpenChange={onOpenChange}
        title="Find suggestions"
        description="Starts one Sweep. Each family runs as its own step, with its own progress and retry."
        size="md"
        primary={{
          label: "Start Sweep",
          pendingLabel: "Starting…",
          disabled: input === null,
          onClick: async () => {
            if (!input) return;
            const { runId } = await run.sweep.call(input);
            await invalidateOperationTags(queryClient, ripple.runOnly);
            onOpenChange(false);
            onStarted(runId);
          },
        }}
      >
        <div>
          <FamilyRow
            {...FAMILY_ROWS[0]}
            checked={families.has("statement_transaction")}
            onChecked={(checked) => toggle("statement_transaction", checked)}
          >
            <Picker
              multiple
              label="Accounts"
              placeholder="All accounts"
              className="w-64"
              entity="financialAccount"
              items={accountSource.items}
              isLoading={accountSource.isLoading}
              onSearchChange={accountSource.onSearchChange}
              onOpenChange={accountSource.onOpenChange}
              values={accounts}
              setValues={setAccounts}
            />
            {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Input inside is the control */}
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Since
              <Input
                type="month"
                aria-label="Since month"
                className="w-36"
                value={since}
                onChange={(event) => setSince(event.target.value)}
              />
            </label>
          </FamilyRow>
          <FamilyRow
            {...FAMILY_ROWS[1]}
            checked={families.has("transfer_pair")}
            onChecked={(checked) => toggle("transfer_pair", checked)}
          >
            <Picker
              multiple
              label="Transfer accounts"
              placeholder="All accounts"
              className="w-64"
              entity="financialAccount"
              items={accountSource.items}
              isLoading={accountSource.isLoading}
              onSearchChange={accountSource.onSearchChange}
              onOpenChange={accountSource.onOpenChange}
              values={transferAccounts}
              setValues={setTransferAccounts}
            />
            {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the Input inside is the control */}
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Since
              <Input
                type="month"
                aria-label="Transfers since month"
                className="w-36"
                value={transferSince}
                onChange={(event) => setTransferSince(event.target.value)}
              />
            </label>
          </FamilyRow>
          <FamilyRow
            {...FAMILY_ROWS[2]}
            checked={families.has("recommendation")}
            onChecked={(checked) => toggle("recommendation", checked)}
          >
            <Picker
              multiple
              label="Record types"
              placeholder="All record types"
              className="w-64"
              options={CONNECTION_KIND_OPTIONS}
              values={kinds}
              onValuesChange={setKinds}
            />
          </FamilyRow>
          <FamilyRow
            {...FAMILY_ROWS[3]}
            checked={families.has("field")}
            onChecked={(checked) => toggle("field", checked)}
          >
            <Picker
              mode="choose"
              label="Entity"
              placeholder="All entities"
              className="w-44"
              clearable
              options={DECISION_ENTITY_OPTIONS}
              value={fieldEntity}
              onValueChange={(value) => {
                setFieldEntity(value);
                setFields([]);
              }}
            />
            {fieldEntity ? (
              <Picker
                multiple
                label="Decision fields"
                placeholder="All decision fields"
                className="w-56"
                options={entityFields}
                values={fields}
                onValuesChange={setFields}
              />
            ) : null}
            {preset?.field?.filters &&
            Object.keys(preset.field.filters).length &&
            fieldEntity === preset.field.entity ? (
              <span className="text-xs text-muted-foreground">
                Limited to the list's current filters
              </span>
            ) : null}
          </FamilyRow>
        </div>
        <div className="mt-3 rounded-md bg-muted px-3 py-2 text-xs">
          <p className="mb-1 font-medium">
            Estimate
            <span className="font-normal text-muted-foreground">
              {" "}
              from stored coverage; nothing runs until you start
            </span>
          </p>
          {estimate.error ? (
            <ErrorDisplay error={estimate.error} title="Sweep estimate" />
          ) : input === null ? (
            <p className="text-muted-foreground">Choose at least one family.</p>
          ) : estimate.data ? (
            <ul aria-label="Sweep estimate" className="grid grid-cols-3 gap-2">
              {estimate.data.families.map((row) => (
                <li key={row.family} className="tabular-nums">
                  <span className="block font-medium">
                    {
                      FAMILY_ROWS.find((family) => family.family === row.family)
                        ?.label
                    }
                  </span>
                  {countLabel(row.records, FAMILY_NOUN[row.family], {
                    formatted: true,
                  })}{" "}
                  ≈ {countLabel(row.decisions, "decision", { formatted: true })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Estimating…</p>
          )}
          <p className="mt-1.5 text-muted-foreground">
            Already-covered records are skipped. Paid model calls pause at the
            AI budget and resume in the next window.
          </p>
        </div>
      </Overlay>
    </>
  );
}
