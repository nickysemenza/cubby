/** Throwaway: one approved Run workspace exercised with three synthetic kinds. */
import { useMemo, useState } from "react";

import RTable from "~/entity/table/table";
import { AuthenticatedAppShell } from "~/features/shell/authenticated-app-shell";
import { Picker } from "~/ui/combobox/picker";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import { Image } from "~/ui/primitives/image";

import { StatusPill } from "../job/job-status";

type Example = "email" | "photo" | "enrichment";
type Item = {
  id: string;
  name: string;
  status: "Ready" | "Needs review" | "Applied" | "Skipped";
  change: string;
  source: string;
  evidence: string;
};
const examples = {
  email: {
    title: "Email purchase import",
    scope: "Recent mail · 6 messages examined",
    rows: [
      {
        id: "email-1",
        name: "Order from Sample Supply",
        status: "Ready",
        change: "Create order and 2 purchases",
        source: "Order confirmation",
        evidence:
          "Two item lines, delivery charge and order total agree. No matching order is recorded.",
      },
      {
        id: "email-2",
        name: "Sample Market receipt",
        status: "Needs review",
        change: "Resolve possible duplicate",
        source: "Receipt",
        evidence:
          "A recorded order has the same date and total. Choose whether this is another receipt for that order.",
      },
      {
        id: "email-3",
        name: "Shipping update",
        status: "Applied",
        change: "Updated delivery status",
        source: "Shipping notification",
        evidence:
          "Tracking matches an existing order. Delivery status was updated automatically.",
      },
    ],
  },
  photo: {
    title: "Photo inventory review",
    scope: "Study shelf · 4 photographs examined",
    rows: [
      {
        id: "photo-1",
        name: "Adjustable desk lamp",
        status: "Ready",
        change: "Create product at Study shelf",
        source: "Photograph 1 · group 1",
        evidence:
          "One lamp is visible. No matching household product was found. Proposed quantity: 1.",
      },
      {
        id: "photo-2",
        name: "Two matching storage boxes",
        status: "Needs review",
        change: "Confirm quantity and identity",
        source: "Photographs 2 and 3 · group 2",
        evidence:
          "The photographs may show the same pair from different angles. Confirm quantity before creating records.",
      },
      {
        id: "photo-3",
        name: "Canvas tote",
        status: "Applied",
        change: "Linked to existing product",
        source: "Photograph 4 · group 3",
        evidence:
          "The existing product and photograph share the same distinctive label.",
      },
    ],
  },
  enrichment: {
    title: "Product enrichment",
    scope: "Products missing research · 8 products examined",
    rows: [
      {
        id: "research-1",
        name: "Sample electric kettle",
        status: "Applied",
        change: "Added dimensions and source",
        source: "Manufacturer specification",
        evidence:
          "Model identifier matches. The source gives a 1.2 L capacity and stainless steel construction.",
      },
      {
        id: "research-2",
        name: "Sample wool blanket",
        status: "Applied",
        change: "Added material and care",
        source: "Manufacturer care guide",
        evidence:
          "The published care guide describes hand washing and drying flat.",
      },
    ],
  },
} satisfies Record<Example, { title: string; scope: string; rows: Item[] }>;
const helper = createCubbyColumnHelper<Item>();
const getRowId = (row: Item) => row.id;
const search = {
  text: (row: Item) => `${row.name} ${row.change} ${row.source}`,
  placeholder: "Search results",
};

function Evidence({
  item,
  close,
  decide,
}: {
  item: Item;
  close: () => void;
  decide: (status: Item["status"]) => void;
}) {
  const step = useTableRowStep();
  const [decision, setDecision] = useState<string | null>(null);
  const [photo, setPhoto] = useState("2");
  const [quantity, setQuantity] = useState<string | null>(null);
  return (
    <SidePanel
      label="Result inspector"
      title={item.name}
      eyebrow={
        <StatusPill tone={item.status === "Applied" ? "positive" : "neutral"}>
          {item.status}
        </StatusPill>
      }
      onClose={close}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      <div className="space-y-4 text-sm">
        {item.id.startsWith("photo-") && (
          <section aria-label="Photo group evidence" className="space-y-3">
            <h3 className="font-semibold">Photo group evidence</h3>
            <p className="text-xs text-muted-foreground">
              Synthetic image placeholders · photographs remain attached to this
              group.
            </p>
            <div className="flex gap-3">
              {["2", "3"].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={photo === value}
                  aria-label={`Inspect photograph ${value}`}
                  className="space-y-1 text-left"
                  onClick={() => setPhoto(value)}
                >
                  <Image
                    alt={`Synthetic photograph ${value}`}
                    displayWidth={112}
                    style={{ width: 112, height: 112 }}
                  />
                  <span className="block text-xs">
                    Photograph {value}
                    {photo === value ? " · inspecting" : ""}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs">
              {photo === "2"
                ? "Front view: two boxes together."
                : "Side view: matching labels and shelf position."}
            </p>
            <Picker
              label="Confirmed quantity"
              placeholder="Confirm quantity"
              value={quantity}
              onValueChange={setQuantity}
              options={[
                { value: "2", label: "2 items · same pair in both photos" },
                { value: "4", label: "4 items · different pairs" },
              ]}
            />
          </section>
        )}
        <section>
          <h3 className="mb-2 font-semibold">Proposed outcome</h3>
          <p>{item.change}</p>
        </section>
        <section className="border-t pt-3">
          <h3 className="mb-2 font-semibold">Evidence</h3>
          <p>{item.evidence}</p>
          <p className="mt-2 text-xs text-muted-foreground">{item.source}</p>
        </section>
        {item.status === "Needs review" && (
          <section className="border-t pt-3">
            <h3 className="mb-2 font-semibold">Your decision</h3>
            <Picker
              label="Review decision"
              value={decision}
              onValueChange={setDecision}
              options={[
                { value: "confirm", label: "Confirm proposed outcome" },
                { value: "separate", label: "Keep as a separate record" },
              ]}
            />
            <Button
              className="mt-3"
              disabled={!decision}
              onClick={() => decide("Ready")}
            >
              Mark ready
            </Button>
          </section>
        )}
        {item.status === "Ready" && (
          <div className="flex gap-2 border-t pt-3">
            <Button onClick={() => decide("Applied")}>Apply result</Button>
            <Button variant="outline" onClick={() => decide("Skipped")}>
              Skip
            </Button>
          </div>
        )}
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Raw diagnostics
          </summary>
          <pre className="mt-2 overflow-auto text-xs">
            {JSON.stringify(item, null, 2)}
          </pre>
        </details>
      </div>
    </SidePanel>
  );
}

function Workspace({ kind }: { kind: Example }) {
  const example = examples[kind];
  const [rows, setRows] = useState<Item[]>(example.rows);
  const [tab, setTab] = useState("attention");
  const [filter, setFilter] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [arrivals, setArrivals] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = rows.filter(
    (row) => row.status === "Ready" || row.status === "Needs review",
  );
  const effectiveTab =
    pending.length === 0 && tab === "attention" ? "results" : tab;
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          (effectiveTab !== "attention" ||
            row.status === "Ready" ||
            row.status === "Needs review") &&
          (!filter || row.status === filter),
      ),
    [rows, effectiveTab, filter],
  );
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<Item>((add) => {
        add(
          helper.accessor("name", {
            header: "Result",
            size: 280,
            meta: attachCubbyColumnMeta<Item>({
              mobile: { slot: "title", priority: 0 },
            }),
            cell: ({ row }) => (
              <a
                href={`#record-${row.original.id}`}
                className="text-link hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  setRecordId(row.id);
                  setNotice(`Opened synthetic record: ${row.original.name}`);
                }}
              >
                {row.original.name}
              </a>
            ),
          }),
        );
        add(
          helper.accessor("status", {
            header: "Status",
            size: 128,
            cell: ({ row }) => (
              <StatusPill
                tone={
                  row.original.status === "Applied"
                    ? "positive"
                    : row.original.status === "Ready"
                      ? "info"
                      : "neutral"
                }
              >
                {row.original.status}
              </StatusPill>
            ),
          }),
        );
        add(helper.accessor("change", { header: "Outcome", size: 280 }));
        add(helper.accessor("source", { header: "Source", size: 220 }));
      }),
    [],
  );
  const table = useLocalTable({ rows: shown, columns, getRowId, search });
  const visible = table.getFilteredRowModel().rows;
  const readyIds = visible
    .filter((row) => row.original.status === "Ready")
    .map((row) => row.id);
  const open = rows.find((row) => row.id === openId);
  const decide = (status: Item["status"]) =>
    setRows((current) =>
      current.map((row) => (row.id === openId ? { ...row, status } : row)),
    );
  const record = rows.find((row) => row.id === recordId);
  if (record)
    return (
      <div className="px-3 py-5 md:px-6">
        <Button
          variant="ghost"
          onClick={() => {
            setRecordId(null);
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }}
        >
          Back to run
        </Button>
        <p className="mt-5 text-xs text-muted-foreground">Synthetic record</p>
        <h1 className="mt-1 text-xl font-semibold">{record.name}</h1>
        <div className="mt-5 space-y-3 border-t pt-3 text-sm">
          <p>{record.change}</p>
          <p>{record.evidence}</p>
          <p className="text-muted-foreground">Source: {record.source}</p>
        </div>
      </div>
    );
  return (
    <div className="px-3 py-5 md:px-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">
            Runs / Synthetic preview
          </p>
          <h1 className="text-xl font-semibold">{example.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{example.scope}</p>
        </div>
        <StatusPill tone="positive">Execution complete</StatusPill>
      </div>
      <div className="mb-5 flex flex-wrap gap-x-8 gap-y-3 border-y py-3">
        {[
          ["Results", rows.length],
          ["Need attention", pending.length],
          ["Applied", rows.filter((row) => row.status === "Applied").length],
        ].map(([label, count]) => (
          <div key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold tabular-nums">{count}</p>
          </div>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Picker
          mode="segmented"
          label="Run workspace"
          value={effectiveTab}
          onValueChange={(value) => {
            if (value) {
              setTab(value);
              setFilter(null);
            }
          }}
          options={[
            { value: "attention", label: `Attention · ${pending.length}` },
            { value: "results", label: `Results · ${rows.length}` },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Picker
            label="Status"
            className="w-40"
            placeholder="All statuses"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "Ready", label: "Ready" },
              { value: "Needs review", label: "Needs review" },
              { value: "Applied", label: "Applied" },
              { value: "Skipped", label: "Skipped" },
            ]}
          />
          <Button
            disabled={readyIds.length === 0}
            onClick={() => {
              setRows((current) =>
                current.map((row) =>
                  readyIds.includes(row.id)
                    ? { ...row, status: "Applied" }
                    : row,
                ),
              );
              setNotice(`Applied ${readyIds.length} filtered ready results.`);
            }}
          >
            Apply {readyIds.length} filtered ready
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {effectiveTab === "attention"
          ? "Resolve uncertain results or apply ready ones. Opening a row makes no changes."
          : "Every published outcome, including applied and skipped results."}
      </p>
      {arrivals && (
        <div className="mb-3 flex items-center gap-3 border-y py-2 text-sm">
          <span>1 new result is available. Your review stays in place.</span>
          <Button
            variant="outline"
            onClick={() => {
              setRows((current) => [
                ...current,
                {
                  ...example.rows[0]!,
                  id: `${kind}-new`,
                  name: "New synthetic result",
                  status: "Ready",
                },
              ]);
              setArrivals(false);
            }}
          >
            Show new result
          </Button>
        </div>
      )}
      <RTable
        table={table}
        embedded
        ariaLabel="Run results"
        withoutImages="This ledger summarizes published run outcomes."
        currentRowId={openId ?? undefined}
        onRowClick={(row) => setOpenId(row.id)}
        disableMobileDetailsHref
        inspector={{
          content: open ? (
            <Evidence
              key={open.id}
              item={open}
              close={() => setOpenId(null)}
              decide={decide}
            />
          ) : null,
          title: "Result inspector",
          onClose: () => setOpenId(null),
        }}
      />
      <output className="block py-2 text-xs text-muted-foreground">
        {notice ||
          `${visible.length} of ${rows.length} results · All actions affect this preview only`}
      </output>
      <details className="mt-5 border-t pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Execution details
        </summary>
        <div className="space-y-2 py-3 text-xs text-muted-foreground">
          <p>Discovery complete · Processing complete · Publication complete</p>
          <p>No work is queued. No execution errors were reported.</p>
          <details>
            <summary className="cursor-pointer">Raw execution data</summary>
            <pre>
              {JSON.stringify(
                { kind, status: "completed", resultCount: rows.length },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </details>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          Prototype controls
        </span>
        <Button variant="ghost" onClick={() => setArrivals(true)}>
          Simulate new arrival
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setRows(example.rows);
            setTab("attention");
            setFilter(null);
            setOpenId(null);
            setNotice("");
          }}
        >
          Reset example
        </Button>
      </div>
    </div>
  );
}

export function RunWorkspacePrototype() {
  const [kind, setKind] = useState<Example>("email");
  return (
    <AuthenticatedAppShell
      footer={null}
      mainContentId="prototype-main"
      navigationProgress={null}
      onSearchClick={() => {}}
    >
      <div className="border-b px-3 py-2 md:px-6">
        <Picker
          mode="segmented"
          label="Synthetic run kind"
          value={kind}
          onValueChange={(value) => {
            if (
              value === "email" ||
              value === "photo" ||
              value === "enrichment"
            )
              setKind(value);
          }}
          options={[
            { value: "email", label: "Email import" },
            { value: "photo", label: "Photo review" },
            { value: "enrichment", label: "Enrichment" },
          ]}
        />
      </div>
      <Workspace key={kind} kind={kind} />
    </AuthenticatedAppShell>
  );
}
