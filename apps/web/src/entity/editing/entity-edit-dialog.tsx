import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, Suspense, use, useEffect, useState } from "react";
import { z } from "zod";

import { entityDetailFor } from "~/entity/entity-detail";
import { entityMetadataQueryOptions } from "~/entity/metadata";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Overlay } from "~/ui/overlays/overlay";

import type {
  EntityEditIntent as TypedEntityEditIntent,
  EntityEditResultFor,
} from "./intent-types";
import type {
  EditableEntity,
  EntityEditRequest,
  EntityMutationPort,
  EntityEditRecord,
} from "./types";
import type { EntityEditValueBag } from "./value-schema";

/**
 * A dialog request names its intent explicitly: the generic shell has no
 * per-entity default beyond the registry's, and a caller that means "the
 * default" spells it so the presentation lookup (`editor-presentations.tsx`)
 * is a plain key match.
 */
type DialogRequestFor<
  E extends EditableEntity,
  O extends "create" | "update",
> = Omit<EntityEditRequest<E, O>, "surface"> & {
  intent: TypedEntityEditIntent<E, O>;
};

type SupportedEntityEditDialogRequest = {
  [K in EditableEntity]:
    | DialogRequestFor<K, "create">
    | DialogRequestFor<K, "update">;
}[EditableEntity];

export type EntityEditDialogRequest<E extends EditableEntity = EditableEntity> =
  Extract<SupportedEntityEditDialogRequest, { entity: E }>;

export interface EntityEditDialogProps<E extends EditableEntity> {
  /** Optional source evidence shown beside the existing editor fields. */
  evidence?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: EntityEditDialogRequest<E>;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
  /** Any accepted submit, including one that changed nothing (no `onSuccess`). */
  onSubmitted?: () => void;
  /** Own the commit when an editor action must be atomic with another record. */
  onSubmitOverride?: (values: EntityEditValueBag) => Promise<void>;
  /** A local command adapter for a surface whose remote transport is unavailable. */
  mutationPort?: EntityMutationPort;
}

export function EntityEditDialog<E extends EditableEntity>(
  props: EntityEditDialogProps<E>,
) {
  if (!props.open || import.meta.env.SSR) return null;
  return (
    <Suspense
      fallback={
        <Overlay
          open={props.open}
          onOpenChange={props.onOpenChange}
          title="Loading editor…"
        >
          <output>Loading editor…</output>
        </Overlay>
      }
    >
      <OpenEntityEditDialog {...props} />
    </Suspense>
  );
}

let contentModule:
  | Promise<typeof import("./entity-edit-dialog-content")>
  | undefined;

function loadEditorContent() {
  if (!contentModule) {
    contentModule = import("./entity-edit-dialog-content");
    // SILENT: Metadata can still be loading when this import rejects. The
    // content reader retains the rejection and surfaces it through React.
    void contentModule.catch(() => {});
  }
  return contentModule;
}

function DeferredEntityEditDialogContent<E extends EditableEntity>(
  props: EntityEditDialogProps<E> & { baseline?: EntityEditRecord },
) {
  const { EntityEditDialogContent } = use(loadEditorContent());
  return <EntityEditDialogContent {...props} />;
}

/** Picker/calendar dialogs admit their own entity without suspending the action host. */
function OpenEntityEditDialog<E extends EditableEntity>(
  props: EntityEditDialogProps<E>,
) {
  // Code and metadata start together only after the dialog opens.
  loadEditorContent();
  const metadata = useQuery(entityMetadataQueryOptions(props.request.entity));
  if (!metadata.data)
    return (
      <Overlay
        open={props.open}
        onOpenChange={props.onOpenChange}
        title="Loading editor…"
      >
        {metadata.error ? (
          <ErrorDisplay
            error={metadata.error}
            onRetry={() => {
              void metadata.refetch();
            }}
          />
        ) : (
          <output>Loading editor…</output>
        )}
      </Overlay>
    );
  // A scoped correction owns its reviewed field projection, not a full baseline.
  if (
    props.request.operation === "update" &&
    props.request.record &&
    !props.request.fieldScope &&
    !props.mutationPort
  )
    return (
      <EntityEditDialogBaseline {...props} record={props.request.record} />
    );
  return <DeferredEntityEditDialogContent {...props} />;
}

const baselineSchema = z.object({ id: z.string() }).passthrough();

/** Only opening a dependent editor waits for its invalidated full baseline. */
function EntityEditDialogBaseline<E extends EditableEntity>(
  props: EntityEditDialogProps<E> & { record: EntityEditRecord },
) {
  const client = useQueryClient();
  const options = entityDetailFor(props.request.entity).queryOptions(
    props.record.id,
  );
  const [needsFresh] = useState(() => {
    const state = client.getQueryState(options.queryKey);
    return !state?.data || state.isInvalidated;
  });
  const [baseline, setBaseline] = useState<EntityEditRecord | undefined>(() =>
    needsFresh
      ? undefined
      : baselineSchema.parse(client.getQueryData(options.queryKey)),
  );
  const query = useQuery({ ...options, enabled: needsFresh && !baseline });
  useEffect(() => {
    if (
      !baseline &&
      query.isSuccess &&
      query.fetchStatus === "idle" &&
      query.data
    )
      setBaseline(baselineSchema.parse(query.data));
  }, [baseline, query.isSuccess, query.fetchStatus, query.data]);
  if (baseline)
    return <DeferredEntityEditDialogContent {...props} baseline={baseline} />;
  return (
    <Overlay
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Loading current values…"
    >
      {query.error ? (
        <ErrorDisplay
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.isSuccess && !query.data ? (
        <ErrorDisplay error={new Error("This record no longer exists.")} />
      ) : (
        <output>
          {query.fetchStatus === "paused"
            ? "Waiting for a connection to load current values…"
            : "Loading current values…"}
        </output>
      )}
    </Overlay>
  );
}
