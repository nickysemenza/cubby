import {
  formatCollectionLabel,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Grid3X3, Plus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateQueryRoots } from "~/lib/query-keys";
import {
  collectionCreateMutationOptions,
  collectionListQueryOptions,
  collectionListRootKey,
} from "./collection.functions";

export function CollectionsIndexPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const collections = useQuery(collectionListQueryOptions());
  const [showCreate, setShowCreate] = useState(false);
  const nameId = useId();
  const subjectId = useId();
  const memberId = useId();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState<"product" | "location">("product");
  const [id, setId] = useState("");
  const create = useMutation({
    ...collectionCreateMutationOptions(),
    onSuccess: async (result) => {
      invalidateQueryRoots(queryClient, [collectionListRootKey()]);
      setShowCreate(false);
      setName("");
      setId("");
      await navigate({
        to: "/collections/$collection",
        params: { collection: result.slug },
      });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
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
          className="grid gap-2 border-border border-y bg-muted/20 py-4 md:grid-cols-[minmax(12rem,1fr)_9rem_minmax(12rem,1fr)_auto]"
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
              autoFocus
            />
          </label>
          <label className="space-y-1" htmlFor={subjectId}>
            <span className="eyebrow">First member</span>
            <NativeSelect
              id={subjectId}
              value={subject}
              onChange={(event) =>
                setSubject(event.target.value as "product" | "location")
              }
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
          <p className="text-muted-foreground text-xs md:col-span-4">
            A tag-backed Collection starts with a Product or Location; it cannot
            exist empty.
          </p>
        </form>
      )}

      {collections.isLoading ? (
        <p className="text-muted-foreground">Loading Collections…</p>
      ) : collections.data?.length ? (
        <div className="border-border border-t">
          {collections.data.map((collection) => (
            <Link
              key={collection.slug}
              to="/collections/$collection"
              params={{ collection: collection.slug }}
              className="grid min-h-12 grid-cols-[1fr_auto] items-center gap-4 border-border border-b px-2 py-2 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div>
                <div className="font-medium">
                  {formatCollectionLabel(collection.slug)}
                </div>
                <div className="text-muted-foreground text-xs">
                  {collection.productCount} products ·{" "}
                  {collection.rootLocationCount} tagged locations
                </div>
              </div>
              <ArrowRight className="size-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="border-border border-y py-8 text-center">
          <p className="font-medium">No Collections yet</p>
          <p className="text-muted-foreground text-xs">
            Create one from a Product or Location to start a shared locator.
          </p>
        </div>
      )}
    </Stack>
  );
}
