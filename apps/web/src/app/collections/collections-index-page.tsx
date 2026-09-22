import {
  formatCollectionLabel,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Grid3X3, Plus, Sparkles } from "lucide-react";
import { useId, useState } from "react";

import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { focusOnMount } from "~/hooks/focus-on-mount";

import { collection } from "./collection.functions";
import { useSmartCollections } from "./smart-collection-state";

type CollectionsIndexOperations = Pick<
  typeof collection,
  "create" | "list" | "smartList"
>;

const SMART_SOURCE_LABELS = {
  productTagEquals: "tag",
  manufacturerEquals: "manufacturer",
  locationNameContains: "location",
  historicalExpenseTrade: "Trade",
} as const;

const SMART_SOURCE_KINDS = [
  "productTagEquals",
  "manufacturerEquals",
  "locationNameContains",
  "historicalExpenseTrade",
] as const;

export function CollectionsIndexPage({
  operations = collection,
}: {
  operations?: CollectionsIndexOperations;
}) {
  const navigate = useNavigate();
  const collections = useQuery(operations.list.queryOptions(null));
  const { validDefinitions } = useSmartCollections();
  const definitions = Object.values(validDefinitions);
  const smartCollections = useQuery(
    operations.smartList.queryOptions({ definitions }),
  );
  const [showCreate, setShowCreate] = useState(false);
  const nameId = useId();
  const subjectId = useId();
  const memberId = useId();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState<"product" | "location">("product");
  const [id, setId] = useState("");
  const create = useMutation({
    ...operations.create.mutationOptions(),
    onSuccess: async (result) => {
      setShowCreate(false);
      setName("");
      setId("");
      await navigate({
        to: "/collections/$collection",
        params: { collection: result.slug },
      });
    },
  });
  const slug = normalizeCollectionSlug(name);

  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          render={<Link to="/collections/assignments" />}
        >
          <Grid3X3 /> Manage assignments
        </Button>
        <Button type="button" onClick={() => setShowCreate((value) => !value)}>
          <Plus /> New Collection
        </Button>
      </div>

      {showCreate && (
        <form
          className="grid gap-2 border-y border-border bg-muted/20 py-4 md:grid-cols-[minmax(12rem,1fr)_9rem_minmax(12rem,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            if (!slug || !id.trim()) return;
            create.mutate({
              collection: slug,
              subject,
              id: id.trim(),
            });
          }}
        >
          <label className="space-y-1" htmlFor={nameId}>
            <span className="eyebrow">Collection name</span>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Painting"
              ref={focusOnMount}
            />
          </label>
          <label className="space-y-1" htmlFor={subjectId}>
            <span className="eyebrow">First member</span>
            <NativeSelect
              id={subjectId}
              value={subject}
              onChange={(event) => {
                const nextSubject = event.target.value;
                if (nextSubject === "product" || nextSubject === "location") {
                  setSubject(nextSubject);
                }
              }}
            >
              <option value="product">Product</option>
              <option value="location">Location</option>
            </NativeSelect>
          </label>
          <label className="space-y-1" htmlFor={memberId}>
            <span className="eyebrow">Shortcode</span>
            <Input
              id={memberId}
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder={subject === "product" ? "PRD-…" : "LOC-…"}
            />
          </label>
          <Button
            type="submit"
            className="self-end"
            disabled={!slug || !id.trim() || create.isPending}
          >
            Create
          </Button>
          <p className="text-xs text-muted-foreground md:col-span-4">
            A tag-backed Collection starts with a Product or Location; it cannot
            exist empty.
          </p>
        </form>
      )}

      <section aria-labelledby="smart-starters-heading">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary" aria-hidden />
              <h2 id="smart-starters-heading" className="text-sm font-semibold">
                Smart starters
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live Product groups built from recorded household details.
            </p>
          </div>
          <span className="text-2xs text-muted-foreground">
            Editable until refresh
          </span>
        </div>

        {smartCollections.isLoading ? (
          <p className="border-y border-border py-5 text-sm text-muted-foreground">
            Finding smart Collection matches…
          </p>
        ) : smartCollections.error ? (
          <div className="border-y border-destructive/40 py-5">
            <p className="text-sm font-medium text-destructive">
              Could not load smart Collections
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {smartCollections.error.message}
            </p>
          </div>
        ) : (
          <div className="border-t border-border">
            {definitions.map((definition) => {
              const summary = smartCollections.data?.find(
                (item) => item.key === definition.key,
              );
              const sources = summary
                ? SMART_SOURCE_KINDS.map(
                    (kind) => [kind, summary.sourceCounts[kind]] as const,
                  )
                    .filter(([, count]) => count > 0)
                    .map(
                      ([kind, count]) =>
                        `${count} ${SMART_SOURCE_LABELS[kind]}`,
                    )
                : [];
              return (
                <Link
                  key={definition.key}
                  to="/collections/smart/$starter"
                  params={{ starter: definition.key }}
                  className="group grid min-h-14 grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-2 py-2 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <div className="min-w-0">
                    <div className="font-medium group-hover:text-primary">
                      {definition.name}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">
                        {summary?.totalCount ?? 0}
                      </span>{" "}
                      products
                      {sources.length > 0 && ` · ${sources.join(" · ")}`}
                    </div>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary" />
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="manual-collections-heading">
        <h2
          id="manual-collections-heading"
          className="mb-2 text-sm font-semibold"
        >
          Assigned Collections
        </h2>

        {collections.isLoading ? (
          <p className="text-muted-foreground">Loading Collections…</p>
        ) : collections.data?.length ? (
          <div className="border-t border-border">
            {collections.data.map((collection) => (
              <Link
                key={collection.slug}
                to="/collections/$collection"
                params={{ collection: collection.slug }}
                className="grid min-h-12 grid-cols-[1fr_auto] items-center gap-4 border-b border-border px-2 py-2 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div>
                  <div className="font-medium">
                    {formatCollectionLabel(collection.slug)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {collection.productCount} products ·{" "}
                    {collection.rootLocationCount} tagged locations
                  </div>
                </div>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="border-y border-border py-8 text-center">
            <p className="font-medium">No Collections yet</p>
            <p className="text-xs text-muted-foreground">
              Create one from a Product or Location to start a shared locator.
            </p>
          </div>
        )}
      </section>
    </Stack>
  );
}
