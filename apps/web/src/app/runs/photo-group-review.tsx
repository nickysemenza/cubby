import type {
  ImageShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobState } from "@cubby/schemas/image-processing";
import type {
  PhotoGroupReview as PhotoGroupDecision,
  PhotoGroupProposal,
  PhotoGroupProposalGroup,
  PhotoRunImage,
  ReviewPhotoGroupsAction,
} from "@cubby/schemas/photo-import-run";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowsMergeIcon } from "@phosphor-icons/react/dist/csr/ArrowsMerge";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityDetailFor } from "~/entity/entity-detail";
import { PhotoGrid } from "~/features/photos/photo-grid";
import { ProductVariantEvidence } from "~/features/products/product-variant-evidence";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  photoImport,
  product as productOperations,
  purchaseImport,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import {
  RUN_TARGET_STATE_LABEL,
  RUN_TARGET_STATE_VARIANT,
} from "~/lib/run-target-state";
import { formatCurrency } from "~/lib/utils";
import { EntityReferencePicker } from "~/ui/combobox/entity-reference-picker";
import { Picker } from "~/ui/combobox/picker";
import { referenceEntitySearch } from "~/ui/combobox/reference-entity-search";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { useOptimisticDisplayValue } from "~/ui/data-table/editable-cell";
import { useIndexedSubsections } from "~/ui/data-table/indexed-sections";
import { showErrorToast } from "~/ui/feedback/error-details";
import { CollapsibleSection, Row, Section, Stack } from "~/ui/layout";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Image } from "~/ui/primitives/image";
import { Input } from "~/ui/primitives/input";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import {
  LIVE_RUN_STATUSES,
  photoReviewPollInterval,
  useAgentReviewSync,
} from "./agent-observation";
import {
  mergeGroups,
  moveImage,
  reviewOutcomeToasts,
  toGroupInput,
  type ProposalEdit,
} from "./photo-review-model";

function postReview(runId: string, action: ReviewPhotoGroupsAction) {
  if (action.action === "save")
    return photoImport.saveGroups.call({ ...action, runId });
  if (action.action === "approve")
    return photoImport.approveGroups.call({ ...action, runId });
  return photoImport.discardGroup.call({ ...action, runId });
}

/**
 * Photos and proposals follow the run while it is live. A run with an agent
 * refreshes from the shared agent stream (see `useAgentReviewSync`) and polls
 * only as a safety net; one without an agent polls every 3s.
 */
export function usePhotoRunReview(
  runId: string,
  runStatus: string,
  hasAgent: boolean,
) {
  const agentLive = useAgentReviewSync(
    runId,
    hasAgent && LIVE_RUN_STATUSES.has(runStatus),
  );
  return useQuery({
    ...photoImport.review.queryOptions({ runId }),
    refetchInterval: (query) =>
      photoReviewPollInterval({
        runStatus,
        agentLive,
        data: query.state.data,
      }),
  });
}

function useReviewAction(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `photo-run-review-${runId}` },
    mutationFn: (action: ReviewPhotoGroupsAction) => postReview(runId, action),
    onSuccess: (data, action) => {
      queryClient.setQueryData(photoImport.review.queryKey({ runId }), (old) =>
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
      void invalidateOperationTags(
        queryClient,
        action.action === "approve"
          ? photoImport.approveGroups.invalidates({ ...action, runId })
          : ripple.runOnly,
      );
      for (const { tone, title, description } of reviewOutcomeToasts(data))
        toast[tone](title, description ? { description } : undefined);
    },
    onError: (error) => showErrorToast(error),
  });
}

/** Takes a builder so an edit that cannot be expressed (see `toGroupInput`) surfaces as a toast instead of an uncaught handler error. */
type Save = (
  build: () => ProposalEdit | Promise<ProposalEdit>,
) => Promise<boolean>;
type SaveGroup = (
  build: () => PhotoGroupProposalGroup | Promise<PhotoGroupProposalGroup>,
) => Promise<boolean>;
type ImagesById = ReadonlyMap<string, PhotoRunImage>;
const WithProductCategorySearch = referenceEntitySearch("productCategory");

const isStaleGroup = (
  proposal: PhotoGroupProposal,
  imagesById: ImagesById,
  runStatus: string,
) =>
  proposal.missingImageCount > 0 ||
  [...proposal.images, ...proposal.skip].some((entry) => {
    const photo = imagesById.get(entry.id);
    return (
      photo !== undefined &&
      photo.targetState !== "pending" &&
      !(runStatus === "needs_review" && photo.targetState === "unresolved")
    );
  });

const proposalName = (proposal: PhotoGroupProposal): string =>
  proposal.product.kind === "create"
    ? proposal.product.create.name
    : (proposal.product.existing?.name ?? "Deleted product — pick another");

const emptyReviewCopy = (runStatus: string, hasAgent: boolean) => {
  if (runStatus === "needs_review")
    return {
      title: "The agent stopped before proposing groups.",
      detail: "Use a photo’s menu below to start a group for review.",
    };
  if (!hasAgent)
    return {
      title: "Grouping has not started.",
      detail: "Select Start grouping once photo descriptions are ready.",
    };
  return {
    title: "Waiting for an agent to propose groups.",
    detail:
      "The agent is preparing item groups. They will appear here for review before products are created.",
  };
};

/** A run photo as a `PhotoGrid` tile; a photo deleted since has no tile. */
const photoTile = (image: PhotoRunImage | undefined) =>
  image
    ? {
        id: image.id,
        url: image.originalUrl,
        filename: image.description ?? image.id,
      }
    : [];

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
  // A skipped photo keeps its reason on hover and stays dimmed.
  const entries = new Map<
    string,
    { purpose: "item" | "label" | null; reason?: string }
  >([
    ...proposal.images.map(
      (entry) => [entry.id, { purpose: entry.purpose }] as const,
    ),
    ...proposal.skip.map(
      (entry) => [entry.id, { purpose: null, reason: entry.reason }] as const,
    ),
  ]);
  return (
    <div className="min-w-0 space-y-2">
      <PhotoGrid
        className="grid-cols-2 sm:grid-cols-2 md:grid-cols-2"
        images={[...entries.keys()].flatMap((id) =>
          photoTile(imagesById.get(id)),
        )}
        renderOverlay={(tile) => {
          const { purpose = null, reason } = entries.get(tile.id) ?? {};
          return (
            <>
              {purpose === null ? (
                <div
                  className="absolute inset-0 bg-background/50"
                  title={reason}
                />
              ) : null}
              <Badge
                variant={
                  purpose === "item"
                    ? "default"
                    : purpose === "label"
                      ? "outline"
                      : "secondary"
                }
                className="absolute bottom-1 left-1 bg-card"
              >
                {purpose === "item"
                  ? "Item"
                  : purpose === "label"
                    ? "Label"
                    : "Skipped"}
              </Badge>
              {editable ? (
                <div className="absolute top-1 right-1">
                  <ImageMenu
                    imageId={tile.id}
                    groupKey={proposal.groupKey}
                    purpose={purpose}
                    proposals={proposals}
                    save={save}
                    disabled={busy}
                  />
                </div>
              ) : null}
            </>
          );
        }}
      />
      {proposal.skip.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-2 text-xs">
          <p className="font-medium">
            Skipped photos stay in this run. Approval does not attach them to
            the Product or count them as inventory.
          </p>
          {proposal.skip.map((entry) => (
            <p key={entry.id} className="text-muted-foreground">
              {entry.id}: {entry.reason}
            </p>
          ))}
        </div>
      ) : null}
      {[...entries.keys()].map((id) => {
        const photo = imagesById.get(id);
        if (
          !photo ||
          (photo.describe !== "failed" && photo.cutout !== "failed")
        )
          return null;
        return (
          <div key={id} className="border-t border-border pt-2 text-xs">
            {photo.describe === "failed" && (
              <p className="text-destructive">
                Description failed:{" "}
                {photo.describeReason || "No reason available"}.{" "}
                <a
                  className="underline"
                  href={`/images/${encodeURIComponent(id)}`}
                >
                  Open photo to retry
                </a>
              </p>
            )}
            {photo.cutout === "failed" && (
              <p className="text-muted-foreground">
                Optional cutout failed:{" "}
                {photo.cutoutReason || "No reason available"}.{" "}
                <a
                  className="underline"
                  href={`/images/${encodeURIComponent(id)}`}
                >
                  Open photo to retry
                </a>
              </p>
            )}
          </div>
        );
      })}
      <details className="border-t border-border pt-2">
        <summary className="cursor-pointer text-xs font-medium">
          Photo descriptions and label text
        </summary>
        <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {[...entries].map(([id, role]) => {
            const photo = imagesById.get(id);
            if (!photo) return null;
            return (
              <div
                key={id}
                className="min-w-0 border-t border-border pt-2 text-xs"
              >
                <p className="font-medium">
                  {role.purpose === "label"
                    ? "Label photo"
                    : role.purpose === "item"
                      ? "Item photo"
                      : "Skipped photo"}{" "}
                  · original upload
                </p>
                {photo.description && (
                  <p className="mt-1 text-muted-foreground">
                    <span className="text-foreground">Description:</span>{" "}
                    {photo.description}
                  </p>
                )}
                {photo.recognizedText && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    <span className="text-foreground">OCR:</span>{" "}
                    {photo.recognizedText}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </details>
    </div>
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
  options,
  optionsLoading,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void | Promise<boolean> | string;
  disabled: boolean;
  type?: "text" | "number";
  className?: string;
  options?: readonly { value: string; count: number }[];
  optionsLoading?: boolean;
}) {
  const optionsId = useId();
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(value);
  const [acknowledged, setAcknowledged] = useState(value);
  const acknowledgedRef = useRef(value);
  useEffect(() => {
    const previous = acknowledgedRef.current;
    setDraft((current) =>
      current.trim() === previous.trim() ? value : current,
    );
    acknowledgedRef.current = value;
    setAcknowledged(value);
  }, [value]);
  const commit = () => {
    if (
      (type === "number" && !/^[1-9]\d*$/.test(draft.trim())) ||
      ((label === "New product name" || label === "New name") && !draft.trim())
    )
      return;
    const next = draft.trim();
    if (next !== acknowledged.trim()) {
      const saved = onCommit(next);
      if (saved && typeof saved !== "string")
        void saved.then((success) => {
          if (success) {
            acknowledgedRef.current = next;
            setAcknowledged(next);
          }
        });
    }
  };
  return (
    <div className={`flex min-w-0 flex-col gap-1 text-xs ${className ?? ""}`}>
      <label htmlFor={inputId} className="text-muted-foreground">
        {label}
      </label>
      <Input
        id={inputId}
        data-photo-unsaved={draft.trim() !== acknowledged.trim() || undefined}
        aria-describedby={options ? hintId : undefined}
        list={options ? optionsId : undefined}
        type={type}
        min={type === "number" ? 1 : undefined}
        step={type === "number" ? 1 : undefined}
        aria-invalid={
          (type === "number" && !/^[1-9]\d*$/.test(draft)) ||
          ((label === "New product name" || label === "New name") &&
            !draft.trim())
        }
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {type === "number" && !/^[1-9]\d*$/.test(draft) && (
        <StatusText tone="destructive">
          Enter a whole number greater than 0.
        </StatusText>
      )}
      {options ? (
        <>
          <datalist id={optionsId}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value}
              </option>
            ))}
          </datalist>
          <span id={hintId} className="text-muted-foreground">
            {optionsLoading
              ? "Checking existing manufacturer names…"
              : draft.trim()
                ? (() => {
                    const match = options.find(
                      (option) =>
                        option.value.toLocaleLowerCase() ===
                        draft.trim().toLocaleLowerCase(),
                    );
                    return match
                      ? `Existing name · used on ${countLabel(match.count, "product")}`
                      : "New manufacturer name · saved as text on this Product";
                  })()
                : "Use an existing manufacturer name or enter one."}
          </span>
        </>
      ) : null}
    </div>
  );
}

function reviewDecision(proposal: PhotoGroupProposal): PhotoGroupDecision {
  return (
    proposal.review ?? {
      observedName: proposalName(proposal),
      unresolvedReason:
        "Confirm the observed identity before applying this group",
      stockIntent: proposal.inventory ? "receive" : "evidence",
    }
  );
}

function IdentityDecision({
  proposal,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  save: SaveGroup;
  busy: boolean;
}) {
  const review = reviewDecision(proposal);
  return (
    <Stack gap="xs">
      <p className="text-xs text-muted-foreground">
        Observed: {review.observedName}
      </p>
      {review.unresolvedReason ? (
        <StatusText tone="warning">{review.unresolvedReason}</StatusText>
      ) : null}
      <Row gap="xs" wrap>
        {review.unresolvedReason ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              save(() => ({
                ...toGroupInput(proposal),
                review: { ...review, unresolvedReason: null },
              }))
            }
          >
            Confirm identity
          </Button>
        ) : (
          <Badge variant="positive">Identity resolved</Badge>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer">Identity needs work</summary>
          <CommitInput
            label="Reason this item cannot be applied yet"
            value={review.unresolvedReason ?? ""}
            disabled={busy}
            onCommit={(reason) =>
              reason &&
              save(() => ({
                ...toGroupInput(proposal),
                review: { ...review, unresolvedReason: reason },
              }))
            }
          />
        </details>
      </Row>
    </Stack>
  );
}

function FieldChangeToggle({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => Promise<boolean>;
  children: ReactNode;
}) {
  const { displayValue, setOptimisticValue } =
    useOptimisticDisplayValue(checked);
  return (
    <label className="flex items-center gap-2">
      <Checkbox
        checked={displayValue ?? false}
        disabled={disabled}
        onCheckedChange={(next) => {
          setOptimisticValue(next);
          void onChange(next).then((success) => {
            if (!success) setOptimisticValue(undefined);
          });
        }}
      />
      {children}
    </label>
  );
}

function ExistingProductChanges({
  proposal,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  save: SaveGroup;
  busy: boolean;
}) {
  const id =
    proposal.product.kind === "existing"
      ? proposal.product.existing?.id
      : undefined;
  const [open, setOpen] = useState(false);
  const current = useQuery(
    entityDetailFor("product").queryOptions(id ?? "", {
      enabled: open && Boolean(id),
    }),
  );
  const review = reviewDecision(proposal);
  const changes = review.productChanges ?? {};
  return (
    <details
      className="border-t border-border pt-2 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        Optional Product changes · {Object.keys(changes).length} selected
      </summary>
      <p className="my-2 text-muted-foreground">
        Photos append to the gallery. Existing photos, cover, and unselected
        fields stay as they are.
      </p>
      {current.isError ? (
        <StatusText tone="destructive">{current.error.message}</StatusText>
      ) : null}
      {current.data ? (
        <Stack gap="sm">
          {(["name", "manufacturer", "model", "notes", "tags"] as const).map(
            (field) => {
              const before =
                field === "tags"
                  ? (current.data?.tags.join(", ") ?? "")
                  : (current.data?.[field] ?? "");
              const change = changes[field];
              const after = Array.isArray(change)
                ? change.join(", ")
                : (change ?? "");
              return (
                <Stack key={field} gap="xs">
                  <FieldChangeToggle
                    checked={Object.hasOwn(changes, field)}
                    disabled={busy}
                    onChange={(checked) =>
                      save(() => {
                        const next = { ...changes };
                        if (!checked) delete next[field];
                        else if (field === "tags")
                          next.tags = current.data?.tags ?? [];
                        else next[field] = before;
                        return {
                          ...toGroupInput(proposal),
                          review: { ...review, productChanges: next },
                        };
                      })
                    }
                  >
                    Change {field}
                  </FieldChangeToggle>
                  {Object.hasOwn(changes, field) ? (
                    <>
                      <p className="break-words text-muted-foreground">
                        Before: {before || "Empty"}
                      </p>
                      <CommitInput
                        label={`New ${field}`}
                        value={after}
                        disabled={busy}
                        onCommit={(value) =>
                          save(() => ({
                            ...toGroupInput(proposal),
                            review: {
                              ...review,
                              productChanges: {
                                ...changes,
                                [field]:
                                  field === "tags"
                                    ? value
                                        .split(",")
                                        .map((tag) => tag.trim())
                                        .filter(Boolean)
                                    : value ||
                                      (field === "name" ||
                                      field === "manufacturer"
                                        ? ""
                                        : null),
                              },
                            },
                          }))
                        }
                      />
                    </>
                  ) : null}
                </Stack>
              );
            },
          )}
          <FieldChangeToggle
            checked={Object.hasOwn(changes, "categoryId")}
            disabled={busy}
            onChange={(checked) =>
              save(() => {
                const next = { ...changes };
                if (checked)
                  next.categoryId = current.data?.category?.id ?? null;
                else delete next.categoryId;
                return {
                  ...toGroupInput(proposal),
                  review: { ...review, productChanges: next },
                };
              })
            }
          >
            Change category
          </FieldChangeToggle>
          {Object.hasOwn(changes, "categoryId") ? (
            <>
              <p>Before: {current.data.category?.name ?? "None"}</p>
              <WithProductCategorySearch>
                {({ items, ...search }) => (
                  <Picker
                    {...search}
                    entity="productCategory"
                    label="new category"
                    items={items}
                    value={
                      items.find((item) => item.id === changes.categoryId) ??
                      null
                    }
                    setValue={(item) =>
                      save(() => ({
                        ...toGroupInput(proposal),
                        review: {
                          ...review,
                          productChanges: {
                            ...changes,
                            categoryId: item
                              ? productCategoryShortcode.parse(item.id)
                              : null,
                          },
                        },
                      }))
                    }
                    clearable
                    disabled={busy}
                  />
                )}
              </WithProductCategorySearch>
            </>
          ) : null}
        </Stack>
      ) : open && !current.isError ? (
        <p>Loading current Product…</p>
      ) : null}
    </details>
  );
}

function ProductPanel({
  runId,
  proposal,
  save,
  busy,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  save: Save;
  busy: boolean;
}) {
  const saveGroup: SaveGroup = (build) =>
    save(async () => ({ groups: [await build()], removeGroupKeys: [] }));
  const draftRef = useRef(
    proposal.product.kind === "create" ? proposal.product.create : undefined,
  );
  const saveProduct = (next: PhotoGroupProposalGroup["product"]) => {
    if (proposal.product.kind === "create")
      draftRef.current = proposal.product.create;
    const review = reviewDecision(proposal);
    const input = toGroupInput(proposal, { product: next });
    if (
      input.inventory?.existingEntryId &&
      (next.kind !== "existing" ||
        proposal.product.kind !== "existing" ||
        next.existingId !== proposal.product.existing?.id)
    )
      input.inventory = {
        ...input.inventory,
        mode: "create",
        existingEntryId: undefined,
      };
    return saveGroup(() => ({
      ...input,
      review: {
        observedName:
          next.kind === "create" ? next.create.name : review.observedName,
        unresolvedReason:
          next.kind === "existing" ? null : review.unresolvedReason,
        stockIntent: review.stockIntent,
        productChanges:
          next.kind === "existing" &&
          proposal.product.kind === "existing" &&
          next.existingId === proposal.product.existing?.id
            ? review.productChanges
            : undefined,
      },
    }));
  };
  const attachExisting = (existingId: ProductShortcode) =>
    saveProduct({ kind: "existing", existingId });
  const product = proposal.product;
  const manufacturers = useQuery({
    ...productOperations.manufacturerOptions.queryOptions(),
    enabled: product.kind === "create",
  });
  return (
    <Stack gap="sm" className="min-w-0">
      <h4 className="text-sm font-semibold">
        {product.kind === "create"
          ? "Create this Product"
          : "Attach to this Product"}
      </h4>
      <IdentityDecision proposal={proposal} save={saveGroup} busy={busy} />
      {manufacturers.isError ? (
        <StatusText tone="destructive">
          {manufacturers.error.message}
        </StatusText>
      ) : null}
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
              <EntityRefLink
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
                <Picker
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
              options={
                manufacturers.data?.map((entry) => ({
                  value: entry.manufacturer,
                  count: entry.count,
                })) ?? []
              }
              optionsLoading={manufacturers.isPending}
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

      <Row gap="sm" align="end" wrap className="min-w-0">
        <div className="min-w-0 flex-1">
          <EntityReferencePicker
            entity="product"
            label="existing product"
            value={null}
            setValue={(item) => {
              if (item) attachExisting(item.id);
            }}
            disabled={busy}
            placeholder={
              product.kind === "existing"
                ? "Choose a different product"
                : "Search existing products before creating another"
            }
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
                create: draftRef.current ?? {
                  name:
                    proposal.review?.observedName ??
                    product.existing?.name ??
                    proposal.groupKey,
                },
              })
            }
          >
            Create new instead
          </Button>
        ) : null}
      </Row>
      <PhotoProductSuggestions
        runId={runId}
        proposal={proposal}
        onPick={attachExisting}
        busy={busy}
      />
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
              <EntityRefLink
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

      {product.kind === "create" ? (
        <details className="text-xs">
          <summary className="cursor-pointer">Notes and tags</summary>
          <Stack gap="sm" className="mt-2">
            <CommitInput
              label="Product notes"
              value={product.create.notes ?? ""}
              disabled={busy}
              onCommit={(notes) =>
                saveProduct({
                  kind: "create",
                  create: { ...product.create, notes: notes || null },
                })
              }
            />
            <CommitInput
              label="Tags (comma separated)"
              value={(product.create.tags ?? []).join(", ")}
              disabled={busy}
              onCommit={(tags) =>
                saveProduct({
                  kind: "create",
                  create: {
                    ...product.create,
                    tags: tags
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </Stack>
        </details>
      ) : (
        <ExistingProductChanges
          proposal={proposal}
          save={saveGroup}
          busy={busy}
        />
      )}

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

function PhotoProductSuggestions({
  runId,
  proposal,
  onPick,
  busy,
  settled = false,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  onPick?: (id: ProductShortcode) => void;
  busy?: boolean;
  settled?: boolean;
}) {
  const suggestions = useQuery({
    ...photoImport.candidates.queryOptions({
      runId,
      groupKey: proposal.groupKey,
    }),
    enabled: false,
  });
  return (
    <details className="border-t border-border pt-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Compare existing Products
      </summary>
      <Stack gap="sm" className="mt-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || suggestions.isFetching}
          onClick={() => void suggestions.refetch()}
        >
          {suggestions.isFetching
            ? "Checking existing Products…"
            : "Check existing Products"}
        </Button>
        {suggestions.isError && (
          <StatusText tone="destructive">
            {suggestions.error.message}
          </StatusText>
        )}
        {suggestions.data && (
          <RecordList empty="No matching Products found. Search the catalog if identity is still unclear.">
            {suggestions.data.candidates.map((candidate) => (
              <RecordRow
                key={candidate.id}
                leading={
                  <Image
                    src={candidate.coverUrl ?? undefined}
                    alt={candidate.name}
                    displayWidth={40}
                    className="size-10 rounded-sm object-contain"
                  />
                }
                primary={
                  <EntityRefLink
                    entity="product"
                    data={{ id: candidate.id, name: candidate.name }}
                    displayImage={null}
                  />
                }
                secondary={
                  <ProductVariantEvidence
                    comparison={candidate.match.variant}
                    firstLabel="Photo"
                    secondLabel="Product"
                  />
                }
                trailing={
                  candidate.match.matchedIdentifiers?.length ? (
                    <Badge variant="positive">Exact identifier</Badge>
                  ) : null
                }
                actions={
                  settled && proposal.committedProduct ? (
                    <Button
                      size="sm"
                      variant="outline"
                      render={
                        <Link
                          to="/recommendations/workbench"
                          search={{
                            kind: "product-match",
                            source: proposal.committedProduct.id,
                            candidate: candidate.id,
                          }}
                        />
                      }
                    >
                      Review duplicate
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onPick?.(candidate.id)}
                    >
                      {proposal.product.kind === "existing" &&
                      proposal.product.existing?.id === candidate.id
                        ? "Selected"
                        : "Choose Product"}
                    </Button>
                  )
                }
                detail={
                  <details className="py-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Evidence and history
                    </summary>
                    <Stack gap="xs" className="py-2">
                      <p>
                        Heuristic rank {candidate.match.score ?? "—"} · not a
                        probability
                      </p>
                      <p>
                        {candidate.match.factors
                          ?.map((factor) => `${factor.label}: ${factor.points}`)
                          .join(" · ")}
                      </p>
                      <p>
                        Recorded count:{" "}
                        {candidate.quantity?.onHandUnits ?? "Not counted"} ·
                        Expected:{" "}
                        {candidate.quantity?.quantityLedger.expectedQuantity ??
                          "Unknown"}
                      </p>
                      {candidate.variantEvidence?.map((fact) => (
                        <p key={`${fact.source}-${fact.text}`}>
                          <strong>{fact.source.replaceAll("_", " ")}</strong>:{" "}
                          {fact.text}
                        </p>
                      ))}
                      {candidate.purchaseLines?.map((line) => (
                        <p key={line.expenseId}>
                          <EntityRefLink
                            entity="expense"
                            data={{ id: line.expenseId, name: line.name }}
                            displayImage={null}
                          />{" "}
                          ·{" "}
                          {line.date ? (
                            <DateDisplay start={line.date} />
                          ) : (
                            "Undated"
                          )}{" "}
                          ·{" "}
                          {line.cost == null
                            ? "Cost unknown"
                            : formatCurrency(line.cost)}
                        </p>
                      ))}
                    </Stack>
                  </details>
                }
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </details>
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
  const [entryPending, setEntryPending] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const existingEntry = useQuery(
    entityDetailFor("inventory").queryOptions(
      inventory?.existingEntryId ?? "",
      { enabled: Boolean(inventory?.existingEntryId) },
    ),
  );
  const destination =
    proposal.product.kind === "existing" ? proposal.product.existing?.id : null;
  useEffect(() => setEntryError(null), [destination]);
  const saveStock: SaveGroup = (build) =>
    save(build).then((success) => {
      if (success) setEntryError(null);
      return success;
    });
  const review = reviewDecision(proposal);
  const changeIntent = (stockIntent: PhotoGroupDecision["stockIntent"]) =>
    saveStock(() => ({
      ...toGroupInput(proposal, {
        inventory:
          stockIntent === "receive"
            ? toGroupInput(proposal).inventory
            : undefined,
      }),
      review: { ...review, stockIntent },
    }));
  const selected =
    inventory?.locationId && inventory.locationName
      ? { id: inventory.locationId, name: inventory.locationName }
      : null;
  return (
    <div className="border-t border-border pt-3">
      <h4 className="mb-2 text-sm font-semibold">Stock decision</h4>
      <div className="mb-2 flex flex-col gap-1 text-xs">
        What do these photos establish?
        <Picker
          mode="choose"
          label="stock decision"
          value={review.stockIntent}
          disabled={busy}
          options={[
            { value: "evidence", label: "Catalog evidence only" },
            { value: "counted", label: "Already counted · no stock change" },
            {
              value: "historical",
              label: "Historical or sold · no stock change",
            },
            { value: "receive", label: "Receive newly counted stock" },
          ]}
          onValueChange={(intent) => {
            if (
              intent === "evidence" ||
              intent === "counted" ||
              intent === "historical" ||
              intent === "receive"
            )
              changeIntent(intent);
          }}
        />
      </div>
      {review.stockIntent === "receive" ? (
        <Stack gap="sm">
          <Row gap="sm" align="end" className="min-w-0">
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Receive into</span>
              <EntityReferencePicker
                entity="location"
                label="location"
                value={selected}
                setValue={(item) =>
                  saveStock(() => ({
                    ...toGroupInput(proposal, {
                      inventory: item
                        ? {
                            ownershipMode: inventory?.ownershipMode,
                            ownerPartyId: inventory?.ownerPartyId,
                            locationId: item.id,
                            quantity,
                            mode: "create",
                            existingEntryId: undefined,
                          }
                        : undefined,
                    }),
                    review: { ...review, stockIntent: "receive" },
                  }))
                }
                disabled={busy}
                placeholder="No inventory entry"
                clearable
              />
            </div>
            {inventory?.locationId ? (
              <CommitInput
                label="Qty"
                type="number"
                className="w-20"
                value={String(quantity)}
                disabled={busy}
                onCommit={(next) => {
                  const parsed = Number(next);
                  if (Number.isInteger(parsed) && parsed > 0)
                    return save(() => {
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
          {inventory?.locationId ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {inventory.mode === "add"
                ? existingEntry.data
                  ? `Add ${quantity} to ${existingEntry.data.amount.value} at ${inventory.locationName}: ${existingEntry.data.amount.value + quantity} after applying.`
                  : `Add ${quantity} to the explicitly selected entry at ${inventory.locationName}.`
                : `Create a count of ${quantity} at ${inventory.locationName}.`}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Choose a location to receive stock, or choose a stock decision
              that leaves Inventory unchanged.
            </p>
          )}
          {proposal.product.kind === "existing" && proposal.product.existing ? (
            <EntityReferencePicker
              entity="inventory"
              label="existing stock entry"
              scope={{ productIdFilter: proposal.product.existing.id }}
              value={
                inventory?.existingEntryId
                  ? { id: inventory.existingEntryId, name: "" }
                  : null
              }
              disabled={busy || entryPending}
              placeholder="Or choose an existing entry to add to"
              setValue={(item) => {
                if (!item) return;
                setEntryPending(true);
                setEntryError(null);
                void save(async () => {
                  const entry = await entityDetailFor("inventory").readFresh(
                    item.id,
                  );
                  if (!entry)
                    throw new Error("Inventory entry no longer exists");
                  if (
                    entry.amount.unit !== "each" ||
                    entry.placement !== "stock"
                  )
                    throw new Error("Choose stock counted in whole items");
                  return {
                    ...toGroupInput(proposal, {
                      inventory: {
                        locationId: entry.location.id,
                        quantity,
                        mode: "add",
                        existingEntryId: entry.id,
                        ownershipMode: entry.effectiveOwnership.mode,
                        ownerPartyId:
                          entry.effectiveOwnership.explicitOwner?.id ?? null,
                      },
                    }),
                    review: { ...review, stockIntent: "receive" },
                  };
                }).then((success) => {
                  setEntryPending(false);
                  if (!success)
                    setEntryError(
                      "Retry the stock-entry selection before applying",
                    );
                });
              }}
            />
          ) : null}
          {entryError ? (
            <StatusText tone="destructive" data-photo-unsaved="true">
              {entryError}
            </StatusText>
          ) : null}
          {inventory?.locationId && (inventory.mode === "add" || entryError) ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || entryPending}
              onClick={() =>
                saveStock(() => {
                  const input = toGroupInput(proposal);
                  return {
                    ...input,
                    inventory: input.inventory
                      ? {
                          ...input.inventory,
                          mode: "create",
                          existingEntryId: undefined,
                        }
                      : undefined,
                  };
                })
              }
            >
              Create a fresh count here
            </Button>
          ) : null}
          {inventory?.locationId ? (
            <Stack gap="xs">
              <p className="text-xs text-muted-foreground">
                Owner:{" "}
                {inventory.ownershipMode === "explicit" &&
                inventory.ownerPartyId === null
                  ? "Household"
                  : inventory.ownershipMode === "inherit"
                    ? (existingEntry.data?.effectiveOwnership.effectiveOwner
                        ?.name ?? "Inherited from acquisition evidence")
                    : inventory.ownerPartyId
                      ? "Selected owner"
                      : "Run member"}
              </p>
              <EntityReferencePicker
                entity="ledgerParty"
                label="stock owner"
                value={
                  inventory.ownerPartyId
                    ? { id: inventory.ownerPartyId, name: "" }
                    : null
                }
                disabled={busy}
                placeholder="Choose an owner"
                setValue={(item) =>
                  saveStock(() => ({
                    ...toGroupInput(proposal, {
                      inventory: {
                        ...toGroupInput(proposal).inventory!,
                        ownershipMode: "explicit",
                        ownerPartyId: item?.id ?? null,
                        mode: "create",
                        existingEntryId: undefined,
                      },
                    }),
                    review,
                  }))
                }
                clearable
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  saveStock(() => ({
                    ...toGroupInput(proposal, {
                      inventory: {
                        ...toGroupInput(proposal).inventory!,
                        ownershipMode: "explicit",
                        ownerPartyId: null,
                        mode: "create",
                        existingEntryId: undefined,
                      },
                    }),
                    review,
                  }))
                }
              >
                Use household ownership
              </Button>
            </Stack>
          ) : (
            <StatusText tone="warning">
              Choose a location before receiving stock.
            </StatusText>
          )}
        </Stack>
      ) : (
        <p className="text-xs text-muted-foreground">
          Attach photos with no Inventory write. Historical photos do not record
          a sale.
        </p>
      )}
    </div>
  );
}

function ProposalCard({
  runId,
  runStatus,
  proposal,
  proposals,
  imagesById,
  busy,
  save,
  action,
  approve,
}: {
  runId: string;
  runStatus: string;
  proposal: PhotoGroupProposal;
  proposals: readonly PhotoGroupProposal[];
  imagesById: ImagesById;
  busy: boolean;
  save: Save;
  action: ReturnType<typeof useReviewAction>;
  approve: (groupKey: string) => Promise<void>;
}) {
  const [approvalQueued, setApprovalQueued] = useState(false);
  const working = busy;
  const mergeTargets = proposals.filter(
    (other) =>
      other.state === "proposed" && other.groupKey !== proposal.groupKey,
  );
  // Photos deleted or settled outside this review (e.g. a direct commit) make
  // the group unapprovable and undiscardable; removing it is the way out.
  const stale = isStaleGroup(proposal, imagesById, runStatus);
  const descriptionsPending = awaitingDescriptions(proposal, imagesById);
  return (
    <Card className="rounded-none border-x-0 border-b-0 shadow-none">
      <CardHeader>
        <Row align="center" justify="between" wrap gap="sm">
          <Row align="center" gap="sm" className="min-w-0">
            <CardTitle as="h3" className="min-w-0 break-words">
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
                  Combine photo groups…
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
          </Row>
        </Row>
      </CardHeader>
      <CardContent className="@container/photo-editor">
        <div className="grid min-w-0 items-start gap-4 @2xl/photo-editor:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <GroupPhotos
              proposal={proposal}
              proposals={proposals}
              imagesById={imagesById}
              save={save}
              editable
              busy={working}
            />
          </div>
          <ProductPanel
            runId={runId}
            proposal={proposal}
            save={save}
            busy={working}
          />
        </div>
        {proposal.missingImageCount ? (
          <StatusText as="p" tone="warning" className="mt-3 text-xs">
            {proposal.missingImageCount === 1
              ? "1 photo in this group was deleted."
              : `${proposal.missingImageCount} photos in this group were deleted.`}
          </StatusText>
        ) : null}
        {stale ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void approve(proposal.groupKey)}
          >
            Recover applied result
          </Button>
        ) : null}
        {stale ? (
          <StatusText as="p" tone="warning" className="mt-3 text-xs">
            This group includes photos that can no longer be reviewed. Remove
            the group to continue.
          </StatusText>
        ) : null}
        {descriptionsPending.length ? (
          <StatusText as="p" tone="warning" className="mt-3 text-xs">
            Approval waits for the AI description of{" "}
            {descriptionsPending.length}{" "}
            {descriptionsPending.length === 1 ? "photo" : "photos"}. Open a
            failed photo to retry its analysis. Device analysis and cutouts can
            continue in the background.
          </StatusText>
        ) : null}
        {proposal.lastError ? (
          <StatusText as="p" tone="destructive" className="mt-3 text-xs">
            Last approval failed: {proposal.lastError}
          </StatusText>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">
            Apply {countLabel(proposal.images.length, "photo")} (
            {proposal.images.map((image) => image.purpose).join(", ")}) for{" "}
            <strong className="text-foreground">
              {proposalName(proposal)}
            </strong>
            .{" "}
            {proposal.product.kind === "existing"
              ? `Append photos; preserve cover and gallery order. ${Object.keys(proposal.review?.productChanges ?? {}).length ? `Update selected fields: ${Object.keys(proposal.review?.productChanges ?? {}).join(", ")}.` : "Keep Product fields unchanged."}`
              : "Create the draft shown above."}{" "}
            {proposal.skip.length
              ? `${proposal.skip.length} photos skipped. `
              : ""}
            {proposal.inventory?.locationId
              ? `${proposal.inventory.mode === "add" ? "Add" : "Receive"} ${proposal.inventory.quantity} at ${proposal.inventory.locationName}.`
              : "No Inventory entry or possession claim."}
          </p>
          <Button
            disabled={
              approvalQueued ||
              (action.isPending && action.variables?.action !== "save") ||
              stale ||
              descriptionsPending.length > 0 ||
              !proposal.review ||
              Boolean(proposal.review.unresolvedReason) ||
              (proposal.review.stockIntent === "receive" &&
                !proposal.inventory?.locationId) ||
              (proposal.product.kind === "existing" &&
                !proposal.product.existing)
            }
            onClick={() => {
              setApprovalQueued(true);
              void approve(proposal.groupKey).finally(() =>
                setApprovalQueued(false),
              );
            }}
          >
            <CheckIcon />
            {proposal.product.kind === "create"
              ? "Create Product"
              : proposal.review?.productChanges &&
                  Object.keys(proposal.review.productChanges).length
                ? "Apply changes"
                : "Attach photos"}
          </Button>
        </div>
      </CardContent>
    </Card>
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
const DESCRIPTION_BLOCKING = new Set<ImageProcessingJobState>([
  "pending",
  "waiting_for_device",
  "leased",
  "failed",
]);

function awaitingDescriptions(
  proposal: PhotoGroupProposal,
  imagesById: ImagesById,
) {
  return proposal.images.filter((entry) => {
    const state = imagesById.get(entry.id)?.describe;
    return state != null && DESCRIPTION_BLOCKING.has(state);
  });
}
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
        <ClockIcon className="mr-1 inline size-3" aria-hidden="true" />
        {label}: not queued
      </span>
    );
  const Icon =
    state === "ready"
      ? CheckCircleIcon
      : state === "failed"
        ? WarningCircleIcon
        : state === "skipped"
          ? MinusCircleIcon
          : state === "leased"
            ? CircleNotchIcon
            : ClockIcon;
  const explanation =
    reason === "not_suitable"
      ? "The image was already transparent, or a previous eligibility policy skipped subject lift."
      : reason === "Image is attached only as label evidence"
        ? "The previous label-only policy skipped subject lift. Queue missing processing to retry."
        : reason;
  const badge = (
    <Badge variant={PROCESSING_VARIANT[state]} className="max-w-full">
      <Icon
        className={`size-3 shrink-0 ${state === "leased" ? "animate-spin" : ""}`}
        aria-hidden="true"
      />
      {label}: {PROCESSING_LABEL[state]}
    </Badge>
  );
  if (!explanation) return badge;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex w-fit cursor-help" />}
        tabIndex={0}
        aria-label={`${label}: ${PROCESSING_LABEL[state]}. ${explanation}`}
      >
        {badge}
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}

function PhotoTable({
  images,
  groupByImage,
}: {
  images: readonly PhotoRunImage[];
  groupByImage: ReadonlyMap<string, string>;
}) {
  return (
    <Section aria-label="Run photos" title={`Photos · ${images.length}`}>
      {/* Bounded region: a 1,000-photo run scrolls here, not the page. */}
      <div className="max-h-[70vh] overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Original</TableHead>
              <TableHead>Cutout</TableHead>
              <TableHead>Import</TableHead>
              <TableHead>Analysis</TableHead>
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
                        variant={RUN_TARGET_STATE_VARIANT[photo.targetState]}
                      >
                        {RUN_TARGET_STATE_LABEL[photo.targetState]}
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
                      <Badge
                        variant={
                          photo.localAnalysisReady ? "positive" : "secondary"
                        }
                        title={
                          photo.localAnalysisReady
                            ? "Device Vision analysis received"
                            : "Optional device Vision analysis has not arrived"
                        }
                      >
                        {photo.localAnalysisReady ? (
                          <CheckCircleIcon
                            className="size-3"
                            aria-hidden="true"
                          />
                        ) : (
                          <ClockIcon className="size-3" aria-hidden="true" />
                        )}
                        Device:{" "}
                        {photo.localAnalysisReady ? "Done" : "Not received"}
                      </Badge>
                      <ProcessingBadge
                        label="Cutout"
                        state={photo.cutout}
                        reason={photo.cutoutReason}
                      />
                      <ProcessingBadge
                        label="AI description"
                        state={photo.describe}
                        reason={photo.describeReason}
                      />
                      {photo.describeReason ? (
                        <span className="max-w-56 text-2xs break-words text-destructive">
                          {photo.describeReason}
                        </span>
                      ) : null}
                    </Stack>
                  </TableCell>
                  <TableCell className="max-w-96 whitespace-normal">
                    {snippet ? (
                      <p
                        className="line-clamp-2 text-xs text-muted-foreground"
                        title={snippet}
                      >
                        <ShortcodeProse>{snippet}</ShortcodeProse>
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
    </Section>
  );
}

function ExpenseLinkReview({
  runId,
  proposal,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
}) {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const lines = useQuery(
    photoImport.linkableExpenses.queryOptions({
      runId,
      groupKey: proposal.groupKey,
      search,
    }),
  );
  const [review, setReview] = useState<Awaited<
    ReturnType<typeof purchaseImport.prepareReconciliation.call>
  > | null>(null);
  const preview = useMutation({
    mutationFn: (
      input: Parameters<typeof purchaseImport.prepareReconciliation.call>[0],
    ) => purchaseImport.prepareReconciliation.call(input),
    onSuccess: setReview,
    onError: (error) => showErrorToast(error),
  });
  const link = useMutation({
    ...purchaseImport.commitAcceptedReconciliation.mutationOptions(),
    onSuccess: () => {
      setReview(null);
      toast.success("Existing Expense linked to Product");
      void invalidateOperationTags(queryClient, ripple.runOnly);
    },
    onError: (error) => showErrorToast(error),
  });
  return (
    <section
      className="mt-4 border-t border-border pt-3"
      aria-label="Unlinked purchase lines"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">
          Missing Expense → Product link
        </h4>
        <span className="text-2xs text-muted-foreground">
          Separate from photo approval · cost and quantity stay unchanged
        </span>
      </div>
      <Input
        aria-label="Search unlinked purchase lines"
        placeholder="Search unlinked purchase lines"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="mt-2 max-w-md"
      />
      {lines.isPending ? (
        <StatusText tone="muted">Searching eligible lines…</StatusText>
      ) : lines.isError ? (
        <StatusText tone="destructive">{lines.error.message}</StatusText>
      ) : lines.data.lines.length ? (
        <div className="mt-2 divide-y divide-border border-y border-border">
          {lines.data.lines.map((line) => (
            <div
              key={line.expenseId}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  <EntityRefLink
                    entity="expense"
                    data={{ id: line.expenseId, name: line.name }}
                    displayImage={null}
                  />
                </p>
                <p className="text-muted-foreground">
                  {line.date ? <DateDisplay start={line.date} /> : "Undated"} ·{" "}
                  {line.cost == null
                    ? "Cost unknown"
                    : `${formatCurrency(line.cost)}`}{" "}
                  ·{" "}
                  {line.productQuantity == null
                    ? "Quantity unknown"
                    : `${line.productQuantity} units`}{" "}
                  · expected quantity{" "}
                  {line.expectedQuantityDelta == null
                    ? "remains uncertain"
                    : `${line.expectedQuantityDelta > 0 ? "+" : ""}${line.expectedQuantityDelta}`}
                  {line.purchaseId ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        to="/purchases/$shortcode"
                        params={{ shortcode: line.purchaseId }}
                        className="underline"
                      >
                        {line.purchaseLabel || "Purchase"}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              {line.acceptedSourceLines.length ? (
                line.acceptedSourceLines.map((source, index) => (
                  <Button
                    key={`${source.sourceOrderId}:${source.lineIndex}`}
                    size="sm"
                    variant="outline"
                    disabled={preview.isPending || link.isPending}
                    onClick={() =>
                      preview.mutate({
                        sourceOrderId: source.sourceOrderId,
                        resolution: {
                          kind: "attach_only",
                          lines: [
                            {
                              lineIndex: source.lineIndex,
                              expenseId: line.expenseId,
                              productId: lines.data.productId,
                            },
                          ],
                        },
                      })
                    }
                  >
                    {line.acceptedSourceLines.length > 1
                      ? `Review source ${index + 1}`
                      : "Review this link"}
                  </Button>
                ))
              ) : (
                <span className="text-muted-foreground">
                  Accepted source evidence required
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No eligible unlinked lines found. Search by a name or label phrase.
        </p>
      )}
      {review && "sourceOrderId" in review ? (
        <div
          className="mt-3 space-y-2 border-t border-border pt-3"
          aria-label="Reviewed Expense association"
        >
          <p>
            Reviewed spending:{" "}
            {review.spend.before === null
              ? "unknown"
              : formatCurrency(review.spend.before)}{" "}
            →{" "}
            {review.spend.after === null
              ? "unknown"
              : formatCurrency(review.spend.after)}
            . No stock is received.
          </p>
          <ul>
            {review.originalAttributions.map((attribution) => (
              <li
                key={`${attribution.role}:${attribution.partyId ?? "unattributed"}`}
              >
                {attribution.role}: {attribution.partyId ?? "Unattributed"} ·{" "}
                {formatCurrency(attribution.amount)}
              </li>
            ))}
          </ul>
          <p>
            {review.payments.length} payment evidence rows ·{" "}
            {review.allocations.length} statement allocations preserved.
          </p>
          <Row>
            <Button
              disabled={link.isPending}
              onClick={() =>
                link.mutate({
                  sourceOrderId: review.sourceOrderId,
                  resolution: review.resolution,
                })
              }
            >
              Confirm reviewed link
            </Button>
            <Button variant="outline" onClick={() => setReview(null)}>
              Cancel
            </Button>
          </Row>
        </div>
      ) : null}
    </section>
  );
}

/** Offscreen editors must not start per-group catalogue queries on page load. */
function DeferredPhotoGroup({
  name,
  eager,
  children,
}: {
  name: string;
  eager: boolean;
  children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(eager);
  useEffect(() => {
    if (mounted) return;
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setMounted(true);
      },
      { rootMargin: "600px" },
    );
    if (region.current) observer.observe(region.current);
    return () => observer.disconnect();
  }, [mounted]);
  // Retain mounted editors after scrolling away so unfinished edits survive.
  return (
    <div ref={region}>
      {mounted ? (
        children
      ) : (
        <section className="min-h-80 border-t border-border pt-4">
          <h3 className="text-lg font-semibold">{name}</h3>
        </section>
      )}
    </div>
  );
}

export function PhotoGroupReview({
  runId,
  runStatus,
  hasAgent,
}: {
  runId: string;
  runStatus: string;
  hasAgent: boolean;
}) {
  const [batchKeys, setBatchKeys] = useState<Set<string>>(() => new Set());
  const [batchQueued, setBatchQueued] = useState(false);
  const [pendingEdits, setPendingEdits] = useState(0);
  const queryClient = useQueryClient();
  const query = usePhotoRunReview(runId, runStatus, hasAgent);
  const groupSections = useMemo(
    () =>
      (query.data?.review.proposals ?? []).map((proposal) => ({
        id: `photo-group-${proposal.groupKey}`,
        title: `${proposal.state === "proposed" ? (proposal.product.kind === "create" ? "Create" : "Attach") : proposal.state === "committed" ? "Applied" : "Discarded"} · ${proposalName(proposal)}`,
        icon: CheckCircleIcon,
        content: null,
      })),
    [query.data?.review.proposals],
  );
  useIndexedSubsections("photo-batch", groupSections);
  const action = useReviewAction(runId);
  // A focused field saves on blur. Safari can drop the following click when
  // that save rerenders the button, so approval waits for the save explicitly.
  const pendingSaves = useRef(new Set<Promise<void>>());
  const save: Save = (build) => {
    setPendingEdits((count) => count + 1);
    const pending = (async () => {
      const edit = await build();
      await action.mutateAsync({
        action: "save",
        groups: edit.groups,
        removeGroupKeys: edit.removeGroupKeys,
      });
    })();
    pendingSaves.current.add(pending);
    return pending.then(
      () => {
        pendingSaves.current.delete(pending);
        setPendingEdits((count) => count - 1);
        return true;
      },
      (error) => {
        pendingSaves.current.delete(pending);
        setPendingEdits((count) => count - 1);
        showErrorToast(error);
        return false;
      },
    );
  };
  const flushEdits = async (groupKeys: string[]) => {
    while (pendingSaves.current.size) await Promise.all(pendingSaves.current);
    // Blur saves acknowledge local drafts in a promise continuation. Flush that
    // acknowledgement before inspecting the DOM, including in hidden tabs.
    await Promise.resolve();
    flushSync(() => {});
    const unsaved = groupKeys.flatMap((key) => {
      const node = document
        .getElementById(`photo-group-${key}`)
        ?.querySelector<HTMLElement>(
          '[aria-invalid="true"], [data-photo-unsaved="true"]',
        );
      return node ? [node] : [];
    })[0];
    if (unsaved) {
      unsaved.focus();
      throw new Error(
        "Save or correct the edited field before applying this group",
      );
    }
  };
  const approve = async (groupKey: string) => {
    try {
      await flushEdits([groupKey]);
      const latest = queryClient.getQueryData<
        Awaited<ReturnType<typeof photoImport.review.call>>
      >(photoImport.review.queryKey({ runId }));
      const group = latest?.review.proposals.find(
        (item) => item.groupKey === groupKey,
      );
      if (!group)
        throw new Error("The group changed; refresh before applying it");
      await action.mutateAsync({
        action: "approve",
        groupKeys: [groupKey],
        expectedRevisions: [{ groupKey, updatedAt: group.updatedAt }],
      });
    } catch (error) {
      showErrorToast(error);
    }
  };
  const approveBatch = async () => {
    if (batchQueued) return;
    setBatchQueued(true);
    try {
      const groupKeys = [...batchKeys];
      await flushEdits(groupKeys);
      const latest = queryClient.getQueryData<
        Awaited<ReturnType<typeof photoImport.review.call>>
      >(photoImport.review.queryKey({ runId }));
      const expectedRevisions = (latest?.review.proposals ?? [])
        .filter((proposal) => batchKeys.has(proposal.groupKey))
        .map((proposal) => ({
          groupKey: proposal.groupKey,
          updatedAt: proposal.updatedAt,
        }));
      if (expectedRevisions.length !== groupKeys.length)
        throw new Error(
          "Photo group review changed; reload before approving this batch",
        );
      const result = await action.mutateAsync({
        action: "approve",
        groupKeys,
        expectedRevisions,
      });
      setBatchKeys(
        new Set(
          result.results
            .filter(
              (item) =>
                item.outcome === "failed" || item.outcome === "conflict",
            )
            .map((item) => item.groupKey),
        ),
      );
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBatchQueued(false);
    }
  };

  if (query.isLoading && !query.data)
    return <StatusText>Loading proposed groups…</StatusText>;
  if (query.isError && !query.data)
    return <StatusText tone="destructive">{query.error.message}</StatusText>;
  if (!query.data) return null;

  const { review, images } = query.data;
  const emptyCopy =
    query.data.lifecycle.phase === "needs_attention"
      ? {
          title: "Some photos need attention before grouping.",
          detail:
            query.data.lifecycle.dispatchError ??
            (query.data.lifecycle.failedImageIds.length
              ? "Retry failed descriptions above, or explicitly continue without those photos. Their originals are retained."
              : "Review the ungrouped photos below and use a photo’s menu to propose a group. Existing approved items are retained."),
        }
      : query.data.lifecycle.processor === "external"
        ? {
            title: "Waiting for your Claude/Codex session to propose groups.",
            detail:
              "Use the handoff above once descriptions are ready, or use a photo’s menu to create a group yourself.",
          }
        : query.data.lifecycle.processor === "cubby"
          ? {
              title: "Cubby will prepare item groups automatically.",
              detail:
                "Grouping waits for uploads and required descriptions. Proposed items will appear here for your approval.",
            }
          : emptyReviewCopy(review.runStatus, hasAgent);
  const imagesById: ImagesById = new Map(
    images.map((image) => [image.id, image]),
  );
  const proposed = review.proposals.filter(
    (proposal) => proposal.state === "proposed",
  );
  const settled = review.proposals.filter(
    (proposal) => proposal.state !== "proposed",
  );
  const results = review.proposals.filter(
    (proposal) => proposal.state === "committed" && proposal.committedProduct,
  );
  const productsById = new Map<string, (typeof results)[number]>();
  for (const proposal of results) {
    if (!proposal.committedProduct) continue;
    const previous = productsById.get(proposal.committedProduct.id);
    if (!previous || proposal.product.kind === "create")
      productsById.set(proposal.committedProduct.id, proposal);
  }
  const resultProducts = [...productsById.values()];
  const ready = proposed.filter(
    (proposal) =>
      !isStaleGroup(proposal, imagesById, review.runStatus) &&
      awaitingDescriptions(proposal, imagesById).length === 0 &&
      !(proposal.product.kind === "existing" && !proposal.product.existing) &&
      !proposal.conflict?.length &&
      Boolean(proposal.review) &&
      !proposal.review?.unresolvedReason &&
      (proposal.review?.stockIntent !== "receive" ||
        Boolean(proposal.inventory?.locationId)),
  );
  const selectedBatch = proposed.filter((proposal) =>
    batchKeys.has(proposal.groupKey),
  );
  const blockedBatch = selectedBatch.some(
    (proposal) =>
      isStaleGroup(proposal, imagesById, review.runStatus) ||
      awaitingDescriptions(proposal, imagesById).length > 0 ||
      (proposal.product.kind === "existing" && !proposal.product.existing) ||
      Boolean(proposal.conflict?.length) ||
      !proposal.review ||
      Boolean(proposal.review.unresolvedReason) ||
      (proposal.review.stockIntent === "receive" &&
        !proposal.inventory?.locationId),
  );
  const groupByImage = new Map<string, string>();
  for (const proposal of review.proposals)
    for (const entry of [...proposal.images, ...proposal.skip]) {
      groupByImage.set(entry.id, proposal.groupKey);
    }
  const busy = action.isPending || pendingEdits > 0;

  return (
    <Stack gap="lg">
      {results.length > 0 ? (
        <Section
          title="Import results"
          description={`${resultProducts.filter((proposal) => proposal.product.kind === "create").length} Products created · ${resultProducts.filter((proposal) => proposal.product.kind === "existing").length} existing Products matched`}
        >
          <RecordList aria-label="Products from this import">
            {resultProducts.map((proposal) =>
              proposal.committedProduct ? (
                <RecordRow
                  key={proposal.committedProduct.id}
                  leading={
                    <PhotoThumb
                      image={imagesById.get(
                        proposal.images.find(
                          (entry) => entry.purpose === "item",
                        )?.id ?? "",
                      )}
                      size={40}
                    />
                  }
                  primary={
                    <EntityRefLink
                      entity="product"
                      data={proposal.committedProduct}
                      displayImage={
                        proposal.committedProduct.coverUrl
                          ? { url: proposal.committedProduct.coverUrl }
                          : null
                      }
                    />
                  }
                  secondary={
                    proposal.product.kind === "create"
                      ? "Created by this import"
                      : "Matched existing Product"
                  }
                  trailing={
                    <Row gap="sm" wrap>
                      {results
                        .filter(
                          (result) =>
                            result.committedProduct?.id ===
                              proposal.committedProduct?.id &&
                            result.committedInventoryId,
                        )
                        .map((result) =>
                          result.committedInventoryId ? (
                            <EntityRefLink
                              key={result.committedInventoryId}
                              entity="inventory"
                              data={{
                                id: result.committedInventoryId,
                                name: `${result.inventory?.quantity ?? 0} received`,
                              }}
                              displayImage={null}
                            />
                          ) : null,
                        )}
                      {results.some(
                        (result) =>
                          result.committedProduct?.id ===
                            proposal.committedProduct?.id &&
                          result.committedInventoryId,
                      )
                        ? null
                        : "No inventory received"}
                    </Row>
                  }
                />
              ) : null,
            )}
          </RecordList>
        </Section>
      ) : null}
      <Section
        title="Photo review"
        description={`${proposed.length} to review · ${settled.length} settled · ${review.unassignedImageIds.length} photos not in a group`}
      >
        <output className="text-xs text-muted-foreground">
          {action.isPending
            ? action.variables?.action === "save"
              ? "Saving changes…"
              : "Applying decision…"
            : action.isError
              ? `Changes were not saved: ${action.error.message}`
              : action.isSuccess
                ? "Saved"
                : "Changes save when you leave a field."}
        </output>
        {proposed.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const unresolved =
                proposed.find(
                  (group) => !group.review || group.review.unresolvedReason,
                ) ?? proposed[0];
              if (unresolved) {
                const target = document.getElementById(
                  `photo-group-${unresolved.groupKey}`,
                );
                target?.scrollIntoView({ block: "start" });
                target?.focus({ preventScroll: true });
              }
            }}
          >
            Next unresolved item
          </Button>
        ) : null}
        {proposed.length > 0 ? (
          <Row align="center" justify="between" gap="sm" className="flex-wrap">
            <span className="text-xs text-muted-foreground">
              {selectedBatch.length
                ? `${selectedBatch.filter((group) => group.product.kind === "create").length} Products created · ${selectedBatch.filter((group) => group.product.kind === "existing").length} existing Products attached · ${selectedBatch.reduce((sum, group) => sum + (group.inventory?.quantity ?? 0), 0)} stock units received · ${selectedBatch.filter((group) => !group.inventory).length} groups with no stock change.`
                : "Select resolved items to apply together. Unresolved items stay in review."}
            </span>
            <Row gap="sm" wrap>
              <Button
                variant="outline"
                disabled={busy || batchQueued || ready.length === 0}
                onClick={() =>
                  setBatchKeys(
                    new Set(ready.map((proposal) => proposal.groupKey)),
                  )
                }
              >
                Select all resolved items
              </Button>
              {batchKeys.size > 0 ? (
                <Button
                  variant="ghost"
                  disabled={busy || batchQueued}
                  onClick={() => setBatchKeys(new Set())}
                >
                  Clear selection
                </Button>
              ) : null}
              <Button
                disabled={
                  selectedBatch.length === 0 ||
                  blockedBatch ||
                  (action.isPending && action.variables?.action !== "save") ||
                  batchQueued
                }
                onClick={() => void approveBatch()}
              >
                <CheckIcon />
                {batchQueued
                  ? "Approving selected items…"
                  : `Apply ${countLabel(selectedBatch.length, "selected item")}`}
              </Button>
            </Row>
          </Row>
        ) : null}
        {proposed.length === 0 ? (
          settled.length ? (
            <StatusText tone="muted">
              Every proposed group has been approved or discarded.
            </StatusText>
          ) : (
            <Stack gap="sm" className="items-start">
              <StatusText tone="muted">{emptyCopy.title}</StatusText>
              {images.length ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {emptyCopy.detail}
                  </p>
                </>
              ) : null}
            </Stack>
          )
        ) : null}
      </Section>
      {review.proposals.length > 0 ? (
        <div className="min-w-0">
          <div className="min-w-0 space-y-6">
            {review.proposals.map((selected, index) => (
              <div
                key={selected.groupKey}
                id={`photo-group-${selected.groupKey}`}
                className="scroll-mt-20"
                data-detail-section
                tabIndex={-1}
              >
                {selected.state === "proposed" ? (
                  <label className="flex min-h-11 items-center gap-2 border-t border-border px-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Select ${proposalName(selected)} for batch approval`}
                      checked={batchKeys.has(selected.groupKey)}
                      disabled={busy || batchQueued}
                      onChange={(event) =>
                        setBatchKeys((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(selected.groupKey);
                          else next.delete(selected.groupKey);
                          return next;
                        })
                      }
                    />
                    Select for batch
                  </label>
                ) : null}
                {selected.state === "proposed" ? (
                  <DeferredPhotoGroup
                    name={proposalName(selected)}
                    eager={index === 0}
                  >
                    <ProposalCard
                      key={selected.groupKey}
                      runId={runId}
                      runStatus={review.runStatus}
                      proposal={selected}
                      proposals={review.proposals}
                      imagesById={imagesById}
                      busy={busy}
                      save={save}
                      action={action}
                      approve={approve}
                    />
                  </DeferredPhotoGroup>
                ) : (
                  <CollapsibleSection
                    className="min-w-0 border-t border-border pt-3"
                    title={
                      <span>
                        {selected.state === "committed"
                          ? "Approved"
                          : "Discarded"}{" "}
                        · {proposalName(selected)}
                      </span>
                    }
                  >
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selected.images
                        .map((entry) => `${entry.purpose} ${entry.id}`)
                        .join(" · ") || "No attached photos"}
                    </p>
                    {selected.committedProduct && (
                      <p className="mt-2 text-sm">
                        <EntityRefLink
                          entity="product"
                          data={{
                            id: selected.committedProduct.id,
                            name: selected.committedProduct.name,
                          }}
                          displayImage={null}
                        />
                      </p>
                    )}
                    {selected.committedInventoryId ? (
                      <p className="mt-1 text-xs">
                        Inventory entry{" "}
                        <EntityRefLink
                          entity="inventory"
                          data={{
                            id: selected.committedInventoryId,
                            name:
                              selected.inventory?.locationName ||
                              selected.committedInventoryId,
                          }}
                          displayImage={null}
                        />{" "}
                        · {selected.inventory?.quantity ?? 0} received
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        No Inventory write
                      </p>
                    )}
                    {selected.state === "committed" && (
                      <ExpenseLinkReview runId={runId} proposal={selected} />
                    )}
                    {selected.state === "committed" &&
                      selected.product.kind === "create" && (
                        <CollapsibleSection
                          className="mt-4 border-t border-border pt-3"
                          title="Review possible matches"
                        >
                          <PhotoProductSuggestions
                            runId={runId}
                            proposal={selected}
                            settled
                          />
                        </CollapsibleSection>
                      )}
                  </CollapsibleSection>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {review.unassignedImageIds.length ? (
        <Section
          aria-label="Not in a group"
          title={`Not in a group · ${review.unassignedImageIds.length}`}
        >
          <PhotoGrid
            images={review.unassignedImageIds.flatMap((id) =>
              photoTile(imagesById.get(id)),
            )}
            renderOverlay={(tile) => (
              <div className="absolute top-1 right-1">
                <ImageMenu
                  imageId={tile.id}
                  groupKey={null}
                  purpose={null}
                  proposals={review.proposals}
                  save={save}
                  disabled={busy}
                />
              </div>
            )}
          />
        </Section>
      ) : null}

      {images.length ? (
        <PhotoTable images={images} groupByImage={groupByImage} />
      ) : (
        <StatusText tone="muted">
          No photos have been uploaded for this batch.
        </StatusText>
      )}
    </Stack>
  );
}
