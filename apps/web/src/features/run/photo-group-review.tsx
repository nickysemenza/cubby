import type {
  ImageShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ImageProcessingJobState } from "@cubby/schemas/image-processing";
import type {
  PhotoGroupReview as PhotoGroupDecision,
  PhotoGroupProposal,
  PhotoFieldCrossCheck,
  PhotoProductEvidence,
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
import { ProductExternalIds } from "~/entity/components/product-external-ids";
import { entityDetailFor } from "~/entity/entity-detail";
import { PhotoGrid } from "~/entity/entity-media/photo-grid";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Picker } from "~/entity/picker/picker";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { ShortcodeProse } from "~/entity/prose/shortcode-prose";
import { useOptimisticDisplayValue } from "~/entity/table/editable-cell";
import { ProductVariantEvidence } from "~/features/product/product-variant-evidence";
import {
  RUN_TARGET_STATE_LABEL,
  RUN_TARGET_STATE_VARIANT,
} from "~/features/run/run-target-state";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  photoImport,
  product as productOperations,
  purchaseImport,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCurrency } from "~/lib/number-format";
import { DateDisplay } from "~/ui/common/date-display";
import { DecisionSteps } from "~/ui/common/decision-steps";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { useIndexedSubsections } from "~/ui/data-table/indexed-sections";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Row, Section, Stack } from "~/ui/layout";
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
import { InlineTextDiff } from "~/ui/text/inline-text-diff";

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
import { loadPhotoRunCandidateChunks } from "./photo-run-candidates";

function postReview(runId: string, action: ReviewPhotoGroupsAction) {
  if (action.action === "save")
    return photoImport.saveGroups.call({ ...action, runId });
  if (action.action === "approve")
    return photoImport.approveGroups.call({ ...action, runId });
  return photoImport.discardGroup.call({ ...action, runId });
}

function usePhotoRunCandidates(runId: string, enabled = false) {
  const queryClient = useQueryClient();
  return useQuery({
    ...photoImport.candidatesBatch.queryOptions({ runId }),
    queryFn: async ({ signal }) => {
      const review = await queryClient.ensureQueryData(
        photoImport.review.queryOptions({ runId }),
      );
      return loadPhotoRunCandidateChunks(
        review.review.proposals.map((proposal) => proposal.groupKey),
        (groupKeys) =>
          photoImport.candidatesBatch.call(
            { runId, groupKeys },
            { signal, batch: false },
          ),
      );
    },
    enabled,
    staleTime: Infinity,
  });
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
    onSuccess: async (data, action) => {
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
      await invalidateOperationTags(
        queryClient,
        action.action === "approve"
          ? photoImport.approveGroups.invalidates({ ...action, runId })
          : ripple.runOnly,
        { removeInactive: action.action === "approve" },
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
        className="grid-cols-1 sm:grid-cols-1 md:grid-cols-1"
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
      {!proposal.images.some((entry) => entry.purpose === "label") ? (
        <div
          aria-label="Label photo missing"
          className="flex aspect-square flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-xs text-muted-foreground"
        >
          <span className="font-medium text-foreground">Label</span>
          <span>Missing</span>
        </div>
      ) : !proposal.images.some(
          (entry) =>
            entry.purpose === "label" &&
            imagesById.get(entry.id)?.recognizedText?.trim(),
        ) ? (
        <p className="text-xs text-muted-foreground">
          Label photo ·{" "}
          {proposal.images.some(
            (entry) =>
              entry.purpose === "label" &&
              imagesById.get(entry.id)?.describe !== "ready",
          )
            ? "Text analysis incomplete"
            : "Unreadable"}
        </p>
      ) : null}
      {proposal.skip.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          title={proposal.skip.map((entry) => entry.reason).join(" · ")}
        >
          {countLabel(proposal.skip.length, "skipped photo")} · kept in run only
        </p>
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
    </div>
  );
}

// Style/model codes: letters and digits mixed, at least five characters.
const LABEL_IDENTIFIER = /^(?=.*\p{L})(?=.*\p{N})[\p{L}\p{N}-]{5,}$/u;

function labelLines(text: string) {
  const seen = new Set<string>();
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      const key = line.toLocaleLowerCase();
      if (!line || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function LabelText({ text }: { text: string }) {
  const lines = labelLines(text);
  if (!lines.length) return null;
  return (
    <p
      className="rounded bg-muted px-1.5 py-1 font-mono text-2xs leading-relaxed break-words"
      aria-label="Label text"
    >
      {lines.map((line, index) => (
        <span key={line}>
          {index ? <span className="text-muted-foreground"> · </span> : null}
          {line.split(/(\s+)/).map((part) =>
            LABEL_IDENTIFIER.test(part) ? (
              <strong key={part} className="font-semibold">
                {part}
              </strong>
            ) : (
              part
            ),
          )}
        </span>
      ))}
    </p>
  );
}

function ClampedText({ children }: { children: string }) {
  const [open, setOpen] = useState(false);
  const long = children.length > 140;
  return (
    <div>
      <p className={open || !long ? undefined : "line-clamp-3"}>{children}</p>
      {long ? (
        <button
          type="button"
          className="text-muted-foreground underline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

function GroupEvidence({
  proposal,
  imagesById,
}: {
  proposal: PhotoGroupProposal;
  imagesById: ImagesById;
}) {
  const photos = [...proposal.images, ...proposal.skip].flatMap((entry) => {
    const photo = imagesById.get(entry.id);
    return photo ? [photo] : [];
  });
  const missing = photos.filter(
    (photo) =>
      photo.descriptionEvidence?.missingReason && !photo.recognizedText?.trim(),
  ).length;
  return (
    <section aria-label="Photo evidence" className="space-y-2 text-xs">
      {photos.map((photo) => {
        const description =
          photo.descriptionEvidence?.description ?? photo.description;
        const claims = photo.descriptionEvidence?.claims ?? [];
        if (!description && !photo.recognizedText?.trim()) return null;
        return (
          <div key={photo.id} className="space-y-1">
            {photo.recognizedText ? (
              <LabelText text={photo.recognizedText} />
            ) : null}
            {description ? (
              <div className="text-muted-foreground">
                {photo.descriptionEvidence?.authority === "member" ? (
                  <span className="font-medium text-foreground">Yours · </span>
                ) : null}
                <ClampedText>{description}</ClampedText>
              </div>
            ) : null}
            {claims.length ? (
              <details className="text-muted-foreground">
                <summary className="cursor-pointer">
                  {countLabel(claims.length, "claim")}
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {claims.map((claim) => (
                    <li key={`${claim.evidenceKind}-${claim.text}`}>
                      {claim.text}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      {missing ? (
        <p className="text-muted-foreground">
          {missing === photos.length
            ? "No description analysis retained."
            : `${countLabel(missing, "photo")} without description analysis.`}
        </p>
      ) : null}
    </section>
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
  crossCheck,
  actions,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void | Promise<boolean> | string;
  disabled: boolean;
  type?: "text" | "number";
  className?: string;
  options?: readonly { value: string; count: number }[];
  optionsLoading?: boolean;
  crossCheck?: PhotoFieldCrossCheck;
  actions?: ReactNode;
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
            flushSync(() => {
              acknowledgedRef.current = next;
              setAcknowledged(next);
            });
          }
        });
    }
  };
  return (
    <div
      data-photo-field
      className={`min-w-0 gap-1 text-xs ${crossCheck ? "grid grid-cols-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-2" : "flex flex-col"} ${className ?? ""}`}
    >
      <label htmlFor={inputId} className="text-muted-foreground">
        {label}
      </label>
      <div
        className={
          crossCheck
            ? "grid grid-cols-1 items-center gap-2 sm:grid-cols-2"
            : undefined
        }
      >
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
        {crossCheck &&
        (crossCheck.labelValue || crossCheck.mark !== "unknown") ? (
          <div className="min-w-0 space-y-1">
            <p className="text-muted-foreground">
              <FieldMark check={crossCheck} />{" "}
              {crossCheck.mark === "agree"
                ? "Matches label"
                : crossCheck.labelValue
                  ? `Label: ${crossCheck.labelValue}`
                  : crossCheck.mark === "unknown"
                    ? "Not shown on label"
                    : "Label differs"}
            </p>
            {actions ? (
              <Row gap="xs" wrap>
                {actions}
              </Row>
            ) : null}
          </div>
        ) : null}
      </div>
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
          <span id={hintId} className="text-muted-foreground sm:col-start-2">
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
      unresolvedReason: null,
      stockIntent: proposal.inventory ? "receive" : "evidence",
    }
  );
}

function IdentityDecision({
  runId,
  proposal,
  busy,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  busy: boolean;
}) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const replyId = useId();
  const resolve = useMutation({
    mutationFn: (
      input: Parameters<typeof photoImport.resolveConcern.call>[0],
    ) => photoImport.resolveConcern.call(input),
    onSuccess: async () => {
      setReply("");
      await invalidateOperationTags(queryClient, ripple.runOnly);
    },
    onError: (error) => showErrorToast(error),
  });
  const concern = proposal.review?.unresolvedReason;
  if (
    !concern ||
    concern === "Confirm the observed identity before applying this group"
  )
    return null;
  return (
    <Stack gap="xs">
      <p className="text-xs">Agent's concern: {concern}</p>
      <label htmlFor={replyId} className="flex flex-col gap-1 text-xs">
        Reply (optional)
        <Input
          id={replyId}
          maxLength={500}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          disabled={busy || resolve.isPending}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || resolve.isPending}
        onClick={() =>
          resolve.mutate({
            runId,
            groupKey: proposal.groupKey,
            reply: reply.trim() || undefined,
            expectedRevision: proposal.updatedAt,
          })
        }
      >
        Resolved
      </Button>
    </Stack>
  );
}

const crossCheckMark = {
  agree: "✓",
  "disagree-or-missing": "!",
  unknown: "?",
} as const;
const crossCheckMeaning = {
  agree: "Matches the label",
  "disagree-or-missing": "Label differs or adds a term",
  unknown: "Label doesn't confirm this",
} as const;

function FieldMark({ check }: { check: PhotoFieldCrossCheck }) {
  return (
    <span
      className={
        check.mark === "agree"
          ? "text-positive"
          : check.mark === "disagree-or-missing"
            ? "text-warning"
            : "text-muted-foreground"
      }
      title={`${crossCheckMeaning[check.mark]}${check.source === "model" ? " (model judgment)" : ""}`}
    >
      <span aria-hidden>{crossCheckMark[check.mark]}</span>
      <span className="sr-only">{crossCheckMeaning[check.mark]}</span>
    </span>
  );
}

const fieldLabel = (field: PhotoFieldCrossCheck["field"]) =>
  field === "color" ? "colour" : field;

function FieldCrossChecks({
  checks,
  product,
  unavailable,
  identifiers,
  changedFields,
}: {
  checks: readonly PhotoFieldCrossCheck[];
  product?: Pick<PhotoProductEvidence, "name" | "manufacturer" | "model">;
  unavailable: boolean;
  identifiers?: ReactNode;
  changedFields?: PhotoGroupDecision["productChanges"];
}) {
  // Keep missing evidence quiet unless the field has a pending edit to review.
  const evidenced = checks.filter(
    (check) =>
      Boolean(check.labelValue) ||
      check.mark === "disagree-or-missing" ||
      Boolean(changedFields && Object.hasOwn(changedFields, check.field)),
  );
  if (!evidenced.length) return null;
  const pending = (check: PhotoFieldCrossCheck) =>
    Boolean(
      changedFields &&
      Object.hasOwn(
        changedFields,
        check.field === "size" || check.field === "color"
          ? "name"
          : check.field,
      ),
    );
  const stored = (check: PhotoFieldCrossCheck) => {
    if (check.field === "identifiers") return identifiers;
    if (
      check.field === "manufacturer" ||
      check.field === "model" ||
      check.field === "name"
    )
      return product
        ? product[check.field]
        : unavailable
          ? "Current product unavailable"
          : "Loading current product…";
    return pending(check) ? "See current product name" : check.productValue;
  };
  return (
    <div className="space-y-1 text-xs" aria-label="Field cross-checks">
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)_1rem] gap-x-3 gap-y-1">
        <span />
        <span className="text-muted-foreground">Photo label</span>
        <span className="text-muted-foreground">Current product</span>
        <span />
        {evidenced.map((check) => (
          <div
            key={check.field}
            className="contents"
            data-cross-check={check.field}
          >
            <span className="text-muted-foreground">
              {fieldLabel(check.field)}
            </span>
            <span className="break-words">
              {check.labelValue ?? "Not shown on label"}
              {check.field === "identifiers" &&
              check.labelValue &&
              check.mark !== "agree" ? (
                <span className="block text-muted-foreground">
                  Printed code · type unverified
                </span>
              ) : null}
            </span>
            <span className="break-words">
              {stored(check) || (
                <span className="text-muted-foreground">Not recorded</span>
              )}
              {check.field === "size" || check.field === "color" ? (
                <span className="block text-muted-foreground">
                  From product name
                </span>
              ) : null}
              {pending(check) ? (
                <span className="block text-muted-foreground">
                  Proposed change below
                </span>
              ) : null}
            </span>
            {pending(check) ? (
              <span title="Comparison includes a proposed change; review it below">
                ?
              </span>
            ) : (
              <FieldMark check={check} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type PurchaseLine = NonNullable<PhotoProductEvidence["purchaseLines"]>[number];

function PurchaseLineRow({ line }: { line: PurchaseLine }) {
  return (
    <Row gap="xs" wrap align="center" className="min-w-0">
      <span className="text-muted-foreground">{line.dateLabel ?? "Paid"}</span>
      {line.date ? <DateDisplay start={line.date} /> : <span>Undated</span>}
      <span className="text-muted-foreground">·</span>
      {line.purchaseId ? (
        <EntityRefLink
          variant="chip"
          entity="purchase"
          id={line.purchaseId}
          name={
            line.purchaseLabel && line.purchaseLabel !== line.vendor
              ? line.purchaseLabel
              : "Order"
          }
          displayImage={null}
        />
      ) : null}
      {line.vendorId && line.vendor ? (
        <EntityRefLink
          variant="chip"
          entity="vendor"
          id={line.vendorId}
          name={line.vendor}
          displayImage={null}
        />
      ) : line.vendor && !line.purchaseId ? (
        <span>{line.vendor}</span>
      ) : null}
      <span className="text-muted-foreground">·</span>
      <EntityRefLink
        entity="expense"
        data={{
          id: line.expenseId,
          name: line.cost == null ? "Price unknown" : formatCurrency(line.cost),
        }}
        displayImage={null}
      />
      {line.productQuantity != null && line.productQuantity !== 1 ? (
        <span className="text-muted-foreground">× {line.productQuantity}</span>
      ) : null}
    </Row>
  );
}

function PurchaseLines({
  lines,
  total,
  productId,
}: {
  lines: readonly PurchaseLine[];
  total: number;
  productId: ProductShortcode;
}) {
  const [latest, ...rest] = lines;
  if (!latest)
    return <p className="text-muted-foreground">No purchases recorded</p>;
  const hidden = total - lines.length;
  return (
    <div className="space-y-1">
      <PurchaseLineRow line={latest} />
      {rest.length || hidden > 0 ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {countLabel(total - 1, "more purchase")}
          </summary>
          <div className="mt-1 space-y-1">
            {rest.map((line) => (
              <PurchaseLineRow key={line.expenseId} line={line} />
            ))}
            {hidden > 0 ? (
              <Link
                to="/products/$shortcode"
                params={{ shortcode: productId }}
                className="text-muted-foreground underline"
              >
                All {total} on the Product
              </Link>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function OnHand({ product }: { product: PhotoProductEvidence }) {
  const entries = product.inventoryEntries ?? [];
  if (entries.length)
    return (
      <Row gap="xs" wrap align="center">
        <span className="text-muted-foreground">On hand</span>
        {entries.map((entry) => (
          <Row key={entry.id} gap="xs" align="center">
            <span>
              {entry.amount.value} {entry.amount.unit}
            </span>
            <EntityRefLink
              entity="location"
              data={{ id: entry.location.id, name: entry.location.name }}
              displayImage={null}
            />
          </Row>
        ))}
      </Row>
    );
  const units = product.quantity?.onHandUnits;
  return units == null ? null : (
    <p>
      <span className="text-muted-foreground">On hand</span> {units}
    </p>
  );
}

function SelectedProductEvidence({
  runId,
  productId,
  showCover = false,
  identifiers,
}: {
  runId: string;
  productId: ProductShortcode;
  showCover?: boolean;
  identifiers?: ReactNode;
}) {
  const evidence = useQuery(
    photoImport.productEvidence.queryOptions({ runId, productId }),
  );
  if (evidence.isError)
    return <StatusText tone="destructive">{evidence.error.message}</StatusText>;
  if (!evidence.data)
    return (
      <p className="text-xs text-muted-foreground">Loading Product evidence…</p>
    );
  const product = evidence.data;
  return (
    <Stack gap="xs" className="text-xs">
      {showCover ? (
        <Row gap="sm" align="start">
          {product.coverUrl ? (
            <Image
              src={product.coverUrl}
              alt="In Cubby cover"
              displayWidth={112}
              className="size-28 shrink-0 rounded object-contain"
            />
          ) : (
            <span className="flex size-28 shrink-0 items-center justify-center rounded bg-background text-muted-foreground">
              No cover photo
            </span>
          )}
          <div className="min-w-0">
            <p className="text-muted-foreground">In Cubby</p>
            <EntityRefLink
              entity="product"
              data={{ id: product.id, name: product.name }}
              displayImage={null}
              className="font-medium"
            />
            {product.manufacturer ? <p>{product.manufacturer}</p> : null}
            {product.model ? <p>{product.model}</p> : null}
          </div>
        </Row>
      ) : null}
      {identifiers ? (
        <Row gap="sm" align="start">
          <span className="text-muted-foreground">Identifiers</span>
          {identifiers}
        </Row>
      ) : null}
      <PurchaseLines
        lines={product.purchaseLines ?? []}
        total={product.purchaseLineCount ?? product.purchaseLines?.length ?? 0}
        productId={product.id}
      />
      <OnHand product={product} />
      {product.ownPhotos?.length ? (
        <Row gap="sm" wrap>
          <span className="text-muted-foreground">Your photos</span>
          {product.ownPhotos?.map((photo) => (
            <div key={photo.id}>
              <Image
                src={photo.url}
                alt="Own Product photo"
                displayWidth={56}
                className="size-14 object-contain"
              />
              <p>
                Taken{" "}
                {photo.capturedAt ? (
                  <DateDisplay start={photo.capturedAt} />
                ) : (
                  "date unknown"
                )}
              </p>
            </div>
          ))}
        </Row>
      ) : null}
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
  const [open, setOpen] = useState(
    Boolean(Object.keys(proposal.review?.productChanges ?? {}).length),
  );
  const [showUnchanged, setShowUnchanged] = useState(false);
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
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        Product changes ·{" "}
        {countLabel(Object.keys(changes).length, "selected field")}
      </summary>
      <p className="my-2 text-muted-foreground">
        Only selected fields change when you attach the photos. Added text is
        green; removed text is red and struck through.
      </p>
      {current.isError ? (
        <StatusText tone="destructive">{current.error.message}</StatusText>
      ) : null}
      {current.data ? (
        <Stack gap="sm">
          {(["name", "manufacturer", "model", "notes", "tags"] as const)
            .filter((field) => showUnchanged || Object.hasOwn(changes, field))
            .map((field) => {
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
                      <div aria-label={`Proposed ${field} change`}>
                        <p className="text-muted-foreground">
                          {after
                            ? before
                              ? `Replace ${field}`
                              : `Set ${field}`
                            : `Clear ${field}`}{" "}
                          · Current → Proposed
                        </p>
                        <InlineTextDiff
                          before={before}
                          after={after}
                          beforeLabel="Current"
                          afterLabel="Proposed"
                          wrap
                        />
                      </div>
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
            })}
          {showUnchanged || Object.hasOwn(changes, "categoryId") ? (
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
          ) : null}
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowUnchanged((shown) => !shown)}
          >
            {showUnchanged ? "Hide unchanged fields" : "Show unchanged fields"}
          </Button>
        </Stack>
      ) : open && !current.isError ? (
        <p>Loading current Product…</p>
      ) : null}
    </details>
  );
}

function selectPhotoProduct(
  proposal: PhotoGroupProposal,
  next: PhotoGroupProposalGroup["product"],
): PhotoGroupProposalGroup {
  const product = proposal.product;
  const input = toGroupInput(proposal, { product: next });
  if (
    input.inventory?.existingEntryId &&
    (next.kind !== "existing" ||
      product.kind !== "existing" ||
      next.existingId !== product.existing?.id)
  )
    input.inventory = {
      ...input.inventory,
      mode: "create",
      existingEntryId: undefined,
    };
  const review = reviewDecision(proposal);
  return {
    ...input,
    review: {
      ...review,
      observedName:
        next.kind === "create" ? next.create.name : review.observedName,
      productChanges:
        next.kind === "existing" &&
        product.kind === "existing" &&
        next.existingId === product.existing?.id
          ? review.productChanges
          : undefined,
    },
  };
}

function ProductPanel({
  runId,
  proposal,
  save,
  busy,
  step,
  labelText,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  save: Save;
  busy: boolean;
  step: string;
  labelText: string;
}) {
  const saveGroup: SaveGroup = (build) =>
    save(async () => ({ groups: [await build()], removeGroupKeys: [] }));
  const product = proposal.product;
  const manufacturers = useQuery({
    ...productOperations.manufacturerOptions.queryOptions(),
    enabled: product.kind === "create",
  });
  const batch = usePhotoRunCandidates(runId);
  const candidates = batch.data?.groups.find(
    (group) => group.groupKey === proposal.groupKey,
  );
  const inferred =
    product.kind === "existing" &&
    candidates?.selectedComparison?.id === product.existing?.id
      ? (candidates?.selectedComparison?.crossCheck ?? [])
      : [];
  const checks = (proposal.crossCheck ?? []).map((check) =>
    check.source === "model" &&
    (check.field === "color" || check.field === "size")
      ? (inferred.find(
          (candidate) =>
            candidate.source === "model" && candidate.field === check.field,
        ) ?? check)
      : check,
  );
  const currentProduct = useQuery(
    entityDetailFor("product").queryOptions(
      product.kind === "existing" ? (product.existing?.id ?? "") : "",
      {
        enabled:
          step === "identity" &&
          product.kind === "existing" &&
          Boolean(product.existing),
      },
    ),
  );
  const [showCandidates, setShowCandidates] = useState(false);
  const [identityAccepted, setIdentityAccepted] = useState(false);
  const queryClient = useQueryClient();
  const saveProduct = (next: PhotoGroupProposalGroup["product"]) => {
    return saveGroup(() => selectPhotoProduct(proposal, next));
  };
  const attachExisting = (existingId: ProductShortcode) =>
    saveProduct({ kind: "existing", existingId });
  const reject = useMutation({
    mutationFn: (
      input: Parameters<typeof photoImport.rejectCandidate.call>[0],
    ) => photoImport.rejectCandidate.call(input),
    onSuccess: async () => {
      setShowCandidates(true);
      await saveProduct({
        kind: "create",
        create: {
          name: proposal.review?.observedName ?? proposalName(proposal),
        },
      });
      await invalidateOperationTags(queryClient, ripple.runOnly);
    },
    onError: (error) => showErrorToast(error),
  });
  if (step === "product")
    return (
      <Stack gap="sm">
        <Picker
          mode="segmented"
          label="Product choice"
          value={product.kind}
          disabled={busy}
          options={[
            { value: "existing", label: "Existing" },
            { value: "create", label: "New" },
          ]}
          onValueChange={(kind) => {
            if (kind === "create" && product.kind !== "create")
              void saveProduct({
                kind: "create",
                create: {
                  name:
                    proposal.review?.observedName ??
                    product.existing?.name ??
                    "New product",
                },
              });
            setShowCandidates(kind === "existing");
          }}
        />
        <EntityReferencePicker
          entity="product"
          label="existing product"
          value={null}
          setValue={(item) => {
            if (item) void attachExisting(item.id);
          }}
          disabled={busy}
          placeholder="Choose an existing product"
        />
      </Stack>
    );
  if (step === "ownership")
    return <InventoryFields proposal={proposal} save={saveGroup} busy={busy} />;
  return (
    <Stack gap="sm" className="min-w-0">
      <IdentityDecision runId={runId} proposal={proposal} busy={busy} />
      {product.kind === "create" ? (
        <>
          <Stack gap="sm">
            <CommitInput
              label="New product name"
              crossCheck={checks.find((check) => check.field === "name")}
              actions={[
                ...new Set(
                  checks.flatMap((check) =>
                    check.mark === "disagree-or-missing" &&
                    check.suggestion?.kind === "add_to_name" &&
                    !product.create.name
                      .toLocaleLowerCase()
                      .includes(check.suggestion.value.toLocaleLowerCase())
                      ? [check.suggestion.value]
                      : [],
                  ),
                ),
              ].map((text) => (
                <Button
                  key={text}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    saveProduct({
                      kind: "create",
                      create: {
                        ...product.create,
                        name: `${product.create.name} ${text}`,
                      },
                    })
                  }
                >
                  Add ‘{text}’ to name
                </Button>
              ))}
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
            <Stack gap="sm" className="min-w-0">
              <CommitInput
                label="Manufacturer"
                crossCheck={checks.find(
                  (check) => check.field === "manufacturer",
                )}
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
                crossCheck={checks.find((check) => check.field === "model")}
                actions={checks.flatMap((check) =>
                  check.mark === "disagree-or-missing" &&
                  check.suggestion?.kind === "set_model" &&
                  check.suggestion.value !== product.create.model
                    ? [
                        <Button
                          key={check.suggestion.value}
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            saveProduct({
                              kind: "create",
                              create: {
                                ...product.create,
                                model: check.suggestion?.value ?? null,
                              },
                            })
                          }
                        >
                          Use {check.suggestion.value} as model
                        </Button>,
                      ]
                    : [],
                )}
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
            </Stack>
          </Stack>
          <details className="text-xs">
            <summary className="cursor-pointer">Notes and tags</summary>
            <Stack gap="xs">
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
        </>
      ) : (
        <>
          <FieldCrossChecks
            checks={checks}
            product={currentProduct.data ?? undefined}
            unavailable={
              currentProduct.isError ||
              (currentProduct.isSuccess && !currentProduct.data)
            }
            changedFields={proposal.review?.productChanges}
            identifiers={
              currentProduct.data ? (
                currentProduct.data.externalIds.length ? (
                  <ProductExternalIds
                    identifiers={currentProduct.data.externalIds}
                  />
                ) : (
                  "Not recorded"
                )
              ) : currentProduct.isError || currentProduct.isSuccess ? (
                "Current product unavailable"
              ) : (
                "Loading identifier types…"
              )
            }
          />
          {currentProduct.isError ? (
            <StatusText tone="destructive">
              {currentProduct.error.message}
            </StatusText>
          ) : null}
          {product.existing ? (
            <SelectedProductEvidence
              runId={runId}
              productId={product.existing.id}
              showCover={!labelText.trim()}
              identifiers={
                currentProduct.data?.externalIds.length &&
                !checks.some(
                  (check) => check.field === "identifiers" && check.labelValue,
                ) ? (
                  <ProductExternalIds
                    identifiers={currentProduct.data.externalIds}
                  />
                ) : null
              }
            />
          ) : (
            <StatusText tone="warning">Choose a live Product.</StatusText>
          )}
          <Row gap="sm" wrap>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || identityAccepted}
              onClick={() => setIdentityAccepted(true)}
            >
              {identityAccepted
                ? "Selected Product accepted"
                : "Yes, this is it"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || reject.isPending}
              onClick={() => {
                if (product.kind === "existing" && product.existing)
                  reject.mutate({
                    runId,
                    groupKey: proposal.groupKey,
                    productId: product.existing.id,
                    operationId: crypto.randomUUID(),
                  });
              }}
            >
              Not this one…
            </Button>
          </Row>
          <ExistingProductChanges
            proposal={proposal}
            save={saveGroup}
            busy={busy}
          />
        </>
      )}
      {showCandidates ? (
        <PhotoProductSuggestions
          runId={runId}
          proposal={proposal}
          onPick={attachExisting}
          busy={busy}
          expanded
        />
      ) : null}
      {proposal.evidence ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Why the agent proposed this
          </summary>
          <p className="mt-1 leading-relaxed whitespace-pre-wrap">
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
  expanded = false,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  onPick?: (id: ProductShortcode) => void;
  busy?: boolean;
  settled?: boolean;
  expanded?: boolean;
}) {
  const suggestions = usePhotoRunCandidates(runId);
  const group = suggestions.data?.groups.find(
    (item) => item.groupKey === proposal.groupKey,
  );
  const closest = group?.candidates[0];
  const strongDuplicate =
    proposal.product.kind === "create" &&
    closest?.duplicateStrength === "strong";
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  if (suggestions.isError || group?.status === "failed")
    return (
      <Stack gap="xs">
        <Row gap="xs">
          <span className="text-xs">Couldn't check ·</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={suggestions.isFetching}
            onClick={() => void suggestions.refetch()}
          >
            Retry
          </Button>
        </Row>
        <StatusText tone="destructive">
          {group?.error ?? suggestions.error?.message}
        </StatusText>
      </Stack>
    );
  const selectedClosest =
    proposal.product.kind === "existing" &&
    closest?.id === proposal.product.existing?.id;
  if (selectedClosest && !open) return null;
  return (
    <Stack gap="xs">
      {selectedClosest ? null : !group ? (
        <p className="text-xs text-muted-foreground">
          Checking existing Products…
        </p>
      ) : closest && strongDuplicate ? (
        <Row
          gap="xs"
          align="center"
          wrap
          className="rounded bg-warning/10 px-2 py-1 text-xs text-warning"
        >
          Possible duplicate:
          <EntityRefLink
            entity="product"
            data={{ id: closest.id, name: closest.name }}
            displayImage={null}
          />
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Compare"}
          </Button>
        </Row>
      ) : closest ? (
        // Weak lexical neighbours are not evidence; offer the list without naming one.
        <Button
          size="sm"
          variant="ghost"
          className="self-start text-xs text-muted-foreground"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide existing Products" : "Compare existing Products"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          No matching existing Products.
        </p>
      )}
      {open ? (
        <RecordList>
          {group?.candidates.map((candidate) => (
            <RecordRow
              key={candidate.id}
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
                <Stack gap="xs">
                  <p className="text-xs">
                    Recorded count:{" "}
                    {candidate.quantity?.onHandUnits ?? "Not counted"} ·
                    Expected:{" "}
                    {candidate.quantity?.quantityLedger.expectedQuantity ??
                      "Unknown"}
                  </p>
                  {candidate.purchaseLines?.map((line) => (
                    <p key={line.expenseId} className="text-xs">
                      {line.dateLabel ?? "Paid"}{" "}
                      {line.date ? (
                        <DateDisplay start={line.date} />
                      ) : (
                        "date unknown"
                      )}{" "}
                      · {line.vendor ?? "Vendor unknown"} ·{" "}
                      {line.cost == null
                        ? "Price unknown"
                        : formatCurrency(line.cost)}{" "}
                      · +{line.productQuantity ?? "?"}
                    </p>
                  ))}
                </Stack>
              }
            />
          ))}
        </RecordList>
      ) : null}
      {group?.rejectedCandidates.map((candidate) => (
        <p key={candidate.id} className="text-xs text-muted-foreground">
          {candidate.name} · Rejected
        </p>
      ))}
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
      <div className="mb-2 flex flex-col gap-1 text-xs">
        Own it now?
        <Picker
          mode="choose"
          label="stock decision"
          value={review.stockIntent}
          disabled={busy}
          options={[
            { value: "evidence", label: "Just a reference photo" },
            { value: "counted", label: "Already counted · no stock change" },
            {
              value: "historical",
              label: "Historical or sold · no stock change",
            },
            { value: "receive", label: "Yes, add to inventory" },
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
    <Card
      className="rounded-none border-x-0 border-b-0 shadow-none"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !working &&
          !approvalQueued &&
          !proposal.blockedReason &&
          !stale
        ) {
          event.preventDefault();
          setApprovalQueued(true);
          void approve(proposal.groupKey).finally(() =>
            setApprovalQueued(false),
          );
        }
      }}
    >
      <CardHeader>
        <Row align="center" justify="between" wrap gap="sm">
          <Row align="center" gap="sm" className="min-w-0">
            <CardTitle as="h3" className="min-w-0 break-words">
              {proposalName(proposal)}
            </CardTitle>
            <Badge
              variant="secondary"
              className={
                proposal.product.kind === "create"
                  ? "bg-action-create-surface text-action-create"
                  : "bg-action-link-surface text-action-link"
              }
            >
              {proposal.product.kind === "create" ? "＋ New" : "↪ Attach"}
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
        <PhotoProductSuggestions
          runId={runId}
          proposal={proposal}
          busy={working}
          onPick={(existingId) => {
            void save(() => ({
              groups: [
                selectPhotoProduct(proposal, { kind: "existing", existingId }),
              ],
              removeGroupKeys: [],
            }));
          }}
        />
        <DecisionSteps
          aria-label="Photo group decisions"
          steps={proposal.steps.map((step) =>
            step.key === "identity" &&
            proposal.product.kind === "existing" &&
            !proposal.images.some((entry) =>
              imagesById.get(entry.id)?.recognizedText?.trim(),
            ) &&
            !proposal.review?.unresolvedReason
              ? {
                  ...step,
                  summary: "No label text — compare the photo with the product",
                }
              : step,
          )}
          media={
            <>
              <GroupPhotos
                proposal={proposal}
                proposals={proposals}
                imagesById={imagesById}
                save={save}
                editable
                busy={working}
              />
              <GroupEvidence proposal={proposal} imagesById={imagesById} />
            </>
          }
          renderBody={(step) => (
            <ProductPanel
              runId={runId}
              proposal={proposal}
              save={save}
              busy={working}
              step={step.key}
              labelText={proposal.images
                .map((entry) => imagesById.get(entry.id)?.recognizedText)
                .filter(Boolean)
                .join("\n")}
            />
          )}
        />
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
            onMouseDown={(event) => event.preventDefault()}
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
        {proposal.blockedReason ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {proposal.blockedReason}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">
            {proposal.product.kind === "create"
              ? `Creates ${proposalName(proposal)} and attaches ${countLabel(proposal.images.length, "photo")}`
              : `Attaches ${countLabel(proposal.images.length, "photo")} to ${proposalName(proposal)}`}
            {proposal.inventory?.locationId
              ? ` and adds ${countLabel(proposal.inventory.quantity, "unit")} at ${proposal.inventory.locationName}`
              : ""}
            .
            {proposal.product.kind === "existing" ? (
              <span className="block font-medium text-foreground">
                {Object.keys(proposal.review?.productChanges ?? {}).length ? (
                  `${countLabel(Object.keys(proposal.review?.productChanges ?? {}).length, "product change")} selected`
                ) : (
                  <span>No product details changed</span>
                )}{" "}
                · Add photos to gallery
              </span>
            ) : null}
          </p>
          <Button
            onMouseDown={(event) => event.preventDefault()}
            disabled={
              approvalQueued ||
              (action.isPending && action.variables?.action !== "save") ||
              stale ||
              descriptionsPending.length > 0 ||
              Boolean(proposal.blockedReason)
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
              ? "Create product"
              : `Attach ${countLabel(proposal.images.length, "photo")}`}
            <kbd aria-hidden="true" className="text-xs opacity-70">
              ⌘↵
            </kbd>
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

function PhotoNavGlyph({
  mode,
  state,
}: {
  mode: "create" | "existing";
  state: "needs" | "ready" | "applied";
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      aria-label={
        state === "needs"
          ? "Needs you"
          : state === "ready"
            ? "Ready"
            : "Applied"
      }
    >
      <span
        className={`size-1.5 rounded-full ${state === "needs" ? "bg-signal" : state === "ready" ? "bg-positive" : "bg-muted-foreground"}`}
      />
      <span
        className={
          mode === "create" ? "text-action-create" : "text-muted-foreground"
        }
      >
        {mode === "create" ? "＋" : "↪"}
      </span>
    </span>
  );
}
const NewNeedsInputGlyph = () => <PhotoNavGlyph mode="create" state="needs" />;
const NewReadyGlyph = () => <PhotoNavGlyph mode="create" state="ready" />;
const AttachNeedsInputGlyph = () => (
  <PhotoNavGlyph mode="existing" state="needs" />
);
const AttachReadyGlyph = () => <PhotoNavGlyph mode="existing" state="ready" />;
const AppliedNewPhotoGlyph = () => (
  <PhotoNavGlyph mode="create" state="applied" />
);
const AppliedPhotoGlyph = () => (
  <PhotoNavGlyph mode="existing" state="applied" />
);
const photoNavGlyphs = {
  create: {
    needs: NewNeedsInputGlyph,
    ready: NewReadyGlyph,
    applied: AppliedNewPhotoGlyph,
  },
  existing: {
    needs: AttachNeedsInputGlyph,
    ready: AttachReadyGlyph,
    applied: AppliedPhotoGlyph,
  },
};

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
  const { refetch: refetchCandidates } = usePhotoRunCandidates(
    runId,
    Boolean(query.data?.review.proposals.length),
  );
  const candidateRevision = (query.data?.review.proposals ?? [])
    .map((proposal) => proposal.updatedAt)
    .join("|");
  const previousCandidateRevision = useRef(candidateRevision);
  useEffect(() => {
    if (previousCandidateRevision.current === candidateRevision) return;
    const previous = previousCandidateRevision.current;
    previousCandidateRevision.current = candidateRevision;
    if (previous) void refetchCandidates();
  }, [candidateRevision, refetchCandidates]);
  const groupSections = useMemo(
    () =>
      (query.data?.review.proposals ?? []).map((proposal) => {
        const Icon =
          photoNavGlyphs[proposal.product.kind][
            proposal.state !== "proposed"
              ? "applied"
              : proposal.blockedReason
                ? "needs"
                : "ready"
          ];
        return {
          id: `photo-group-${proposal.groupKey}`,
          title: proposalName(proposal),
          icon: Icon,
          indexLeading: <Icon />,
          content: null,
        };
      }),
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
        flushSync(() => setPendingEdits((count) => count - 1));
        return true;
      },
      (error) => {
        pendingSaves.current.delete(pending);
        flushSync(() => setPendingEdits((count) => count - 1));
        showErrorToast(error);
        return false;
      },
    );
  };
  const flushEdits = async (groupKeys: string[]) => {
    // Keep mouse-down from blurring and moving Apply before its click arrives.
    // Then blur explicitly so the focused field's save joins this barrier.
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    while (pendingSaves.current.size) await Promise.all(pendingSaves.current);
    // Field acknowledgments run after the save counter settles. Their state
    // commits synchronously, so the DOM now reflects every completed save.
    await Promise.resolve();
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
      const result = await action.mutateAsync({
        action: "approve",
        groupKeys: [groupKey],
        expectedRevisions: [{ groupKey, updatedAt: group.updatedAt }],
      });
      if (
        result.results.some(
          (item) =>
            item.groupKey === groupKey &&
            (item.outcome === "committed" || item.outcome === "replayed"),
        )
      ) {
        const next = result.proposals.find(
          (item) => item.state === "proposed" && item.groupKey !== groupKey,
        );
        if (next)
          requestAnimationFrame(() =>
            document
              .getElementById(`photo-group-${next.groupKey}`)
              ?.scrollIntoView({ block: "start" }),
          );
      }
    } catch (error) {
      showErrorToast(error);
    }
  };
  const approveBatch = async () => {
    if (batchQueued) return;
    setBatchQueued(true);
    try {
      const groupKeys = selectedBatch.map((proposal) => proposal.groupKey);
      await flushEdits(groupKeys);
      const latest = queryClient.getQueryData<
        Awaited<ReturnType<typeof photoImport.review.call>>
      >(photoImport.review.queryKey({ runId }));
      const expectedRevisions = (latest?.review.proposals ?? [])
        .filter(
          (proposal) =>
            groupKeys.includes(proposal.groupKey) && !proposal.blockedReason,
        )
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
  const ready = proposed.filter((proposal) => !proposal.blockedReason);
  const selectedBatch = ready.filter((proposal) =>
    batchKeys.has(proposal.groupKey),
  );
  const groupByImage = new Map<string, string>();
  for (const proposal of review.proposals)
    for (const entry of [...proposal.images, ...proposal.skip]) {
      groupByImage.set(entry.id, proposal.groupKey);
    }
  // The save counter settles before Apply focuses a dirty field. Mutation
  // notifications can lag behind it and leave that field briefly disabled.
  const busy =
    (action.isPending && action.variables?.action !== "save") ||
    pendingEdits > 0;
  // Result links must wait for approval's passive detail-cache eviction.
  const approving = action.isPending && action.variables?.action === "approve";

  return (
    <Stack gap="lg">
      {results.length > 0 ? (
        <Section
          title="Import results"
          inert={approving}
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
                onMouseDown={(event) => event.preventDefault()}
                disabled={
                  selectedBatch.length === 0 ||
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
                inert={selected.state !== "proposed" && approving}
              >
                {selected.state === "proposed" ? (
                  <label className="flex min-h-11 items-center gap-2 border-t border-border px-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Select ${proposalName(selected)} for batch approval`}
                      checked={batchKeys.has(selected.groupKey)}
                      disabled={
                        busy || batchQueued || Boolean(selected.blockedReason)
                      }
                      title={selected.blockedReason ?? undefined}
                      onChange={(event) =>
                        setBatchKeys((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(selected.groupKey);
                          else next.delete(selected.groupKey);
                          return next;
                        })
                      }
                    />
                    {selected.blockedReason ?? "Select for batch"}
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
                  <Section
                    headingAs="h3"
                    className="min-w-0 border-t border-border pt-3"
                    disclosure={{}}
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
                        <Section
                          headingAs="h4"
                          disclosure={{}}
                          className="mt-4 border-t border-border pt-3"
                          title="Review possible matches"
                        >
                          <PhotoProductSuggestions
                            runId={runId}
                            proposal={selected}
                            settled
                          />
                        </Section>
                      )}
                  </Section>
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
