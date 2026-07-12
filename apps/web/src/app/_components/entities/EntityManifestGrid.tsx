import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  type EntityDescriptor,
  entityManifest,
  entityReferences,
} from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entities } from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { EntityReferenceGraph } from "./EntityReferenceGraph";

/** Inverse reference edges: who points AT `target`. */
function referencesInto(target: Entity): Entity[] {
  return allEntities.filter((e) => entityReferences(e).includes(target));
}

function Bool({ value }: { value: boolean }) {
  return value ? (
    <Check className="size-4 text-positive" aria-label="yes" />
  ) : (
    <Minus className="size-4 text-muted-foreground/40" aria-label="no" />
  );
}

function Chips({ items }: { items: readonly string[] }) {
  if (items.length === 0)
    return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="font-mono text-2xs">
          {item}
        </Badge>
      ))}
    </div>
  );
}

const mono = "font-mono text-xs tabular-nums";
const dash = <span className="text-muted-foreground/40">—</span>;

/** One settings row: a label + a render fn per entity. */
type Row = {
  label: string;
  cell: (ctx: {
    entity: Entity;
    d: EntityDescriptor;
    count: number | undefined;
  }) => ReactNode;
};

type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Live",
    rows: [
      {
        label: "Row count",
        cell: ({ count }) =>
          count === undefined ? dash : <span className={mono}>{count}</span>,
      },
    ],
  },
  {
    title: "Storage",
    rows: [
      {
        label: "DB table",
        cell: ({ d }) =>
          d.dbTable ? <span className={mono}>{d.dbTable}</span> : dash,
      },
      {
        label: "ID brand",
        cell: ({ d }) =>
          d.idBrand ? <span className={mono}>{d.idBrand}</span> : dash,
      },
      {
        label: "Shortcode",
        cell: ({ d }) =>
          d.shortcodePrefix ? (
            <span className={mono}>{d.shortcodePrefix}…</span>
          ) : (
            dash
          ),
      },
      { label: "Soft delete", cell: ({ d }) => <Bool value={d.softDelete} /> },
      { label: "Auditable", cell: ({ d }) => <Bool value={d.auditable} /> },
    ],
  },
  {
    title: "Schema & UI",
    rows: [
      {
        label: "Default sort",
        cell: ({ entity }) => {
          const sort = entities[entity].list?.defaultSort;
          return sort ? <span className={mono}>{sort}</span> : dash;
        },
      },
      {
        label: "Sortable fields",
        cell: ({ entity }) => (
          <Chips items={entities[entity].list?.sortableFields ?? []} />
        ),
      },
      {
        label: "Standard columns",
        cell: ({ entity }) => (
          <Chips items={entities[entity].list?.standardColumns ?? []} />
        ),
      },
      {
        label: "Common sections",
        cell: ({ entity }) => (
          <Chips items={entities[entity].detail?.commonSections ?? []} />
        ),
      },
      { label: "Has images", cell: ({ d }) => <Bool value={d.hasImages} /> },
      {
        label: "Can preview",
        cell: ({ entity }) => (
          <Bool value={getEntityContract(entity).canPreview} />
        ),
      },
    ],
  },
  {
    title: "API",
    rows: [
      {
        label: "Router",
        cell: ({ d }) => (
          <Badge
            variant={d.routerStyle === "crud-factory" ? "default" : "secondary"}
            className="text-2xs"
          >
            {d.routerStyle}
          </Badge>
        ),
      },
      { label: "MCP tools", cell: ({ d }) => <Chips items={d.mcp} /> },
      {
        label: "Invalidation keys",
        cell: ({ entity }) => (
          <span className={mono}>
            {getEntityContract(entity).invalidationKeys.length}
          </span>
        ),
      },
    ],
  },
  {
    title: "Relationships",
    rows: [
      {
        label: "References →",
        cell: ({ d }) => <Chips items={d.references} />,
      },
      {
        label: "← Referenced by",
        cell: ({ entity }) => <Chips items={referencesInto(entity)} />,
      },
    ],
  },
];

function EntityHeader({ entity }: { entity: Entity }) {
  const def = entities[entity];
  const Icon = def.lucideIcon;
  return (
    <Link
      to={def.routes.list}
      className="flex flex-col items-start gap-1 hover:underline"
    >
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded",
          def.color.bg,
          def.color.text,
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="font-mono text-2xs">{entity}</span>
    </Link>
  );
}

export function EntityManifestGrid() {
  const api = useTRPC();
  const session = authClient.useSession();
  const isAuthenticated = !!session.data?.user;
  const { data: counts } = useQuery({
    ...api.dashboard.counts.queryOptions(),
    enabled: isAuthenticated,
  });

  const countOf = (entity: Entity): number | undefined => {
    if (!counts) return undefined;
    // usda-food is the only key mismatch (counts.usdaFoods); every other
    // countable entity is keyed by its own name.
    if (entity === "usda-food") return counts.usdaFoods;
    return entityManifest[entity].countable
      ? counts[entity as keyof typeof counts]
      : undefined;
  };

  return (
    <Stack gap="lg">
      <Table containerClassName="overflow-x-auto" className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background text-left">
              setting
            </TableHead>
            {allEntities.map((entity) => (
              <TableHead key={entity} className="px-2">
                <EntityHeader entity={entity} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {GROUPS.flatMap((group) => [
            <TableRow key={`${group.title}-h`} className="bg-muted/40">
              <TableCell
                colSpan={allEntities.length + 1}
                className="sticky left-0 font-mono text-2xs text-muted-foreground uppercase tracking-wider"
              >
                {group.title}
              </TableCell>
            </TableRow>,
            ...group.rows.map((row) => (
              <TableRow key={`${group.title}-${row.label}`}>
                <TableCell className="sticky left-0 z-10 whitespace-nowrap bg-background font-medium text-xs">
                  {row.label}
                </TableCell>
                {allEntities.map((entity) => (
                  <TableCell key={entity} className="px-2 align-top">
                    {row.cell({
                      entity,
                      d: entityManifest[entity],
                      count: countOf(entity),
                    })}
                  </TableCell>
                ))}
              </TableRow>
            )),
          ])}
        </TableBody>
      </Table>

      <Stack gap="sm">
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-wider">
          Reference graph
        </h2>
        <EntityReferenceGraph />
      </Stack>
    </Stack>
  );
}
