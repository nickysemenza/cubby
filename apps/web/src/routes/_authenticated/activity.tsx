import { type AuditEntityType, auditEntitySchema } from "@cubby/schemas/audit";
import {
  APPLICATION_AUDIT_SOURCES,
  type AuditSource,
  auditSourceSchema,
} from "@cubby/schemas/context";
import { auditableEntities } from "@cubby/schemas/entity-manifest";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { listChromePage } from "~/app/_components/routing/entity-routes";
import { Row, Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { entityPluralLabel } from "~/entities/entities";
import { auditLogListInfiniteQueryOptions } from "~/lib/audit-log.functions";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  // The feed's only controls — `auditLogListInput` already accepts both,
  // this just exposes them (and keeps a filtered view linkable/refreshable).
  entityType: auditEntitySchema.optional().catch(undefined),
  // Accepts the full `auditSourceSchema` (including a deep-linked
  // `script:<slug>` value) even though the UI select below only offers the
  // closed `APPLICATION_AUDIT_SOURCES` set — the open-ended `script:` family
  // has no bounded picklist to enumerate.
  source: auditSourceSchema.optional().catch(undefined),
});

const searchDefaults = { entityType: undefined, source: undefined } as const;

// Bound to a const, not inlined into the options object below: see
// `entity-routes.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call. Must be defined (and
// initialized) before `Route` reads it below — `const` isn't hoisted the way
// `function ActivityBody` is.
const ActivityPage = listChromePage({
  title: "Activity",
  page: ActivityBody,
});

export const Route = createFileRoute("/_authenticated/activity")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  // Warm the first page of the audit feed during route load so the list renders
  // hydrated instead of flashing a spinner on mount. Input + getNextPageParam
  // must match AuditLogList's useInfiniteQuery (default limit 20, same entity
  // filter) or the cache won't be reused — hence the `loaderDeps`. prefetch
  // (not ensure) so a cold feed never blocks navigation.
  loaderDeps: ({ search }) => ({
    entityType: search.entityType,
    source: search.source,
  }),
  loader: async ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(
      auditLogListInfiniteQueryOptions(
        { limit: 20, entityType: deps.entityType, source: deps.source },
        { getNextPageParam: (lastPage) => lastPage.nextCursor },
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("Activity") }] }),
  component: ActivityPage,
});

/**
 * Scope filter over the auditable entity set (manifest-derived, so a newly
 * auditable entity appears here automatically). Native select, matching the
 * cookbook scope filter's idiom.
 */
function EntityTypeFilter({
  value,
  onChange,
}: {
  value: AuditEntityType | undefined;
  onChange: (entityType: AuditEntityType | undefined) => void;
}) {
  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Entity</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value ? (e.target.value as AuditEntityType) : undefined,
          )
        }
      >
        <option value="">All entities</option>
        {auditableEntities.map((entity) => (
          <option key={entity} value={entity}>
            {entityPluralLabel(entity)}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}

/**
 * Source filter over the closed `APPLICATION_AUDIT_SOURCES` set — the
 * open-ended `script:<slug>` family has no bounded list to enumerate here, so
 * it's reachable only via a deep link that sets `?source=script:...` directly
 * (the search schema still accepts it; this select just can't produce it).
 */
function SourceFilter({
  value,
  onChange,
}: {
  value: AuditSource | undefined;
  onChange: (source: AuditSource | undefined) => void;
}) {
  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Source</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value ? (e.target.value as AuditSource) : undefined)
        }
      >
        <option value="">All sources</option>
        {APPLICATION_AUDIT_SOURCES.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}

function ActivityBody() {
  const { entityType, source } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <Stack className="max-w-3xl">
      <Row justify="between" align="center" gap="sm" wrap>
        {/* Every auditable entity writes here (products through projects,
            tasks and expenses) — kept generic rather than listing a subset
            that drifts as the manifest grows. */}
        <p className="text-muted-foreground">
          Recent changes across all entities.
        </p>
        <Row gap="sm" wrap>
          <EntityTypeFilter
            value={entityType}
            onChange={(next) =>
              navigate({
                search: (prev) => ({ ...prev, entityType: next }),
              })
            }
          />
          <SourceFilter
            value={source}
            onChange={(next) =>
              navigate({
                search: (prev) => ({ ...prev, source: next }),
              })
            }
          />
        </Row>
      </Row>
      <AuditLogList
        showEntityLink={true}
        entityType={entityType}
        source={source}
      />
    </Stack>
  );
}
