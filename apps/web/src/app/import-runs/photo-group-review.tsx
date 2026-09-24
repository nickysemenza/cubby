import type {
  ImageShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobState } from "@cubby/schemas/image-processing";
import {
  photoRunReviewResponse,
  reviewPhotoGroupsOutput,
  type PhotoGroupProposal,
  type PhotoGroupProposalGroup,
  type PhotoRunImage,
  type PhotoRunReview,
  type ReviewPhotoGroupsAction,
} from "@cubby/schemas/photo-import-run";
import { ArrowsMergeIcon } from "@phosphor-icons/react/dist/csr/ArrowsMerge";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { referenceEntitySearch } from "~/app/_components/combobox/reference-entity-search";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { StatusText } from "~/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { readJsonOrThrow } from "~/lib/http-error";
import {
  IMPORT_RUN_TARGET_STATE_LABEL,
  IMPORT_RUN_TARGET_STATE_VARIANT,
} from "~/lib/import-run-target-state";

import {
  mergeGroups,
  moveImage,
  toGroupInput,
  type ProposalEdit,
} from "./photo-review-model";

/** Statuses during which the agent or the device may still change the run. */
const LIVE_RUN_STATUSES = new Set([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
]);

const reviewQueryKey = (runId: string) =>
  ["purchase-import", "run", runId, "photo-review"] as const;

async function fetchReview(runId: string): Promise<PhotoRunReview> {
  const response = await fetch(
    `/api/import/runs/${encodeURIComponent(runId)}/photo-groups`,
  );
  return readJsonOrThrow(
    response,
    photoRunReviewResponse,
    "Photo groups could not load.",
  );
}

async function postReview(runId: string, action: ReviewPhotoGroupsAction) {
  const response = await fetch(
    `/api/import/runs/${encodeURIComponent(runId)}/photo-groups`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    },
  );
  return readJsonOrThrow(
    response,
    reviewPhotoGroupsOutput,
    "Photo groups could not be updated.",
    { method: "POST" },
  );
}

/** Photos and proposals poll while the run is live, like the run itself. */
export function usePhotoRunReview(runId: string, runStatus: string) {
  return useQuery({
    queryKey: reviewQueryKey(runId),
    queryFn: () => fetchReview(runId),
    refetchInterval: LIVE_RUN_STATUSES.has(runStatus) ? 3_000 : false,
  });
}

function useReviewAction(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `photo-run-review-${runId}` },
    mutationFn: (action: ReviewPhotoGroupsAction) => postReview(runId, action),
    onSuccess: (data) => {
      queryClient.setQueryData<PhotoRunReview>(reviewQueryKey(runId), (old) =>
        old
          ? {
              ...old,
              review: {
                runId: data.runId,
                runStatus: data.runStatus,
                proposals: data.proposals,
                unassignedImageIds: data.unassignedImageIds,
              },
            }
          : old,
      );
      // Approval changes photo states and may complete the run.
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", runId],
      });
      const problems = data.results.filter(
        (result) =>
          result.outcome === "conflict" || result.outcome === "failed",
      );
      const committed = data.results.length - problems.length;
      if (problems.length) {
        toast.warning(
          `${committed} approved · ${problems.length} need attention`,
          {
            description: problems
              .map(
                (result) =>
                  `${result.groupKey}: ${result.outcome === "conflict" ? "name matches an existing product" : result.error}`,
              )
              .join("\n"),
          },
        );
      } else if (committed) {
        toast.success(
          committed === 1 ? "Group approved" : `${committed} groups approved`,
        );
      }
      if (data.frozenGroupKeys.length) {
        toast.warning("Some groups were already settled", {
          description: `Left unchanged: ${data.frozenGroupKeys.join(", ")}`,
        });
      }
    },
    onError: (error) => showErrorToast(error),
  });
}

/** Takes a builder so an edit that cannot be expressed (see `toGroupInput`) surfaces as a toast instead of an uncaught handler error. */
type Save = (build: () => ProposalEdit) => void;
type SaveGroup = (build: () => PhotoGroupProposalGroup) => void;
type ImagesById = ReadonlyMap<string, PhotoRunImage>;
const WithProductCategorySearch = referenceEntitySearch("productCategory");

const isStaleGroup = (proposal: PhotoGroupProposal, imagesById: ImagesById) =>
  proposal.missingImageCount > 0 ||
  [...proposal.images, ...proposal.skip].some((entry) => {
    const photo = imagesById.get(entry.id);
    return photo !== undefined && photo.targetState !== "pending";
  });

const proposalName = (proposal: PhotoGroupProposal): string =>
  proposal.product.kind === "create"
    ? proposal.product.create.name
    : (proposal.product.existing?.name ?? "Deleted product — pick another");

function PhotoThumb({
  image,
  size,
  dimmed,
}: {
  image: PhotoRunImage | undefined;
  size: number;
  dimmed?: boolean;
}) {
  return (
    <Image
      src={image?.originalUrl}
      alt={image?.description ?? image?.id ?? "Run photo"}
      displayWidth={size}
      style={{ width: size, height: size }}
      className={`rounded-md border border-border object-cover ${dimmed ? "opacity-50 grayscale" : ""}`}
    />
  );
}

function ImageMenu({
  imageId,
  groupKey,
  purpose,
  proposals,
  save,
  disabled,
}: {
  imageId: ImageShortcode;
  groupKey: string | null;
  purpose: "item" | "label" | null;
  proposals: readonly PhotoGroupProposal[];
  save: Save;
  disabled: boolean;
}) {
  const targets = proposals.filter(
    (proposal) =>
      proposal.state === "proposed" && proposal.groupKey !== groupKey,
  );
  const owner = proposals.find((proposal) => proposal.groupKey === groupKey);
  const setPurpose = (next: "item" | "label") => {
    if (!owner) return;
    save(() => {
      const input = toGroupInput(owner);
      return {
        groups: [
          {
            ...input,
            images:
              purpose === null
                ? [...input.images, { id: imageId, purpose: next }]
                : input.images.map((image) =>
                    image.id === imageId ? { ...image, purpose: next } : image,
                  ),
            skip:
              purpose === null
                ? input.skip?.filter((image) => image.id !== imageId)
                : input.skip,
          },
        ],
        removeGroupKeys: [],
      };
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="secondary"
            size="icon-xs"
            aria-label={`Photo ${imageId} actions`}
          />
        }
      >
        <DotsThreeIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {groupKey ? (
          <>
            <DropdownMenuItem
              onClick={() => setPurpose(purpose === "item" ? "label" : "item")}
            >
              Mark as {purpose === "item" ? "label" : "item"} photo
            </DropdownMenuItem>
            {purpose === null ? (
              <DropdownMenuItem onClick={() => setPurpose("label")}>
                Mark as label photo
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onClick={() => save(() => moveImage(proposals, imageId, null))}
        >
          {groupKey ? "Split into a new group" : "Start a new group"}
        </DropdownMenuItem>
        {targets.length ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {targets.map((target) => (
              <DropdownMenuItem
                key={target.groupKey}
                onClick={() =>
                  save(() => moveImage(proposals, imageId, target.groupKey))
                }
              >
                <span className="truncate">{proposalName(target)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupPhotos({
  proposal,
  proposals,
  imagesById,
  save,
  editable,
  busy,
}: {
  proposal: PhotoGroupProposal;
  proposals: readonly PhotoGroupProposal[];
  imagesById: ImagesById;
  save: Save;
  editable: boolean;
  busy: boolean;
}) {
  return (
    <Row wrap gap="sm" align="start">
      {proposal.images.map((entry) => (
        <figure key={entry.id} className="relative m-0">
          <PhotoThumb image={imagesById.get(entry.id)} size={112} />
          <Badge
            variant={entry.purpose === "item" ? "default" : "outline"}
            className="absolute bottom-1 left-1 bg-card"
          >
            {entry.purpose === "item" ? "Item" : "Label"}
          </Badge>
          {editable ? (
            <div className="absolute top-1 right-1">
              <ImageMenu
                imageId={entry.id}
                groupKey={proposal.groupKey}
                purpose={entry.purpose}
                proposals={proposals}
                save={save}
                disabled={busy}
              />
            </div>
          ) : null}
        </figure>
      ))}
      {proposal.skip.map((entry) => (
        <figure key={entry.id} className="relative m-0" title={entry.reason}>
          <PhotoThumb image={imagesById.get(entry.id)} size={112} dimmed />
          <Badge variant="secondary" className="absolute bottom-1 left-1">
            Skipped
          </Badge>
          {editable ? (
            <div className="absolute top-1 right-1">
              <ImageMenu
                imageId={entry.id}
                groupKey={proposal.groupKey}
                purpose={null}
                proposals={proposals}
                save={save}
                disabled={busy}
              />
            </div>
          ) : null}
        </figure>
      ))}
    </Row>
  );
}

/** A text field that saves when it loses focus (or on Enter) and only when changed. */
function CommitInput({
  label,
  value,
  onCommit,
  disabled,
  type = "text",
  className,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  disabled: boolean;
  type?: "text" | "number";
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs ${className ?? ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <Input
        type={type}
        min={type === "number" ? 1 : undefined}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function ProductPicker({
  onPick,
  disabled,
  placeholder,
}: {
  onPick: (id: ProductShortcode) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <WithEntitySearch entity="product">
      {({ items, onSearchChange, isLoading, onOpenChange }) => (
        <EntityPicker
          entity="product"
          label="existing product"
          items={items}
          value={null}
          setValue={(item) => {
            if (item) onPick(item.id);
          }}
          onSearchChange={onSearchChange}
          onOpenChange={onOpenChange}
          isLoading={isLoading}
          disabled={disabled}
          placeholder={placeholder}
        />
      )}
    </WithEntitySearch>
  );
}

function ProductPanel({
  proposal,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  save: Save;
  busy: boolean;
}) {
  const saveGroup: SaveGroup = (build) =>
    save(() => ({ groups: [build()], removeGroupKeys: [] }));
  const saveProduct = (next: PhotoGroupProposalGroup["product"]) =>
    saveGroup(() => toGroupInput(proposal, { product: next }));
  const attachExisting = (existingId: ProductShortcode) =>
    saveProduct({ kind: "existing", existingId });
  const product = proposal.product;
  return (
    <Stack gap="sm" className="min-w-0">
      <Row gap="sm" align="end" wrap className="min-w-0">
        <div className="min-w-0 flex-1">
          <ProductPicker
            disabled={busy}
            placeholder={
              product.kind === "existing"
                ? "Choose a different product"
                : "Search existing products before creating another"
            }
            onPick={attachExisting}
          />
        </div>
        {product.kind === "existing" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              saveProduct({
                kind: "create",
                create: {
                  name: product.existing?.name ?? proposal.groupKey,
                },
              })
            }
          >
            Create new instead
          </Button>
        ) : null}
      </Row>
      {product.kind === "existing" ? (
        product.existing ? (
          <Row gap="sm" align="center" className="min-w-0">
            <Image
              src={product.existing.coverUrl ?? undefined}
              alt={product.existing.name}
              displayWidth={64}
              className="size-16 shrink-0 rounded-md border border-border object-cover"
            />
            <Stack gap="tight" className="min-w-0">
              <span className="text-2xs text-muted-foreground">
                Attach to existing product
              </span>
              <EntityInlineLink
                entity="product"
                data={{ id: product.existing.id, name: product.existing.name }}
                displayImage={null}
                truncate
                className="min-w-0 text-sm font-medium"
              />
            </Stack>
          </Row>
        ) : (
          <StatusText tone="warning">
            The chosen product was deleted. Pick another or create one.
          </StatusText>
        )
      ) : (
        <Stack gap="sm">
          <CommitInput
            label="New product name"
            value={product.create.name}
            disabled={busy}
            onCommit={(name) =>
              name &&
              saveProduct({
                kind: "create",
                create: { ...product.create, name },
              })
            }
          />
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Category</span>
            <WithProductCategorySearch>
              {({ items, onSearchChange, isLoading, onOpenChange }) => (
                <EntityPicker
                  entity="productCategory"
                  label="category"
                  items={items}
                  value={
                    items.find(
                      (item) => item.id === product.create.categoryId,
                    ) ?? null
                  }
                  setValue={(item) =>
                    saveProduct({
                      kind: "create",
                      create: {
                        ...product.create,
                        categoryId: item
                          ? productCategoryShortcode.parse(item.id)
                          : null,
                      },
                    })
                  }
                  onSearchChange={onSearchChange}
                  onOpenChange={onOpenChange}
                  isLoading={isLoading}
                  disabled={busy}
                  placeholder="Choose a category"
                  clearable
                />
              )}
            </WithProductCategorySearch>
          </label>
          <Row gap="sm" className="min-w-0">
            <CommitInput
              label="Manufacturer"
              className="flex-1"
              value={product.create.manufacturer ?? ""}
              disabled={busy}
              onCommit={(manufacturer) =>
                saveProduct({
                  kind: "create",
                  create: { ...product.create, manufacturer },
                })
              }
            />
            <CommitInput
              label="Model"
              className="flex-1"
              value={product.create.model ?? ""}
              disabled={busy}
              onCommit={(model) =>
                saveProduct({
                  kind: "create",
                  create: { ...product.create, model: model || null },
                })
              }
            />
          </Row>
        </Stack>
      )}

      {proposal.conflict?.length ? (
        <Stack
          gap="xs"
          className="rounded-md border border-warning/30 bg-warning/10 p-2"
        >
          <StatusText tone="warning" className="text-xs font-medium">
            This name already belongs to a product. Attach to it, or rename.
          </StatusText>
          {proposal.conflict.map((match) => (
            <Row key={match.id} gap="sm" align="center" className="min-w-0">
              <Image
                src={match.coverUrl ?? undefined}
                alt={match.name}
                displayWidth={40}
                className="size-10 shrink-0 rounded-sm border border-border object-cover"
              />
              <EntityInlineLink
                entity="product"
                data={{ id: match.id, name: match.name }}
                displayImage={null}
                truncate
                className="min-w-0 flex-1 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => attachExisting(match.id)}
              >
                Use this product
              </Button>
            </Row>
          ))}
        </Stack>
      ) : null}

      <InventoryFields proposal={proposal} save={saveGroup} busy={busy} />

      {proposal.evidence ? (
        <details className="border-t border-border pt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            Why this item was proposed
          </summary>
          <p className="mt-2 leading-relaxed whitespace-pre-wrap">
            {proposal.evidence}
          </p>
        </details>
      ) : null}
    </Stack>
  );
}

function InventoryFields({
  proposal,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  save: SaveGroup;
  busy: boolean;
}) {
  const inventory = proposal.inventory;
  const quantity = inventory?.quantity ?? 1;
  const selected =
    inventory?.locationId && inventory.locationName
      ? { id: inventory.locationId, name: inventory.locationName }
      : null;
  return (
    <Row gap="sm" align="end" className="min-w-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Receive into</span>
        <WithEntitySearch entity="location">
          {({ items, onSearchChange, isLoading, onOpenChange }) => (
            <EntityPicker
              entity="location"
              label="location"
              items={items}
              value={selected}
              setValue={(item) =>
                save(() =>
                  toGroupInput(proposal, {
                    inventory: item
                      ? {
                          ownershipMode: inventory?.ownershipMode,
                          ownerPartyId: inventory?.ownerPartyId,
                          locationId: item.id,
                          quantity,
                        }
                      : undefined,
                  }),
                )
              }
              onSearchChange={onSearchChange}
              onOpenChange={onOpenChange}
              isLoading={isLoading}
              disabled={busy}
              placeholder="No inventory entry"
              clearable
            />
          )}
        </WithEntitySearch>
      </div>
      {inventory?.locationId ? (
        <CommitInput
          label="Qty"
          type="number"
          className="w-20"
          value={String(quantity)}
          disabled={busy}
          onCommit={(next) => {
            const parsed = Number.parseInt(next, 10);
            if (Number.isInteger(parsed) && parsed > 0)
              save(() => {
                const input = toGroupInput(proposal);
                return input.inventory
                  ? {
                      ...input,
                      inventory: { ...input.inventory, quantity: parsed },
                    }
                  : input;
              });
          }}
        />
      ) : null}
    </Row>
  );
}

function ProposalCard({
  proposal,
  proposals,
  imagesById,
  busy,
  save,
  action,
}: {
  proposal: PhotoGroupProposal;
  proposals: readonly PhotoGroupProposal[];
  imagesById: ImagesById;
  busy: boolean;
  save: Save;
  action: ReturnType<typeof useReviewAction>;
}) {
  const working = busy;
  const mergeTargets = proposals.filter(
    (other) =>
      other.state === "proposed" && other.groupKey !== proposal.groupKey,
  );
  // Photos deleted or settled outside this review (e.g. a direct commit) make
  // the group unapprovable and undiscardable; removing it is the way out.
  const stale = isStaleGroup(proposal, imagesById);
  return (
    <Card>
      <CardHeader>
        <Row align="center" justify="between" wrap gap="sm">
          <Row align="center" gap="sm" className="min-w-0">
            <CardTitle as="h3" className="truncate">
              {proposalName(proposal)}
            </CardTitle>
            <Badge
              variant={
                proposal.product.kind === "create" ? "default" : "secondary"
              }
            >
              {proposal.product.kind === "create"
                ? "New product"
                : "Existing product"}
            </Badge>
            <span className="hidden font-mono text-2xs text-muted-foreground lg:inline">
              {proposal.groupKey}
            </span>
          </Row>
          <Row align="center" gap="xs" wrap className="w-full sm:w-auto">
            {mergeTargets.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={working}
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 sm:min-h-0"
                    />
                  }
                >
                  <ArrowsMergeIcon />
                  Merge into…
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Move every photo into</DropdownMenuLabel>
                    {mergeTargets.map((target) => (
                      <DropdownMenuItem
                        key={target.groupKey}
                        onClick={() =>
                          save(() =>
                            mergeGroups(
                              proposals,
                              proposal.groupKey,
                              target.groupKey,
                            ),
                          )
                        }
                      >
                        <span className="truncate">{proposalName(target)}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {stale ? (
              <Button
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() =>
                  save(() => ({
                    groups: [],
                    removeGroupKeys: [proposal.groupKey],
                  }))
                }
              >
                Remove group
              </Button>
            ) : null}
            <Button
              variant="destructive"
              size="sm"
              className="min-h-11 sm:min-h-0"
              disabled={working || stale}
              onClick={() =>
                action.mutate({
                  action: "discard",
                  groupKey: proposal.groupKey,
                })
              }
            >
              <TrashIcon />
              Discard
            </Button>
            <Button
              size="sm"
              className="min-h-11 flex-1 sm:min-h-0 sm:flex-none"
              disabled={
                working ||
                stale ||
                (proposal.product.kind === "existing" &&
                  !proposal.product.existing)
              }
              onClick={() =>
                action.mutate({
                  action: "approve",
                  groupKeys: [proposal.groupKey],
                })
              }
            >
              <CheckIcon />
              Approve
            </Button>
          </Row>
        </Row>
      </CardHeader>
      <CardContent>
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
          <GroupPhotos
            proposal={proposal}
            proposals={proposals}
            imagesById={imagesById}
            save={save}
            editable
            busy={working}
          />
          <ProductPanel proposal={proposal} save={save} busy={working} />
        </div>
        {proposal.missingImageCount ? (
          <StatusText as="p" tone="warning" className="mt-3 text-xs">
            {proposal.missingImageCount === 1
              ? "1 photo in this group was deleted."
              : `${proposal.missingImageCount} photos in this group were deleted.`}
          </StatusText>
        ) : null}
        {stale ? (
          <StatusText as="p" tone="warning" className="mt-3 text-xs">
            This group includes photos that can no longer be reviewed. Remove
            the group to continue.
          </StatusText>
        ) : null}
        {proposal.lastError ? (
          <StatusText as="p" tone="destructive" className="mt-3 text-xs">
            Last approval failed: {proposal.lastError}
          </StatusText>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SettledRow({
  proposal,
  imagesById,
}: {
  proposal: PhotoGroupProposal;
  imagesById: ImagesById;
}) {
  const committed = proposal.committedProduct;
  return (
    <TableRow>
      <TableCell>
        <Row gap="xs">
          {[...proposal.images, ...proposal.skip].slice(0, 6).map((entry) => (
            <PhotoThumb
              key={entry.id}
              image={imagesById.get(entry.id)}
              size={32}
              dimmed={proposal.state === "discarded"}
            />
          ))}
        </Row>
      </TableCell>
      <TableCell className="max-w-72">
        {committed ? (
          <EntityInlineLink
            entity="product"
            data={{ id: committed.id, name: committed.name }}
            displayImage={null}
            truncate
            className="min-w-0 text-xs"
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {proposal.state === "discarded"
              ? "Photos skipped"
              : proposalName(proposal)}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Badge
          variant={proposal.state === "committed" ? "positive" : "secondary"}
        >
          {proposal.state === "committed" ? "Approved" : "Discarded"}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-2xs text-muted-foreground">
        {proposal.groupKey}
      </TableCell>
    </TableRow>
  );
}

const PROCESSING_LABEL = {
  pending: "Queued",
  waiting_for_device: "Waiting for device",
  leased: "Processing",
  ready: "Done",
  skipped: "Skipped",
  failed: "Failed",
} satisfies Record<ImageProcessingJobState, string>;
const PROCESSING_VARIANT = {
  pending: "secondary",
  waiting_for_device: "warning",
  leased: "default",
  ready: "positive",
  skipped: "outline",
  failed: "destructive",
} satisfies Record<ImageProcessingJobState, BadgeVariant>;

function ProcessingBadge({
  label,
  state,
  reason,
}: {
  label: string;
  state: ImageProcessingJobState | null;
  reason?: string | null;
}) {
  if (!state)
    return (
      <span className="text-2xs text-muted-foreground">
        {label}: not queued
      </span>
    );
  return (
    <Badge variant={PROCESSING_VARIANT[state]} title={reason ?? undefined}>
      {label}: {PROCESSING_LABEL[state]}
      {reason ? ` · ${reason}` : ""}
    </Badge>
  );
}

function PhotoTable({
  images,
  groupByImage,
  labelImages,
}: {
  images: readonly PhotoRunImage[];
  groupByImage: ReadonlyMap<string, string>;
  labelImages: ReadonlySet<string>;
}) {
  return (
    <Card>
      <CardHeader>
        <Row align="center" gap="sm">
          <CardTitle as="h2">Photos</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {images.length}
          </span>
        </Row>
      </CardHeader>
      <CardContent>
        {/* Bounded region: a 1,000-photo run scrolls here, not the page. */}
        <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Original</TableHead>
                <TableHead>Cutout</TableHead>
                <TableHead>Import</TableHead>
                <TableHead>Processing</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {images.map((photo) => {
                const snippet =
                  photo.description ??
                  photo.recognizedText?.split("\n")[0] ??
                  null;
                return (
                  <TableRow key={photo.id}>
                    <TableCell className="font-mono text-2xs text-muted-foreground tabular-nums">
                      {photo.position ?? "—"}
                    </TableCell>
                    <TableCell>
                      <a
                        href={`/images/${encodeURIComponent(photo.id)}`}
                        aria-label={`Open photo ${photo.id}`}
                      >
                        <PhotoThumb image={photo} size={48} />
                      </a>
                    </TableCell>
                    <TableCell>
                      {photo.cutoutUrl ? (
                        <Image
                          src={photo.cutoutUrl}
                          alt={`Cutout of ${photo.id}`}
                          displayWidth={48}
                          className="size-12 rounded-md border border-border bg-muted object-contain"
                        />
                      ) : (
                        <span className="text-2xs text-muted-foreground">
                          None
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Stack gap="tight">
                        <Badge
                          variant={
                            IMPORT_RUN_TARGET_STATE_VARIANT[photo.targetState]
                          }
                        >
                          {IMPORT_RUN_TARGET_STATE_LABEL[photo.targetState]}
                        </Badge>
                        {groupByImage.get(photo.id) ? (
                          <span className="max-w-40 truncate font-mono text-2xs text-muted-foreground">
                            {groupByImage.get(photo.id)}
                          </span>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack gap="tight">
                        {labelImages.has(photo.id) && !photo.cutoutUrl ? (
                          <span className="text-2xs text-muted-foreground">
                            Cutout: not needed for label photo
                          </span>
                        ) : (
                          <ProcessingBadge
                            label="Cutout"
                            state={photo.cutout}
                            reason={photo.cutoutReason}
                          />
                        )}
                        <ProcessingBadge
                          label="Describe"
                          state={photo.describe}
                        />
                      </Stack>
                    </TableCell>
                    <TableCell className="max-w-96 whitespace-normal">
                      {snippet ? (
                        <p
                          className="line-clamp-2 text-xs text-muted-foreground"
                          title={snippet}
                        >
                          {snippet}
                        </p>
                      ) : (
                        <span className="text-2xs text-muted-foreground">
                          Not described yet
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The reviewer's workbench for a photo-inventory run: the agent's proposed
 * item groups (edit, approve, discard), photos no group claims yet, settled
 * groups, and every photo's processing state.
 */
export function PhotoGroupReview({
  runId,
  runStatus,
}: {
  runId: string;
  runStatus: string;
}) {
  const query = usePhotoRunReview(runId, runStatus);
  const action = useReviewAction(runId);
  const save: Save = (build) => {
    let edit: ProposalEdit;
    try {
      edit = build();
    } catch (error) {
      showErrorToast(error);
      return;
    }
    action.mutate({
      action: "save",
      groups: edit.groups,
      removeGroupKeys: edit.removeGroupKeys,
    });
  };

  if (query.isLoading && !query.data)
    return <StatusText>Loading proposed groups…</StatusText>;
  if (query.isError && !query.data)
    return <StatusText tone="destructive">{query.error.message}</StatusText>;
  if (!query.data) return null;

  const { review, images } = query.data;
  const imagesById = new Map(images.map((image) => [image.id, image]));
  const proposed = review.proposals.filter(
    (proposal) => proposal.state === "proposed",
  );
  const settled = review.proposals.filter(
    (proposal) => proposal.state !== "proposed",
  );
  const groupByImage = new Map<string, string>();
  const labelImages = new Set<string>();
  for (const proposal of review.proposals)
    for (const entry of [...proposal.images, ...proposal.skip]) {
      groupByImage.set(entry.id, proposal.groupKey);
      if ("purpose" in entry && entry.purpose === "label")
        labelImages.add(entry.id);
    }
  const busy = action.isPending;
  const hasStaleGroups = proposed.some((proposal) =>
    isStaleGroup(proposal, imagesById),
  );

  return (
    <Stack gap="lg">
      <Card>
        <CardHeader>
          <Row align="center" justify="between" wrap gap="sm">
            <Stack gap="tight">
              <CardTitle as="h2">Proposed items</CardTitle>
              <span className="text-xs text-muted-foreground tabular-nums">
                {proposed.length} to review · {settled.length} settled ·{" "}
                {review.unassignedImageIds.length} photos not in a group
              </span>
            </Stack>
            <Button
              className="min-h-11 w-full sm:w-auto"
              disabled={busy || proposed.length === 0 || hasStaleGroups}
              onClick={() => action.mutate({ action: "approve" })}
            >
              <CheckIcon />
              Approve all {proposed.length ? `(${proposed.length})` : ""}
            </Button>
          </Row>
        </CardHeader>
        {proposed.length === 0 ? (
          <CardContent>
            {settled.length ? (
              <StatusText tone="muted">
                Every proposed group has been approved or discarded.
              </StatusText>
            ) : (
              <Stack gap="sm" className="items-start">
                <StatusText tone="muted">
                  Waiting for an agent to propose groups.
                </StatusText>
                {images.length ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      The agent is preparing item groups. They will appear here
                      for review before products are created.
                    </p>
                  </>
                ) : null}
              </Stack>
            )}
          </CardContent>
        ) : null}
      </Card>

      {proposed.map((proposal) => (
        <ProposalCard
          key={proposal.groupKey}
          proposal={proposal}
          proposals={review.proposals}
          imagesById={imagesById}
          busy={busy}
          save={save}
          action={action}
        />
      ))}

      {review.unassignedImageIds.length ? (
        <Card>
          <CardHeader>
            <Row align="center" gap="sm">
              <CardTitle as="h2">Not in a group</CardTitle>
              <span className="text-xs text-muted-foreground tabular-nums">
                {review.unassignedImageIds.length}
              </span>
            </Row>
          </CardHeader>
          <CardContent>
            <Row wrap gap="sm">
              {review.unassignedImageIds.map((imageId) => (
                <figure key={imageId} className="relative m-0">
                  <PhotoThumb image={imagesById.get(imageId)} size={96} />
                  <div className="absolute top-1 right-1">
                    <ImageMenu
                      imageId={imageId}
                      groupKey={null}
                      purpose={null}
                      proposals={review.proposals}
                      save={save}
                      disabled={busy}
                    />
                  </div>
                </figure>
              ))}
            </Row>
          </CardContent>
        </Card>
      ) : null}

      {settled.length ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Settled groups</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Photos</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Group</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settled.map((proposal) => (
                  <SettledRow
                    key={proposal.groupKey}
                    proposal={proposal}
                    imagesById={imagesById}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {images.length ? (
        <PhotoTable
          images={images}
          groupByImage={groupByImage}
          labelImages={labelImages}
        />
      ) : (
        <Card>
          <CardContent>
            <StatusText tone="muted">
              No photos have been uploaded for this batch.
            </StatusText>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
