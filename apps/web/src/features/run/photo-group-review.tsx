import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type {
  ImageShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  parseShortcodeFor,
  productCategoryShortcode,
} from "@cubby/schemas/identifiers";
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
import {
  reviewPhotoGroupsOutput,
  photoRunReviewResponse,
  type PhotoRunDefaults,
} from "@cubby/schemas/photo-import-run";
import { brandNameKey } from "@cubby/schemas/vendor";
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
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

import { operationCommandRequest } from "~/contracts/define";
import { photoImportContract } from "~/contracts/photo-import.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ProductExternalIds } from "~/entity/components/product-external-ids";
import { entityFieldPresentation } from "~/entity/editing/entity-field-presentation";
import { entityDetailFor } from "~/entity/entity-detail";
import { PhotoGrid } from "~/entity/entity-media/photo-grid";
import { PhotoViewer } from "~/entity/entity-media/photo-viewer";
import { useWorkflowCommand } from "~/entity/hooks/use-workflow-command";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Picker } from "~/entity/picker/picker";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { useSelectedPickerItems } from "~/entity/picker/selected-items";
import { CategoryLabel } from "~/entity/presentation/category-label";
import { ShortcodeProse } from "~/entity/prose/shortcode-prose";
import { ProductVariantEvidence } from "~/features/product/product-variant-evidence";
import {
  RUN_TARGET_STATE_LABEL,
  RUN_TARGET_STATE_VARIANT,
} from "~/features/run/run-target-state";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { photoImport } from "~/integrations/tanstack-query/generated/catalog/photoImport.gen";
import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog/purchaseImport.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Panel, Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
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
import { StaticTable } from "~/ui/primitives/static-table";
import { StatusText } from "~/ui/primitives/status-text";
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
  PhotoReviewDraftSession,
  mergeGroups,
  moveImage,
  reviewOutcomeToasts,
  toGroupInput,
  type ProposalEdit,
} from "./photo-review-model";
import {
  PhotoReviewEmpty,
  PhotoReviewScopeControls,
  usePhotoReviewScope,
} from "./photo-review-scope";
import { loadPhotoRunCandidateChunks } from "./photo-run-candidates";

type ReviewSubmission = ReviewPhotoGroupsAction & { onSaved?: () => void };

function reviewRequest(runId: string, action: ReviewPhotoGroupsAction) {
  if (action.action === "save")
    return operationCommandRequest(photoImportContract, "saveGroups", {
      runId,
      groups: action.groups,
      removeGroupKeys: action.removeGroupKeys,
    });
  if (action.action === "approve")
    return operationCommandRequest(photoImportContract, "approveGroups", {
      runId,
      groupKeys: action.groupKeys,
      expectedRevisions: action.expectedRevisions,
    });
  return operationCommandRequest(photoImportContract, "discardGroup", {
    runId,
    groupKey: action.groupKey,
  });
}

function usePhotoRunCandidates(
  runId: string,
  proposals: readonly PhotoGroupProposal[],
) {
  const options = photoImport.candidatesBatch.queryOptions({ runId });
  return useQuery({
    meta: options.meta,
    ...photoImport.candidatesBatch.policy({ runId }).freshness,
    queryKey: [
      ...options.queryKey,
      proposals.map(({ groupKey, updatedAt }) => ({ groupKey, updatedAt })),
    ],
    queryFn: ({ signal }) =>
      loadPhotoRunCandidateChunks(
        proposals.map((proposal) => proposal.groupKey),
        (groupKeys) =>
          photoImport.candidatesBatch.call(
            { runId, groupKeys },
            { signal, batch: false },
          ),
      ),
    enabled: proposals.length > 0,
    staleTime: Infinity,
  });
}

const PhotoCandidatesContext = createContext<ReturnType<
  typeof usePhotoRunCandidates
> | null>(null);
function usePhotoCandidates() {
  const candidates = useContext(PhotoCandidatesContext);
  if (!candidates) throw new Error("Photo candidates require the Run review");
  return candidates;
}
const PhotoDraftContext = createContext<PhotoReviewDraftSession | null>(null);
const PhotoDraftGroup = createContext("");
function usePhotoDraft() {
  const session = useContext(PhotoDraftContext);
  if (!session) throw new Error("Photo edits require the Run draft session");
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { session, state };
}
const NO_PROPOSALS: readonly PhotoGroupProposal[] = [];
const PhotoProposalsContext = createContext(NO_PROPOSALS);

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
  const { mutateAsync: execute } = useWorkflowCommand({
    onResult: ({ result }) => {
      const data = reviewPhotoGroupsOutput.parse(result);
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
    },
  });
  return useMutation({
    // The outer scope includes snapshot patch, active refresh, inactive eviction and draft rebase.
    // Giving the nested operation this same scope would deadlock.
    scope: { id: `photo-run-review-${runId}` },
    mutationFn: async (action: ReviewSubmission) => {
      const { result } = await execute(reviewRequest(runId, action));
      return reviewPhotoGroupsOutput.parse(result);
    },
    onSuccess: (data, action) => {
      action.onSaved?.();
      for (const { tone, title, description } of reviewOutcomeToasts(data))
        toast[tone](title, description ? { description } : undefined);
    },
    onError: (error) => showErrorToast(error),
  });
}

/** Takes a builder so an edit that cannot be expressed (see `toGroupInput`) surfaces as a toast instead of an uncaught handler error. */
type Save = (
  build: () => ProposalEdit | Promise<ProposalEdit>,
  onSaved?: () => void,
) => Promise<boolean>;
type SaveGroup = (
  build: () => PhotoGroupProposalGroup | Promise<PhotoGroupProposalGroup>,
  onSaved?: () => void,
) => Promise<boolean>;
type ImagesById = ReadonlyMap<string, PhotoRunImage>;
const WithProductCategorySearch = referenceEntitySearch("productCategory");
const WithBrandSearch = referenceEntitySearch("vendor");

function PhotoBrandPicker({
  value,
  setValue,
  label,
  disabled,
}: {
  value: string | null | undefined;
  setValue: (item: ComboboxItem | null) => void;
  label: string;
  disabled: boolean;
}) {
  const [selected] = useSelectedPickerItems("vendor", value ? [value] : [], []);
  return (
    <WithBrandSearch>
      {(search) => (
        <Picker
          {...search}
          entity="vendor"
          label={label}
          placeholder="Choose a brand"
          clearable
          value={selected ?? null}
          setValue={setValue}
          disabled={disabled}
        />
      )}
    </WithBrandSearch>
  );
}

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
  const [viewing, setViewing] = useState<number | null>(null);
  const labelPhotos = proposal.images
    .filter((entry) => entry.purpose === "label")
    .map((entry) => imagesById.get(entry.id));
  const labelAnalysis = labelPhotos.some(
    (photo) => photo?.describe === "failed",
  )
    ? "Text analysis failed"
    : labelPhotos.some((photo) => photo?.describe === "skipped")
      ? "Text analysis skipped"
      : labelPhotos.some((photo) => photo?.describe !== "ready")
        ? "Text analysis incomplete"
        : "Unreadable";
  // A skipped photo keeps its reason on hover and stays dimmed.
  const entries = new Map<
    string,
    { purpose: "item" | "label" | null; reason?: string }
  >([
    ...proposal.images
      .slice()
      .sort(
        (a, b) => Number(b.purpose === "item") - Number(a.purpose === "item"),
      )
      .map((entry) => [entry.id, { purpose: entry.purpose }] as const),
    ...proposal.skip.map(
      (entry) => [entry.id, { purpose: null, reason: entry.reason }] as const,
    ),
  ]);
  const tiles = [...entries.keys()].flatMap((id) =>
    photoTile(imagesById.get(id)),
  );
  return (
    <div className="min-w-0 space-y-2">
      <PhotoGrid
        className="grid-cols-2 sm:grid-cols-3 md:grid-cols-3 [&>div:first-child]:col-span-2"
        images={tiles}
        tileClassName="max-sm:max-h-48"
        fit="contain"
        onSelect={(_image, index) => setViewing(index)}
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
                <div className="absolute top-1 right-1 z-20">
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
      <PhotoViewer
        images={tiles}
        index={viewing}
        onIndexChange={setViewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
        detailLink={(image) => ({ shortcode: image.id })}
      />
      {labelPhotos.length > 0 &&
      !labelPhotos.some((photo) => photo?.recognizedText?.trim()) ? (
        <p className="text-xs text-muted-foreground">
          Label photo · {labelAnalysis}
        </p>
      ) : null}
      {proposal.skip.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          title={proposal.skip.map((entry) => entry.reason).join(" · ")}
        >
          {countLabel(proposal.skip.length, "skipped photo")} ·{" "}
          {proposal.skip.map((entry) => entry.reason).join(" · ")}
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
                ) : photo.descriptionEvidence?.authority === "correction" ? (
                  <span className="font-medium text-foreground">
                    From your correction ·{" "}
                  </span>
                ) : null}
                <ClampedText>{description}</ClampedText>
              </div>
            ) : null}
            {photo.descriptionEvidence?.correction ? (
              <Disclosure summary="Correction evidence">
                <p>
                  Applied from your confirmed description for identical image
                  content.
                </p>
                <p>
                  Application receipt:{" "}
                  <code>
                    {
                      photo.descriptionEvidence.correction
                        .sourceApplicationFeedbackId
                    }
                  </code>
                </p>
              </Disclosure>
            ) : null}
            {claims.length ? (
              <Disclosure summary="Claims" meta={claims.length}>
                <ul className="space-y-0.5 text-muted-foreground">
                  {claims.map((claim) => (
                    <li key={`${claim.evidenceKind}-${claim.text}`}>
                      {claim.text}
                    </li>
                  ))}
                </ul>
              </Disclosure>
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
  required = false,
  className,
  options,
  optionsLoading,
  crossCheck,
  actions,
}: {
  label: string;
  value: string;
  onCommit: (next: string, onSaved: () => void) => void | Promise<boolean>;
  disabled: boolean;
  type?: "text" | "number";
  required?: boolean;
  className?: string;
  options?: readonly { value: string; count: number }[];
  optionsLoading?: boolean;
  crossCheck?: PhotoFieldCrossCheck;
  actions?: ReactNode;
}) {
  const optionsId = useId();
  const inputId = useId();
  const hintId = useId();
  const { session, state } = usePhotoDraft();
  const groupKey = useContext(PhotoDraftGroup);
  const draft = state.drafts.get(inputId)?.value ?? value;
  useEffect(
    () => session.acknowledge(inputId, value),
    [session, inputId, value],
  );
  useEffect(() => () => session.forget(inputId), [session, inputId]);
  const commit = () => {
    if (
      (type === "number" && !/^[1-9]\d*$/.test(draft.trim())) ||
      (required && !draft.trim())
    )
      return;
    const next = draft.trim();
    if (next === value.trim()) return;
    void onCommit(next, () =>
      flushSync(() => session.acknowledge(inputId, next)),
    );
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
          data-photo-unsaved={state.drafts.has(inputId) || undefined}
          aria-describedby={options ? hintId : undefined}
          list={options ? optionsId : undefined}
          type={type}
          min={type === "number" ? 1 : undefined}
          step={type === "number" ? 1 : undefined}
          aria-invalid={
            (type === "number" && !/^[1-9]\d*$/.test(draft)) ||
            (required && !draft.trim())
          }
          value={draft}
          disabled={disabled}
          onChange={(event) =>
            session.edit(inputId, groupKey, event.target.value, value)
          }
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
              ? "Checking existing brands…"
              : draft.trim()
                ? (() => {
                    const match = options.find(
                      (option) =>
                        option.value.toLocaleLowerCase() ===
                        draft.trim().toLocaleLowerCase(),
                    );
                    return match
                      ? `Existing name · used on ${countLabel(match.count, "product")}`
                      : "New brand · saved on this Product";
                  })()
                : "Choose an existing brand or enter one."}
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
  const { session, state } = usePhotoDraft();
  const replyId = useId();
  const reply = state.drafts.get(replyId)?.value ?? "";
  useEffect(() => () => session.forget(replyId), [session, replyId]);
  const resolve = useMutation({
    mutationFn: (
      input: Parameters<typeof photoImport.resolveConcern.call>[0],
    ) => photoImport.resolveConcern.call(input),
    onSuccess: async (_data, input) => {
      session.acknowledge(replyId, input.reply ?? "");
      void invalidateOperationTags(queryClient, ripple.runOnly);
    },
    onError: (error) => showErrorToast(error),
  });
  const concern = proposal.review?.unresolvedReason;
  useEffect(() => {
    if (
      !concern ||
      concern === "Confirm the observed identity before applying this group"
    )
      session.forget(replyId);
  }, [session, replyId, concern]);
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
          onChange={(event) =>
            session.edit(replyId, proposal.groupKey, event.target.value, "")
          }
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
}: {
  checks: readonly PhotoFieldCrossCheck[];
  product?: Pick<PhotoProductEvidence, "name" | "brandName" | "model">;
  unavailable: boolean;
  identifiers?: ReactNode;
}) {
  const evidenced = checks.filter(
    (check) =>
      Boolean(check.labelValue) || check.mark === "disagree-or-missing",
  );
  if (!evidenced.length) return null;
  const stored = (check: PhotoFieldCrossCheck) => {
    if (check.field === "identifiers") return identifiers;
    if (
      check.field === "brandName" ||
      check.field === "model" ||
      check.field === "name"
    )
      return product
        ? product[check.field]
        : unavailable
          ? "Current product unavailable"
          : "Loading current product…";
    return check.productValue;
  };
  return (
    <div className="space-y-1 text-xs" aria-label="Field cross-checks">
      <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)_1rem]">
        <span className="hidden sm:block" />
        <span className="hidden text-muted-foreground sm:block">
          Photo label
        </span>
        <span className="hidden text-muted-foreground sm:block">
          Current product
        </span>
        <span className="hidden sm:block" />
        {evidenced.map((check) => (
          <div
            key={check.field}
            className="grid grid-cols-1 gap-y-1 sm:contents"
            data-cross-check={check.field}
          >
            <span className="text-muted-foreground">
              {fieldLabel(check.field)}
            </span>
            <span className="break-words">
              <span className="mb-0.5 block text-2xs text-muted-foreground sm:hidden">
                Photo label
              </span>
              <span>{check.labelValue ?? "Not shown on label"}</span>
              {check.field === "identifiers" &&
              check.labelValue &&
              check.mark !== "agree" ? (
                <span className="block text-muted-foreground">
                  Printed code · type unverified
                </span>
              ) : null}
            </span>
            <span className="break-words">
              <span className="mb-0.5 block text-2xs text-muted-foreground sm:hidden">
                Current product
              </span>
              <span>
                {stored(check) || (
                  <span className="text-muted-foreground">Not recorded</span>
                )}
              </span>
              {check.field === "size" || check.field === "color" ? (
                <span className="block text-muted-foreground">
                  From product name
                </span>
              ) : null}
            </span>
            <div className="flex justify-end sm:justify-start">
              <FieldMark check={check} />
            </div>
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
          entity="purchase"
          id={line.purchaseId}
          name={
            line.purchaseLabel && line.purchaseLabel !== line.vendor
              ? line.purchaseLabel
              : "Order"
          }
        />
      ) : null}
      {line.vendorId && line.vendor ? (
        <EntityRefLink entity="vendor" id={line.vendorId} name={line.vendor} />
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
        <Disclosure summary="More purchases" meta={total - 1}>
          <div className="space-y-1">
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
        </Disclosure>
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

function useSelectedPhotoProduct(
  runId: string,
  product: PhotoGroupProposal["product"],
) {
  const input =
    product.kind === "existing" && product.existing
      ? { runId, productId: product.existing.id }
      : null;
  const options = input
    ? photoImport.productEvidence.queryOptions(input)
    : null;
  return useQuery({
    queryKey: options?.queryKey ?? [
      "photo-product-evidence",
      runId,
      "unselected",
    ],
    meta: options?.meta,
    ...(input ? photoImport.productEvidence.policy(input).freshness : {}),
    queryFn: input
      ? ({ signal }) => photoImport.productEvidence.call(input, { signal })
      : skipToken,
  });
}

function SelectedProductEvidence({
  product,
  showCover = false,
  identifiers,
}: {
  product: PhotoProductEvidence;
  showCover?: boolean;
  identifiers?: ReactNode;
}) {
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

              className="font-medium"
            />
            {product.brandName ? <p>{product.brandName}</p> : null}
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
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => Promise<boolean>;
  children: ReactNode;
  label?: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <Checkbox
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          void onChange(next);
        }}
      />
      {children}
    </label>
  );
}

const productReviewFields = (
  ["name", "brandId", "model", "notes", "tags"] as const
)
  .map((key) => ({
    key,
    presentation: entityFieldPresentation("product", key, "edit"),
  }))
  .filter(({ presentation }) => presentation.editable);
const productCategoryField = entityFieldPresentation(
  "product",
  "categoryId",
  "edit",
);

// A new Brand name and its empty reference describe one Product field change.
function photoProductChangeCount(
  changes: PhotoGroupDecision["productChanges"],
) {
  return new Set(
    Object.keys(changes ?? {}).map((field) =>
      field === "brandCreate" ? "brandId" : field,
    ),
  ).size;
}

function ExistingProductChanges({
  proposal,
  current,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  current: ReturnType<typeof useSelectedPhotoProduct>;
  save: SaveGroup;
  busy: boolean;
}) {
  const review = reviewDecision(proposal);
  const changes = review.productChanges ?? {};
  const [selectedBrand] = useSelectedPickerItems(
    "vendor",
    changes.brandId ? [changes.brandId] : [],
    [],
  );
  return (
    <section
      aria-label="Proposed Product changes"
      className="border-t border-border pt-2 text-xs"
    >
      <h4 className="mb-2 font-medium">
        Product changes ·{" "}
        {countLabel(photoProductChangeCount(changes), "selected field")}
      </h4>
      <p className="mb-2 text-muted-foreground">
        Only selected fields change when you attach the photos. Added text is
        green; removed text is red and struck through.
      </p>
      {current.isError ? (
        <StatusText tone="destructive">{current.error.message}</StatusText>
      ) : null}
      {current.data ? (
        <Stack gap="sm">
          {productReviewFields.map(({ key: field, presentation }) => {
            const before =
              field === "tags"
                ? (current.data?.tags.join(", ") ?? "")
                : field === "brandId"
                  ? (current.data?.brandName ?? "")
                  : (current.data?.[field] ?? "");
            const change = changes[field];
            const after =
              field === "brandId"
                ? (changes.brandCreate?.name ?? selectedBrand?.name ?? "")
                : Array.isArray(change)
                  ? change.join(", ")
                  : (change ?? "");
            return (
              <Stack key={field} gap="xs">
                <FieldChangeToggle
                  label={`Change ${presentation.label.toLocaleLowerCase()}`}
                  checked={Object.hasOwn(changes, field)}
                  disabled={busy}
                  onChange={(checked) =>
                    save(() => {
                      const next = { ...changes };
                      if (!checked) delete next[field];
                      else if (field === "tags")
                        next.tags = current.data?.tags ?? [];
                      else if (field === "brandId")
                        next.brandId = current.data?.brandId ?? null;
                      else next[field] = before;
                      return {
                        ...toGroupInput(proposal),
                        review: { ...review, productChanges: next },
                      };
                    })
                  }
                >
                  Change {presentation.label.toLocaleLowerCase()}
                  {!Object.hasOwn(changes, field) ? (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {field === "brandId"
                        ? (current.data?.brandName ?? "Not set")
                        : before || "Not set"}
                    </span>
                  ) : null}
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
                    {field === "brandId" ? (
                      <PhotoBrandControl
                        proposal={proposal}
                        label="New brand"
                        value={changes.brandId}
                        save={save}
                        busy={busy}
                      />
                    ) : (
                      <CommitInput
                        label={`New ${presentation.label.toLocaleLowerCase()}`}
                        required={
                          entityFieldByKey("product", field)?.requiredOnCreate
                        }
                        value={after}
                        disabled={busy}
                        onCommit={(value, onSaved) =>
                          save(
                            () => ({
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
                                      : value || (field === "name" ? "" : null),
                                },
                              },
                            }),
                            onSaved,
                          )
                        }
                      />
                    )}
                  </>
                ) : null}
              </Stack>
            );
          })}
          {productCategoryField.editable ? (
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
              Change {productCategoryField.label.toLocaleLowerCase()}
              {!Object.hasOwn(changes, "categoryId") ? (
                <CategoryLabel category={current.data.category ?? null} />
              ) : null}
            </FieldChangeToggle>
          ) : null}
          {Object.hasOwn(changes, "categoryId") ? (
            <>
              <p className="flex flex-wrap items-center gap-1">
                Before:{" "}
                <CategoryLabel category={current.data.category ?? null} />
              </p>
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
      ) : !current.isError ? (
        <p>Loading current Product…</p>
      ) : null}
    </section>
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

type PhotoBrandChoice = Extract<
  PhotoGroupProposalGroup["product"],
  { kind: "create" }
>["create"];

function withPhotoBrand(
  proposal: PhotoGroupProposal,
  choice: Pick<PhotoBrandChoice, "brandId" | "brandCreate">,
): PhotoGroupProposalGroup {
  const group = toGroupInput(proposal);
  if (group.product.kind === "create") {
    const {
      brandCreate: _previousCreate,
      brandId: _previousId,
      ...create
    } = group.product.create;
    return {
      ...group,
      product: { kind: "create", create: { ...create, ...choice } },
    };
  }
  const review = reviewDecision(proposal);
  const {
    brandCreate: _previousCreate,
    brandId: _previousId,
    ...changes
  } = review.productChanges ?? {};
  return {
    ...group,
    review: { ...review, productChanges: { ...changes, ...choice } },
  };
}

function PhotoBrandEvidence({
  proposal,
  save,
  busy,
  onShowEvidence,
}: {
  proposal: PhotoGroupProposal;
  save: Save;
  busy: boolean;
  onShowEvidence?: () => void;
}) {
  const proposals = useContext(PhotoProposalsContext);
  const rejected = new Set(
    (proposal.review?.rejectedBrandNames ?? []).map(brandNameKey),
  );
  const evidence = (proposal.brandEvidence ?? []).filter(
    (item) => !rejected.has(brandNameKey(item.name)),
  );
  const chosen =
    proposal.product.kind === "create"
      ? proposal.product.create
      : proposal.review?.productChanges;
  return (
    <section aria-label="Brand evidence" className="space-y-2 text-xs">
      {chosen?.brandCreate ? (
        <p className="font-medium">
          On approval: create brand “{chosen.brandCreate.name}”
        </p>
      ) : null}
      {evidence.map((item) => {
        const [onlyMatch] = item.matches;
        const choice =
          item.matches.length === 1 && onlyMatch
            ? { brandId: onlyMatch.id }
            : item.matches.length === 0
              ? { brandCreate: { name: item.name } }
              : null;
        const matching = proposals.filter(
          (other) =>
            other.state === "proposed" &&
            !other.blockedReason &&
            other.brandEvidence?.length === 1 &&
            other.product.kind === "create" &&
            !other.product.create.brandId &&
            !other.product.create.brandCreate &&
            !(other.review?.rejectedBrandNames ?? []).some(
              (name) => brandNameKey(name) === brandNameKey(item.name),
            ) &&
            other.brandEvidence?.some(
              (entry) =>
                brandNameKey(entry.name) === brandNameKey(item.name) &&
                entry.matches.length < 2 &&
                (choice?.brandId
                  ? entry.matches[0]?.id === choice.brandId
                  : entry.matches.length === 0),
            ),
        );
        const selected =
          chosen?.brandCreate?.name === item.name ||
          (item.matches.length === 1 &&
            chosen?.brandId === item.matches[0]?.id);
        return (
          <div
            key={item.name}
            className="space-y-1 border-b border-border pb-2 last:border-b-0"
          >
            <Row wrap gap="sm">
              <span>
                Brand: <strong>{item.name}</strong>
              </span>
              <Button size="sm" variant="ghost" onClick={onShowEvidence}>
                Read from {countLabel(item.imageIds.length, "photo")}
              </Button>
              {selected ? (
                <span className="text-muted-foreground">
                  In proposal · applies on approval
                </span>
              ) : choice ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void save(() => ({
                      groups: [withPhotoBrand(proposal, choice)],
                      removeGroupKeys: [],
                    }))
                  }
                >
                  {choice.brandId ? "Use brand" : "Propose new brand"}
                </Button>
              ) : (
                item.matches.map((match) => (
                  <Button
                    key={match.id}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void save(() => ({
                        groups: [
                          withPhotoBrand(proposal, { brandId: match.id }),
                        ],
                        removeGroupKeys: [],
                      }))
                    }
                  >
                    Use {match.name}
                  </Button>
                ))
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void save(() => {
                    const group = selected
                      ? withPhotoBrand(proposal, {})
                      : toGroupInput(proposal);
                    return {
                      groups: [
                        {
                          ...group,
                          review: {
                            ...(group.review ?? reviewDecision(proposal)),
                            rejectedBrandNames: [
                              ...(proposal.review?.rejectedBrandNames ?? []),
                              item.name,
                            ],
                          },
                        },
                      ],
                      removeGroupKeys: [],
                    };
                  })
                }
              >
                Reject brand proposal
              </Button>
            </Row>
            {choice && matching.length > 1 ? (
              <Disclosure
                summary={`Use ${item.name} for ${matching.length} matching items`}
              >
                <p className="mb-2 text-muted-foreground">
                  Only new Products with matching photo evidence and no selected
                  brand. Existing choices stay unchanged.
                </p>
                <RecordList aria-label="Matching brand proposals">
                  {matching.map((other) => (
                    <RecordRow
                      key={other.groupKey}
                      primary={proposalName(other)}
                    />
                  ))}
                </RecordList>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void save(() => ({
                      groups: matching.map((other) =>
                        withPhotoBrand(other, choice),
                      ),
                      removeGroupKeys: [],
                    }))
                  }
                >
                  Update {matching.length} proposals
                </Button>
              </Disclosure>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function PhotoBrandControl({
  proposal,
  value,
  label,
  save,
  busy,
}: {
  proposal: PhotoGroupProposal;
  value: string | null | undefined;
  label: string;
  save: SaveGroup;
  busy: boolean;
}) {
  const chosen =
    proposal.product.kind === "create"
      ? proposal.product.create
      : proposal.review?.productChanges;
  return (
    <Stack gap="xs">
      <span className="text-muted-foreground">{label}</span>
      <PhotoBrandPicker
        label={label}
        value={value}
        disabled={busy}
        setValue={(item) =>
          void save(() =>
            withPhotoBrand(proposal, {
              brandId: item ? parseShortcodeFor("vendor", item.id) : null,
            }),
          )
        }
      />
      <Disclosure summary="Brand not listed?" keepMounted>
        <CommitInput
          label="New brand name"
          value={chosen?.brandCreate?.name ?? ""}
          disabled={busy}
          onCommit={(name, onSaved) =>
            save(
              () =>
                withPhotoBrand(
                  proposal,
                  name ? { brandId: null, brandCreate: { name } } : {},
                ),
              onSaved,
            )
          }
        />
        <p className="mt-1 text-muted-foreground">
          Propose a brand now; create it only when you approve this item. An
          exact existing name is reused.
        </p>
      </Disclosure>
    </Stack>
  );
}

function ProductPanel({
  runId,
  proposal,
  currentProduct,
  save,
  busy,
  step,
  runLocation,
  labelText,
  onShowEvidence,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  currentProduct: ReturnType<typeof useSelectedPhotoProduct>;
  save: Save;
  busy: boolean;
  step: string;
  runLocation: RunLocation | null;
  labelText: string;
  onShowEvidence?: () => void;
}) {
  const saveGroup: SaveGroup = (build, onSaved) =>
    save(
      async () => ({ groups: [await build()], removeGroupKeys: [] }),
      onSaved,
    );
  const product = proposal.product;
  const batch = usePhotoCandidates();
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
  const queryClient = useQueryClient();
  const saveProduct = (
    next: PhotoGroupProposalGroup["product"],
    onSaved?: () => void,
  ) => {
    return saveGroup(() => selectPhotoProduct(proposal, next), onSaved);
  };
  const renderCreateField = (field: "brandId" | "model" | "notes" | "tags") => {
    if (product.kind !== "create") return null;
    if (field === "brandId")
      return (
        <PhotoBrandControl
          proposal={proposal}
          label="Brand"
          value={product.create.brandId}
          save={saveGroup}
          busy={busy}
        />
      );
    const presentation = entityFieldPresentation("product", field, "create");
    if (!presentation.editable) return null;
    const value = product.create[field];
    return (
      <CommitInput
        label={
          field === "notes"
            ? "Product notes"
            : field === "tags"
              ? "Tags (comma separated)"
              : presentation.label
        }
        value={Array.isArray(value) ? value.join(", ") : (value ?? "")}
        crossCheck={
          field === "model"
            ? checks.find((check) => check.field === field)
            : undefined
        }
        className={field === "model" ? "flex-1" : undefined}
        disabled={busy}
        onCommit={(next, onSaved) =>
          saveProduct(
            {
              kind: "create",
              create: {
                ...product.create,
                [field]:
                  field === "tags"
                    ? next
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    : next || null,
              },
            },
            onSaved,
          )
        }
      />
    );
  };
  const productIdentifiers = currentProduct.data ? (
    currentProduct.data.externalIds.length ? (
      <ProductExternalIds identifiers={currentProduct.data.externalIds} />
    ) : (
      "Not recorded"
    )
  ) : currentProduct.isError ? (
    "Current product unavailable"
  ) : (
    "Loading identifier types…"
  );
  const attachExisting = (existingId: ProductShortcode) =>
    saveProduct({ kind: "existing", existingId });
  const reject = useMutation({
    mutationFn: (
      input: Parameters<typeof photoImport.rejectCandidate.call>[0],
    ) => photoImport.rejectCandidate.call(input),
    onSuccess: async () => {
      await saveProduct({
        kind: "create",
        create: {
          name: proposal.review?.observedName ?? proposalName(proposal),
        },
      });
      void invalidateOperationTags(queryClient, ripple.runOnly);
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
    return (
      <InventoryFields
        proposal={proposal}
        save={saveGroup}
        busy={busy}
        runLocation={runLocation}
      />
    );
  return (
    <Stack gap="sm" className="min-w-0">
      <IdentityDecision runId={runId} proposal={proposal} busy={busy} />
      <PhotoBrandEvidence
        proposal={proposal}
        save={save}
        busy={busy}
        onShowEvidence={onShowEvidence}
      />
      {product.kind === "existing" &&
      !labelText.trim() &&
      !proposal.review?.unresolvedReason ? (
        <p className="text-xs text-muted-foreground">
          No label text — compare the photo with the product
        </p>
      ) : null}
      {product.kind === "create" ? (
        <>
          <Stack gap="sm">
            <CommitInput
              label="New product name"
              required={entityFieldByKey("product", "name")?.requiredOnCreate}
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
              onCommit={(name, onSaved) =>
                saveProduct(
                  {
                    kind: "create",
                    create: { ...product.create, name },
                  },
                  onSaved,
                )
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
              {renderCreateField("brandId")}
              {renderCreateField("model")}
            </Stack>
          </Stack>
          <Disclosure summary="Notes and tags" className="text-xs" keepMounted>
            <Stack gap="xs">
              {renderCreateField("notes")}
              {renderCreateField("tags")}
            </Stack>
          </Disclosure>
        </>
      ) : (
        <>
          <FieldCrossChecks
            checks={checks}
            product={currentProduct.data}
            unavailable={currentProduct.isError}
            identifiers={productIdentifiers}
          />
          {currentProduct.isError ? (
            <StatusText tone="destructive">
              {currentProduct.error.message}
            </StatusText>
          ) : null}
          {product.existing ? (
            currentProduct.data ? (
              <SelectedProductEvidence
                product={currentProduct.data}
                showCover={!labelText.trim()}
                identifiers={
                  currentProduct.data?.externalIds.length &&
                  !checks.some(
                    (check) =>
                      check.field === "identifiers" && check.labelValue,
                  )
                    ? productIdentifiers
                    : null
                }
              />
            ) : !currentProduct.isError ? (
              <p className="text-xs text-muted-foreground">
                Loading Product evidence…
              </p>
            ) : null
          ) : (
            <StatusText tone="warning">Choose a live Product.</StatusText>
          )}
          <Row gap="sm" wrap>
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
            current={currentProduct}
            save={saveGroup}
            busy={busy}
          />
        </>
      )}
      {proposal.evidence ? (
        <Disclosure summary="Why the agent proposed this" className="text-xs">
          <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {proposal.evidence}
          </p>
        </Disclosure>
      ) : null}
    </Stack>
  );
}

function PhotoProductSuggestions({
  proposal,
  onPick,
  busy,
  settled = false,
}: {
  proposal: PhotoGroupProposal;
  onPick?: (id: ProductShortcode) => void;
  busy?: boolean;
  settled?: boolean;
}) {
  const suggestions = usePhotoCandidates();
  const group = suggestions.data?.groups.find(
    (item) => item.groupKey === proposal.groupKey,
  );
  const closest = group?.candidates[0];
  const strongDuplicate =
    proposal.product.kind === "create" &&
    closest?.duplicateStrength === "strong";
  const [open, setOpen] = useState(false);
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
                  <ProductVariantEvidence
                    comparison={candidate.match.variant}
                    firstLabel="Photo"
                    secondLabel="Product"
                  />
                  <Facts
                    layout="inline"
                    className="text-xs"
                    facts={[
                      {
                        label: "Recorded count",
                        value: candidate.quantity?.onHandUnits ?? "Not counted",
                      },
                      {
                        label: "Expected",
                        value:
                          candidate.quantity?.quantityLedger.expectedQuantity ??
                          "Unknown",
                      },
                    ]}
                  />
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

type RunLocation = {
  id: NonNullable<NonNullable<PhotoGroupProposal["inventory"]>["locationId"]>;
  name: string;
};

/** The Location most of this run's groups receive into, so switching a
 * reference-only group to "add to inventory" lands where its siblings did. */
function usualRunLocation(
  proposals: readonly PhotoGroupProposal[],
): RunLocation | null {
  const counts = new Map<RunLocation["id"], RunLocation & { count: number }>();
  for (const { inventory } of proposals) {
    if (!inventory?.locationId || !inventory.locationName) continue;
    const seen = counts.get(inventory.locationId);
    counts.set(inventory.locationId, {
      id: inventory.locationId,
      name: inventory.locationName,
      count: (seen?.count ?? 0) + 1,
    });
  }
  const [usual] = [...counts.values()].sort((a, b) => b.count - a.count);
  return usual ? { id: usual.id, name: usual.name } : null;
}

function InventoryFields({
  proposal,
  save,
  busy,
  runLocation,
}: {
  proposal: PhotoGroupProposal;
  save: SaveGroup;
  busy: boolean;
  runLocation: RunLocation | null;
}) {
  const inventory = proposal.inventory;
  const quantity = inventory?.quantity ?? 1;
  const { session, state } = usePhotoDraft();
  const entryErrorId = useId();
  const entryError = state.drafts.get(entryErrorId)?.value;
  const existingEntry = useQuery(
    entityDetailFor("inventory").queryOptions(
      inventory?.existingEntryId ?? "",
      { enabled: Boolean(inventory?.existingEntryId) },
    ),
  );
  const destination =
    proposal.product.kind === "existing" ? proposal.product.existing?.id : null;
  useEffect(
    () => session.forget(entryErrorId),
    [session, entryErrorId, destination],
  );
  useEffect(() => () => session.forget(entryErrorId), [session, entryErrorId]);
  const saveStock: SaveGroup = (build) =>
    save(build).then((success) => {
      if (success) session.forget(entryErrorId);
      return success;
    });
  const review = reviewDecision(proposal);
  const changeIntent = (stockIntent: PhotoGroupDecision["stockIntent"]) =>
    saveStock(() => ({
      ...toGroupInput(proposal, {
        inventory:
          stockIntent !== "receive"
            ? undefined
            : (toGroupInput(proposal).inventory ??
              (runLocation
                ? {
                    locationId: runLocation.id,
                    quantity: 1,
                    mode: "create",
                  }
                : undefined)),
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
        Inventory
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
                onCommit={(next, onSaved) => {
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
                    }, onSaved);
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
              disabled={busy}
              placeholder="Or choose an existing entry to add to"
              setValue={(item) => {
                if (!item) return;
                session.forget(entryErrorId);
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
                  if (!success)
                    session.edit(
                      entryErrorId,
                      proposal.groupKey,
                      "Retry the stock-entry selection before applying",
                      "",
                    );
                });
              }}
            />
          ) : null}
          {entryError ? (
            <StatusText
              id={entryErrorId}
              tabIndex={-1}
              tone="destructive"
              data-photo-unsaved="true"
            >
              {entryError}
            </StatusText>
          ) : null}
          {inventory?.locationId && (inventory.mode === "add" || entryError) ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
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
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const currentProduct = useSelectedPhotoProduct(runId, proposal.product);
  const { state } = usePhotoDraft();
  const approving = state.approving !== null;
  const mergeTargets = proposals.filter(
    (other) =>
      other.state === "proposed" && other.groupKey !== proposal.groupKey,
  );
  // Photos deleted or settled outside this review (e.g. a direct commit) make
  // the group unapprovable and undiscardable; removing it is the way out.
  const stale = isStaleGroup(proposal, imagesById, runStatus);
  const descriptionsPending = awaitingDescriptions(proposal, imagesById);
  const runLocation = usualRunLocation(proposals);
  return (
    <Section
      data-photo-group={proposal.groupKey}
      className="max-sm:[&>[data-slot=section-heading]>div:first-child]:basis-full"
      headingAs="h3"
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">{proposalName(proposal)}</span>
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
        </span>
      }
      actions={
        <Row align="center" gap="xs" wrap className="w-full sm:w-auto">
          {mergeTargets.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy}
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
              disabled={busy}
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
            disabled={busy || stale}
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
      }
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !busy &&
          !approving &&
          !proposal.blockedReason &&
          !stale
        ) {
          event.preventDefault();
          void approve(proposal.groupKey);
        }
      }}
    >
      <div className="@container/photo-editor">
        <PhotoProductSuggestions
          proposal={proposal}
          busy={busy}
          onPick={(existingId) => {
            void save(() => ({
              groups: [
                selectPhotoProduct(proposal, { kind: "existing", existingId }),
              ],
              removeGroupKeys: [],
            }));
          }}
        />
        <div className="grid min-w-0 gap-4 @xl/photo-editor:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <GroupPhotos
              proposal={proposal}
              proposals={proposals}
              imagesById={imagesById}
              save={save}
              editable
              busy={busy}
            />
            <div id={`photo-evidence-${proposal.groupKey}`}>
              <Disclosure
                summary="Photo evidence and label text"
                open={evidenceOpen}
                onOpenChange={setEvidenceOpen}
                keepMounted
              >
                <GroupEvidence proposal={proposal} imagesById={imagesById} />
              </Disclosure>
            </div>
          </div>
          <div className="min-w-0 space-y-4">
            <Disclosure summary="Choose a different Product" keepMounted>
              <ProductPanel
                runId={runId}
                proposal={proposal}
                currentProduct={currentProduct}
                save={save}
                busy={busy}
                step="product"
                runLocation={runLocation}
                labelText=""
              />
            </Disclosure>
            <section aria-label="Product details" className="min-w-0">
              <ProductPanel
                runId={runId}
                proposal={proposal}
                currentProduct={currentProduct}
                save={save}
                busy={busy}
                step="identity"
                onShowEvidence={() => {
                  setEvidenceOpen(true);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`photo-evidence-${proposal.groupKey}`)
                      ?.scrollIntoView({ block: "nearest" }),
                  );
                }}
                runLocation={runLocation}
                labelText={proposal.images
                  .map((entry) => imagesById.get(entry.id)?.recognizedText)
                  .filter(Boolean)
                  .join("\n")}
              />
            </section>
            <section
              aria-label="Inventory decision"
              className="border-t border-border pt-3"
            >
              <ProductPanel
                runId={runId}
                proposal={proposal}
                currentProduct={currentProduct}
                save={save}
                busy={busy}
                step="ownership"
                runLocation={runLocation}
                labelText=""
              />
            </section>
          </div>
        </div>
        {proposal.review?.stockIntent === "receive" &&
        currentProduct.data?.inventoryEntries?.length ? (
          <div className="mt-3 space-y-2 text-xs">
            <p>
              Stock is already recorded for this Product. If these photos show
              that same item, attach them without adding another unit.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void save(() => ({
                  groups: [
                    {
                      ...toGroupInput(proposal, { inventory: undefined }),
                      review: {
                        ...reviewDecision(proposal),
                        stockIntent: "counted",
                      },
                    },
                  ],
                  removeGroupKeys: [],
                }))
              }
            >
              Already counted · attach photos
            </Button>
          </div>
        ) : null}
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
            disabled={busy}
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
                {photoProductChangeCount(proposal.review?.productChanges) ? (
                  `${countLabel(photoProductChangeCount(proposal.review?.productChanges), "product change")} selected`
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
              approving ||
              (action.isPending && action.variables?.action !== "save") ||
              stale ||
              descriptionsPending.length > 0 ||
              Boolean(proposal.blockedReason)
            }
            onClick={() => void approve(proposal.groupKey)}
          >
            <CheckIcon />
            {proposal.product.kind === "create"
              ? proposal.inventory
                ? `Create product and add ${proposal.inventory.quantity}`
                : "Create product and attach photos"
              : proposal.inventory
                ? `${photoProductChangeCount(proposal.review?.productChanges) ? "Update product" : "Attach photos"} and add ${proposal.inventory.quantity}`
                : `Apply and attach ${countLabel(proposal.images.length, "photo")}`}
            <kbd aria-hidden="true" className="text-xs opacity-70">
              Ctrl/⌘ Enter
            </kbd>
          </Button>
        </div>
      </div>
    </Section>
  );
}

const PROCESSING_LABEL = {
  pending: "Queued",
  waiting_for_device: "Waiting for Apple device",
  leased: "Processing",
  ready: "Done",
  skipped: "Skipped",
  failed: "Needs attention (retrying)",
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
    <Section
      headingAs="h2"
      aria-label="Run photos"
      title="Photos"
      count={images.length}
    >
      {/* Bounded region: a 1,000-photo run scrolls here, not the page. */}
      <Panel tone="default" flush className="max-h-[70vh] overflow-auto">
        <StaticTable
          rows={images}
          rowKey={(photo) => photo.id}
          headClassName="sticky top-0 z-10 bg-card"
          columns={[
            {
              id: "column-0",
              header: "#",
              headClassName: "w-10",
              cellClassName:
                "font-mono text-2xs text-muted-foreground tabular-nums",
              cell: (photo) => photo.position ?? "—",
            },
            {
              id: "column-1",
              header: "Original",
              cell: (photo) => (
                <a
                  href={`/images/${encodeURIComponent(photo.id)}`}
                  aria-label={`Open photo ${photo.id}`}
                >
                  <PhotoThumb image={photo} size={48} />
                </a>
              ),
            },
            {
              id: "column-2",
              header: "Cutout",
              cell: (photo) =>
                photo.cutoutUrl ? (
                  <Image
                    src={photo.cutoutUrl}
                    alt={`Cutout of ${photo.id}`}
                    displayWidth={48}
                    className="size-12 rounded-md border border-border bg-muted object-contain"
                  />
                ) : (
                  <span className="text-2xs text-muted-foreground">None</span>
                ),
            },
            {
              id: "column-3",
              header: "Import",
              cell: (photo) => (
                <Stack gap="tight">
                  <Badge variant={RUN_TARGET_STATE_VARIANT[photo.targetState]}>
                    {RUN_TARGET_STATE_LABEL[photo.targetState]}
                  </Badge>
                  {groupByImage.get(photo.id) ? (
                    <span className="max-w-40 truncate font-mono text-2xs text-muted-foreground">
                      {groupByImage.get(photo.id)}
                    </span>
                  ) : null}
                </Stack>
              ),
            },
            {
              id: "column-4",
              header: "Analysis",
              cell: (photo) => (
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
                      <CheckCircleIcon className="size-3" aria-hidden="true" />
                    ) : (
                      <ClockIcon className="size-3" aria-hidden="true" />
                    )}
                    Device: {photo.localAnalysisReady ? "Done" : "Not received"}
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
                  {photo.cloudDescriptionMissing ? (
                    <span className="max-w-56 text-2xs text-muted-foreground">
                      Apple description only; cloud description waiting
                    </span>
                  ) : null}
                  {photo.describeReason ? (
                    <span className="max-w-56 text-2xs break-words text-destructive">
                      {photo.describeReason}
                    </span>
                  ) : null}
                </Stack>
              ),
            },
            {
              id: "column-5",
              header: "Description",
              cellClassName: "max-w-96 whitespace-normal",
              cell: (photo) => {
                const snippet =
                  photo.description ??
                  photo.recognizedText?.split("\n")[0] ??
                  null;
                return snippet ? (
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
                );
              },
            },
          ]}
        />
      </Panel>
    </Section>
  );
}

const STOCK_OUTCOME = {
  evidence: "Reference photo only · no stock change",
  counted: "Already counted · no stock change",
  historical: "Historical or sold · no stock change",
  receive: "No stock received",
} satisfies Record<PhotoGroupDecision["stockIntent"], string>;

function SettledGroup({
  runId,
  proposal,
  imagesById,
}: {
  runId: string;
  proposal: PhotoGroupProposal;
  imagesById: ImagesById;
}) {
  const committed = proposal.state === "committed";
  return (
    <Stack gap="sm" className="mt-2">
      <Row gap="sm" align="start" className="min-w-0">
        {proposal.images.length ? (
          <Row gap="xs" className="shrink-0">
            {proposal.images.map((entry) => (
              <PhotoThumb
                key={entry.id}
                image={imagesById.get(entry.id)}
                size={48}
                dimmed={!committed}
              />
            ))}
          </Row>
        ) : null}
        <Stack gap="xs" className="min-w-0 text-xs">
          {proposal.committedProduct ? (
            <span className="text-sm">
              <EntityRefLink
                entity="product"
                data={{
                  id: proposal.committedProduct.id,
                  name: proposal.committedProduct.name,
                }}
              />
            </span>
          ) : null}
          {proposal.committedInventoryId ? (
            <span>
              Received {proposal.inventory?.quantity ?? 0} at{" "}
              <EntityRefLink
                entity="inventory"
                data={{
                  id: proposal.committedInventoryId,
                  name:
                    proposal.inventory?.locationName ||
                    proposal.committedInventoryId,
                }}
              />
            </span>
          ) : (
            <span className="text-muted-foreground">
              {committed
                ? STOCK_OUTCOME[reviewDecision(proposal).stockIntent]
                : "Nothing written"}
            </span>
          )}
        </Stack>
      </Row>
      {committed && proposal.review?.fieldSuggestions?.length ? (
        <Disclosure
          summary={`Applied field reviews · ${proposal.review.fieldSuggestions.length}`}
        >
          <RecordList aria-label="Applied field reviews">
            {proposal.review.fieldSuggestions.map((suggestion) => (
              <RecordRow
                key={suggestion.id}
                primary={
                  productReviewFields.find(
                    (field) => field.key === suggestion.field,
                  )?.presentation.label ??
                  (suggestion.field === "categoryId"
                    ? productCategoryField.label
                    : suggestion.field)
                }
                secondary="Applied with this item approval · saved changes are in Product activity"
                trailing={
                  <Disclosure summary="Review provenance">
                    <code className="text-2xs break-all">{suggestion.id}</code>
                  </Disclosure>
                }
              />
            ))}
          </RecordList>
        </Disclosure>
      ) : null}
      {committed ? (
        <Section
          headingAs="h4"
          disclosure={{}}
          className="border-t border-border pt-2"
          title="Link a purchase line"
        >
          <ExpenseLinkReview runId={runId} proposal={proposal} />
        </Section>
      ) : null}
      {committed && proposal.product.kind === "create" ? (
        <Section
          headingAs="h4"
          disclosure={{}}
          className="border-t border-border pt-2"
          title="Review possible matches"
        >
          <PhotoProductSuggestions proposal={proposal} settled />
        </Section>
      ) : null}
    </Stack>
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
    <section aria-label="Unlinked purchase lines">
      <p className="text-2xs text-muted-foreground">
        Attach an existing Expense to this Product · cost and quantity stay
        unchanged
      </p>
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
                  Needs an accepted order line
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

/** Keep visited panes mounted so switching items preserves drafts and focus targets. */
function DeferredPhotoGroup({
  eager,
  children,
}: {
  eager: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(eager);
  useEffect(() => {
    if (eager) setVisited(true);
  }, [eager]);
  return eager || visited ? children : null;
}

function PhotoRunDestination({
  defaults,
  disabled,
  onChange,
}: {
  defaults?: PhotoRunDefaults | null;
  disabled: boolean;
  onChange: (defaults: PhotoRunDefaults) => void;
}) {
  defaults ??= { stockIntent: "receive", locationId: null };
  const current = defaults;
  const [selected] = useSelectedPickerItems(
    "location",
    current.locationId ? [current.locationId] : [],
    [],
  );
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {defaults.stockIntent === "receive"
            ? "Owned items"
            : defaults.stockIntent === "historical"
              ? "Historical photos"
              : "Reference photos"}
        </p>
        <p className="text-xs text-muted-foreground">
          {defaults.stockIntent === "receive"
            ? "Choose a storage location once. Item-specific choices stay unchanged."
            : "Photos attach without adding stock. Change Inventory on an item to make an exception."}
        </p>
      </div>
      {defaults.stockIntent === "receive" ? (
        <div className="w-full sm:w-64">
          <EntityReferencePicker
            entity="location"
            label="Default storage location"
            value={
              selected
                ? {
                    ...selected,
                    id: parseShortcodeFor("location", selected.id),
                  }
                : null
            }
            disabled={disabled}
            placeholder="Choose storage location"
            setValue={(item) =>
              onChange({
                ...current,
                locationId: item
                  ? parseShortcodeFor("location", item.id)
                  : null,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function photoItemStatus(
  item: PhotoGroupProposal,
  imagesById: ImagesById,
  runStatus: string,
) {
  if (item.state !== "proposed")
    return item.state === "committed" ? "Applied" : "Discarded";
  if (item.blockedReason) return item.blockedReason;
  if (isStaleGroup(item, imagesById, runStatus))
    return "Photos changed · review this group";
  if (awaitingDescriptions(item, imagesById).length)
    return "Waiting for photo descriptions";
  return `${item.product.kind === "create" ? "New Product" : "Existing Product"} · Ready to approve`;
}

function PhotoItemList({
  items,
  activeGroupKey,
  setActiveGroupKey,
  imagesById,
  selected,
  onSelectionChange,
  busy,
  runStatus,
}: {
  items: readonly PhotoGroupProposal[];
  activeGroupKey?: string;
  setActiveGroupKey: (key: string) => void;
  imagesById: ImagesById;
  selected: ReadonlySet<string>;
  onSelectionChange: (keys: Iterable<string>) => void;
  busy: boolean;
  runStatus: string;
}) {
  const isMobile = useIsMobile();
  return (
    <nav
      aria-label="Items to review"
      className="max-h-[60vh] overflow-auto border-y border-border lg:sticky lg:top-4"
    >
      {items.map((item) => (
        <div
          key={item.groupKey}
          className="flex items-start gap-2 border-b border-border last:border-b-0"
        >
          {item.state === "proposed" ? (
            <label
              htmlFor={`photo-select-${item.groupKey}`}
              className="flex w-7 shrink-0 items-center justify-center self-stretch max-md:min-h-11 max-md:w-11"
            >
              <Checkbox
                id={`photo-select-${item.groupKey}`}
                aria-label={`Select ${proposalName(item)} for batch approval`}
                checked={selected.has(item.groupKey)}
                disabled={busy || Boolean(item.blockedReason)}
                onCheckedChange={(checked) =>
                  onSelectionChange(
                    checked
                      ? [...selected, item.groupKey]
                      : [...selected].filter((key) => key !== item.groupKey),
                  )
                }
              />
            </label>
          ) : null}
          <button
            type="button"
            id={`photo-item-${item.groupKey}`}
            aria-current={activeGroupKey === item.groupKey ? "true" : undefined}
            aria-controls={`photo-group-${item.groupKey}`}
            className="flex min-h-11 min-w-0 flex-1 gap-2 p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-current:bg-muted"
            onKeyDown={(event) => {
              if (!(event.target instanceof HTMLButtonElement)) return;
              const index = items.findIndex(
                (item) => item.groupKey === activeGroupKey,
              );
              const delta =
                event.key === "ArrowDown" || event.key === "j"
                  ? 1
                  : event.key === "ArrowUp" || event.key === "k"
                    ? -1
                    : 0;
              if (!delta) return;
              event.preventDefault();
              const next =
                items[Math.max(0, Math.min(items.length - 1, index + delta))];
              if (next) {
                setActiveGroupKey(next.groupKey);
                document.getElementById(`photo-item-${next.groupKey}`)?.focus();
              }
            }}
            onClick={() => {
              setActiveGroupKey(item.groupKey);
              if (isMobile)
                requestAnimationFrame(() =>
                  document
                    .getElementById(`photo-group-${item.groupKey}`)
                    ?.scrollIntoView({ block: "start" }),
                );
            }}
          >
            <PhotoThumb
              image={imagesById.get(
                item.images.find((image) => image.purpose === "item")?.id ??
                  item.images[0]?.id ??
                  "",
              )}
              size={40}
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-sm font-medium break-words">
                {proposalName(item)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {photoItemStatus(item, imagesById, runStatus)}
              </span>
              {item.inventory ? (
                <span className="block text-xs text-muted-foreground">
                  {item.inventory.quantity} ·{" "}
                  {item.inventory.locationName ?? "Choose location"}
                </span>
              ) : null}
            </span>
          </button>
        </div>
      ))}
    </nav>
  );
}

function activePhotoKey(
  items: readonly PhotoGroupProposal[],
  key: string | null,
) {
  return (items.find((item) => item.groupKey === key) ?? items[0])?.groupKey;
}

export function PhotoGroupReview({
  runId,
  query,
  hasAgent,
}: {
  runId: string;
  hasAgent: boolean;
  query: ReturnType<typeof usePhotoRunReview>;
}) {
  const [session] = useState(() => new PhotoReviewDraftSession());
  const proposals = query.data?.review.proposals;
  const reviewView = usePhotoReviewScope({ proposals, getName: proposalName });
  const {
    admitted,
    visible: visibleProposals,
    ready,
    filteredReady,
  } = reviewView;
  const draft = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const queryClient = useQueryClient();
  const candidates = usePhotoRunCandidates(runId, proposals ?? NO_PROPOSALS);
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const activeKey = activePhotoKey(visibleProposals, activeGroupKey);
  const action = useReviewAction(runId);
  const defaultsCommand = useWorkflowCommand({
    onResult: ({ result }) => {
      queryClient.setQueryData(
        photoImport.review.queryKey({ runId }),
        photoRunReviewResponse.parse(result),
      );
    },
  });
  const nextAttention = useRef<string | null>(null);
  const save: Save = async (build, onSaved) => {
    try {
      await session.save(async () => {
        const edit = await build();
        await action.mutateAsync({ action: "save", ...edit, onSaved });
      });
      return true;
    } catch (error) {
      showErrorToast(error);
      return false;
    }
  };
  const approve = (groupKeys: string[]) =>
    session.approve(groupKeys, async () => {
      try {
        // Blur joins the focused input to the session's save barrier before revision capture.
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        await session.flushSaves();
        await Promise.resolve();
        const unsaved = [...session.getSnapshot().drafts].find(([, field]) =>
          groupKeys.includes(field.groupKey),
        );
        if (unsaved) {
          // Approval's finally re-enables the field before focus can land.
          requestAnimationFrame(() =>
            document.getElementById(unsaved[0])?.focus(),
          );
          throw new Error(
            "Save or correct the edited field before applying this group",
          );
        }
        const latest = queryClient.getQueryData<
          Awaited<ReturnType<typeof photoImport.review.call>>
        >(photoImport.review.queryKey({ runId }));
        const expectedRevisions = (latest?.review.proposals ?? [])
          .filter((proposal) => groupKeys.includes(proposal.groupKey))
          .map(({ groupKey, updatedAt }) => ({ groupKey, updatedAt }));
        if (expectedRevisions.length !== groupKeys.length)
          throw new Error(
            "Photo group review changed; reload before approving",
          );
        const result = await action.mutateAsync({
          action: "approve",
          groupKeys,
          expectedRevisions,
        });
        session.settleSelection(
          groupKeys,
          result.results
            .filter(
              (item) =>
                item.outcome === "failed" || item.outcome === "conflict",
            )
            .map((item) => item.groupKey),
        );
      } catch (error) {
        showErrorToast(error);
      }
    });

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
              ? "Retry failed descriptions below, or explicitly continue without those photos. Their originals are retained."
              : "Review the ungrouped photos below and use a photo’s menu to propose a group. Existing approved items are retained."),
        }
      : query.data.lifecycle.processor === "external"
        ? {
            title: "Waiting for your Claude/Codex session to propose groups.",
            detail:
              "Use the grouping control below once descriptions are ready, or use a photo’s menu to create a group yourself.",
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
  const selectedBatch = ready.filter((proposal) =>
    draft.selected.has(proposal.groupKey),
  );
  const applyingBatch = draft.selected.size ? selectedBatch : filteredReady;
  const groupByImage = new Map<string, string>();
  for (const proposal of review.proposals)
    for (const entry of [...proposal.images, ...proposal.skip]) {
      groupByImage.set(entry.id, proposal.groupKey);
    }
  const busy =
    action.isPending ||
    defaultsCommand.isPending ||
    draft.saves.size > 0 ||
    draft.approving !== null;
  // Result links wait through approval's passive detail-cache eviction.
  const approving = draft.approving !== null;

  return (
    <PhotoDraftContext value={session}>
      <PhotoProposalsContext value={review.proposals}>
        <PhotoCandidatesContext value={candidates}>
          <Stack gap="lg">
            {results.length > 0 && !reviewView.attention ? (
              <Section
                headingAs="h2"
                title="Import results"
                inert={approving}
                caption={`${resultProducts.filter((proposal) => proposal.product.kind === "create").length} Products created · ${resultProducts.filter((proposal) => proposal.product.kind === "existing").length} existing Products matched`}
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
              headingAs="h2"
              title="Photo review"
              caption={`${proposed.length} to review · ${settled.length} settled · ${review.unassignedImageIds.length} photos not in a group`}
            >
              <PhotoReviewScopeControls review={reviewView} />
              {proposed.length > 0 ? (
                <PhotoRunDestination
                  defaults={query.data.defaults}
                  disabled={busy}
                  onChange={(defaults) =>
                    defaultsCommand.mutate(
                      operationCommandRequest(
                        photoImportContract,
                        "setDefaults",
                        { runId, defaults },
                      ),
                    )
                  }
                />
              ) : null}
              <output className="text-xs text-muted-foreground">
                {action.isPending
                  ? action.variables?.action === "save"
                    ? "Saving changes…"
                    : "Applying decision…"
                  : action.isError
                    ? `Changes were not saved: ${action.error.message}`
                    : action.isSuccess
                      ? "Proposal saved · records change only on approval"
                      : "Proposal edits save when you leave a field. Approve to apply them."}
              </output>
              {visibleProposals.some(
                (group) => group.state === "proposed" && group.blockedReason,
              ) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const attention = visibleProposals.filter(
                      (group) =>
                        group.state === "proposed" && group.blockedReason,
                    );
                    const previous = attention.findIndex(
                      (group) => group.groupKey === nextAttention.current,
                    );
                    const unresolved =
                      attention[(previous + 1) % attention.length];
                    nextAttention.current = unresolved?.groupKey ?? null;
                    if (unresolved) setActiveGroupKey(unresolved.groupKey);
                    if (unresolved) {
                      const target = document.getElementById(
                        `photo-group-${unresolved.groupKey}`,
                      );
                      requestAnimationFrame(() => {
                        target?.scrollIntoView({ block: "start" });
                        target?.focus({ preventScroll: true });
                      });
                    }
                  }}
                >
                  Next item needing a decision
                </Button>
              ) : null}
              {proposed.length > 0 ? (
                <Row
                  align="center"
                  justify="between"
                  gap="sm"
                  className="flex-wrap"
                >
                  <span className="text-xs text-muted-foreground">
                    {applyingBatch.length
                      ? `${draft.selected.size ? "Selected items" : "Ready items in this view"} — On apply: ${applyingBatch.filter((group) => group.product.kind === "create").length} new Products · ${applyingBatch.filter((group) => group.product.kind === "existing").length} existing Products matched · ${applyingBatch.reduce((sum, group) => sum + (group.inventory?.quantity ?? 0), 0)} stock units to add · ${applyingBatch.filter((group) => !group.inventory).length} groups with no stock change.`
                      : "No ready items in this scope. Unresolved items stay in review."}
                  </span>
                  <Row gap="sm" wrap>
                    <Button
                      variant="outline"
                      disabled={busy || filteredReady.length === 0}
                      onClick={() =>
                        session.select(
                          filteredReady.map((proposal) => proposal.groupKey),
                        )
                      }
                    >
                      Select all ready items
                    </Button>
                    {draft.selected.size > 0 ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => session.select([])}
                      >
                        Clear selection
                      </Button>
                    ) : null}
                    <Button
                      onMouseDown={(event) => event.preventDefault()}
                      disabled={
                        applyingBatch.length === 0 ||
                        defaultsCommand.isPending ||
                        (action.isPending &&
                          action.variables?.action !== "save") ||
                        approving
                      }
                      onClick={() =>
                        void approve(
                          applyingBatch.map((proposal) => proposal.groupKey),
                        )
                      }
                    >
                      <CheckIcon />
                      {approving
                        ? "Approving selected items…"
                        : `Approve ${countLabel(applyingBatch.length, draft.selected.size ? "selected item" : "ready item")}`}
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
            <PhotoReviewEmpty
              total={review.proposals.length}
              visible={visibleProposals.length}
            />
            {admitted.length > 0 ? (
              <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
                <PhotoItemList
                  items={visibleProposals}
                  runStatus={review.runStatus}
                  activeGroupKey={activeKey}
                  setActiveGroupKey={setActiveGroupKey}
                  imagesById={imagesById}
                  selected={draft.selected}
                  onSelectionChange={(keys) => session.select(keys)}
                  busy={busy}
                />
                <div className="min-w-0">
                  {/* Hidden editors stay mounted so filtering preserves unsaved drafts. */}
                  {admitted.map((selected) => (
                    <div
                      key={selected.groupKey}
                      hidden={activeKey !== selected.groupKey}
                      id={`photo-group-${selected.groupKey}`}
                      className="scroll-mt-20"
                      data-detail-section
                      tabIndex={-1}
                      inert={selected.state !== "proposed" && approving}
                    >
                      {selected.state === "proposed" ? (
                        <PhotoDraftGroup value={selected.groupKey}>
                          <DeferredPhotoGroup
                            eager={activeKey === selected.groupKey}
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
                              approve={(groupKey) => approve([groupKey])}
                            />
                          </DeferredPhotoGroup>
                        </PhotoDraftGroup>
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
                          <SettledGroup
                            runId={runId}
                            proposal={selected}
                            imagesById={imagesById}
                          />
                        </Section>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {review.unassignedImageIds.length ? (
              <Section
                headingAs="h2"
                aria-label="Not in a group"
                title="Not in a group"
                count={review.unassignedImageIds.length}
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
        </PhotoCandidatesContext>
      </PhotoProposalsContext>
    </PhotoDraftContext>
  );
}
