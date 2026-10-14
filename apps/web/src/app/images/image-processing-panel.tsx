import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageWithEntity } from "@cubby/schemas/image";
import {
  imageProcessingStatusOutput,
  scheduleImageProcessingInput,
  selectImageDescription,
} from "@cubby/schemas/image-processing";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";

import {
  WorkStateDot,
  workIssueText,
  workStateLabel,
} from "~/app/activity/work-state";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { exactRippleTags } from "~/integrations/tanstack-query/cache-tags";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import {
  image as imageOperations,
  activity,
  imageProcessing,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatInstant } from "~/lib/date-format";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Image } from "~/ui/primitives/image";
import { Textarea } from "~/ui/primitives/textarea";
import { ShortcodeProse } from "~/ui/shortcode-prose";

function ImageAnalysisHistory({
  id,
}: {
  id: ReturnType<typeof imageShortcode.parse>;
}) {
  const analyses = useInfiniteQuery(
    cursorQueryOptions(imageProcessing.analyses, { id, limit: 20 }),
  );
  const pages = analyses.data?.pages ?? [];
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Analysis history</h4>
        <span className="text-xs text-muted-foreground">
          {pages[0]?.total ?? 0} analyses
        </span>
      </div>
      {pages
        .flatMap((page) => page.items)
        .map((analysis) => (
          <details
            key={`${analysis.provider}:${analysis.model}:${analysis.inputFingerprint}`}
            className="border-b border-border py-2 text-sm"
          >
            <summary className="text-xs text-muted-foreground">
              {analysis.provider} ·{" "}
              {formatInstant(analysis.createdAt, "dateShortTime")}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              {analysis.model}
              {analysis.preferred ? " · Preferred description" : ""}
            </p>
            <details className="mt-2">
              <summary className="text-xs">Technical details</summary>
              <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                {JSON.stringify(analysis, null, 2)}
              </pre>
            </details>
          </details>
        ))}
      {pages
        .flatMap((page) => page.unparsed)
        .map((analysis) => (
          <details
            key={`${analysis.createdAt}:${analysis.promptVersion}`}
            className="border-b border-border py-2 text-sm"
          >
            <summary>
              Unparsed result · {analysis.provider ?? "Unknown provider"} ·{" "}
              <ShortcodeProse>{analysis.reason}</ShortcodeProse>
            </summary>
            <details className="mt-2">
              <summary className="text-xs">Technical details</summary>
              <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                {analysis.rawResultJson}
              </pre>
            </details>
          </details>
        ))}
      {analyses.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void analyses.fetchNextPage()}
          disabled={analyses.isFetchingNextPage}
        >
          Load more analysis
        </Button>
      ) : null}
    </section>
  );
}

function DescriptionSummary({
  status,
  image,
}: {
  status: z.infer<typeof imageProcessingStatusOutput>;
  image: ImageWithEntity;
}) {
  const description = selectImageDescription(
    status.analyses,
    status.correction,
    image.sha256,
  );
  const selected = status.analyses.find(
    (analysis) => analysis.result.description === description,
  );
  return (
    <section className="space-y-2" aria-label="Selected image description">
      <h4 className="text-sm font-medium">Description</h4>
      {description ? (
        <>
          <p className="text-sm">
            <ShortcodeProse>{description}</ShortcodeProse>
          </p>
          <p className="text-xs text-muted-foreground">
            {status.correction
              ? "Confirmed correction"
              : `${selected?.provider} description${selected?.preferred ? " · Preferred" : " · Available result"}`}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No description available yet.
        </p>
      )}
      {status.analyses.length > 0 ? (
        <details className="text-sm">
          <summary>Compare Apple and cloud descriptions</summary>
          {status.analyses.map((analysis) => (
            <div
              key={`${analysis.provider}:${analysis.model}:${analysis.inputFingerprint}`}
              className="border-b border-border py-2"
            >
              <p className="text-xs text-muted-foreground">
                {analysis.provider} · {analysis.model}
                {analysis.preferred ? " · Preferred" : ""}
              </p>
              <p>
                <ShortcodeProse>{analysis.result.description}</ShortcodeProse>
              </p>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

function IdentificationSummary({ image }: { image: ImageWithEntity }) {
  const attach = useActionMutation({
    mutationFn: imageOperations.attachExisting.mutationOptions,
    success: "Confirmed Product image attachment saved",
  });
  const identification = image.analysisSummary?.identification;
  if (!identification)
    return (
      <section className="space-y-2" aria-label="Product identification">
        <h4 className="text-sm font-medium">Product identification</h4>
        <p className="text-sm text-muted-foreground">
          No current identification result. Queue missing processing to evaluate
          this image.
        </p>
      </section>
    );
  const reason =
    identification.outcome === "not_single_identity"
      ? "Multiple or unclear identities: no Product identity suggested."
      : identification.outcome === "no_candidates"
        ? "No live Product suggestions are available."
        : "No confident Product match found.";
  return (
    <section className="space-y-2" aria-label="Product identification">
      <h4 className="text-sm font-medium">Product identification</h4>
      <p className="text-xs text-muted-foreground">
        Composition: {identification.subject.replaceAll("_", " ")} · Identity:{" "}
        {(identification.identityScope ?? "unclear").replaceAll("_", " ")}
      </p>
      {identification.outcome === "suggestions" &&
      identification.candidates.length ? (
        <>
          <RecordList aria-label="Unconfirmed Product suggestions">
            {identification.candidates.map((candidate) => (
              <RecordRow
                key={candidate.productId}
                primary={
                  <EntityRefLink
                    variant="preview"
                    entity="product"
                    id={candidate.productId}
                    displayImage={null}
                  >
                    {candidate.name}
                  </EntityRefLink>
                }
                trailing={`${Math.round(candidate.probability * 100)}% confidence`}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    disabled={
                      attach.isPending ||
                      image.associations.some(
                        (association) =>
                          association.entityId === candidate.productId,
                      )
                    }
                    onClick={() =>
                      attach.mutate({
                        imageId: image.id,
                        targetId: candidate.productId,
                        purpose: "item",
                      })
                    }
                  >
                    {image.associations.some(
                      (association) =>
                        association.entityId === candidate.productId,
                    )
                      ? "Already attached"
                      : "Confirm and attach"}
                  </Button>
                }
              />
            ))}
          </RecordList>
          <p className="text-xs text-muted-foreground">
            Suggestions need confirmation. Review the Product, then confirm to
            attach this image as an item photo. Confirmation does not change
            inventory.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{reason}</p>
      )}
    </section>
  );
}

export function ImageProcessingPanel({ image }: { image: ImageWithEntity }) {
  const id = imageShortcode.parse(image.id);
  const status = useImageProcessingStatus(id);
  const recentRuns = useQuery({
    ...activity.list.queryOptions({ subjectId: id, limit: 10 }),
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.active) ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!recentRuns.data) return;
    // Background completion happens outside this browser's mutation cache.
    // Refresh detail records without invalidating activity and triggering this effect again.
    void invalidateOperationTags(
      queryClient,
      exactRippleTags([["entity", "detail"]]),
    );
  }, [id, queryClient, recentRuns.data]);
  const [correction, setCorrection] = useState("");
  const save = useActionMutation({
    mutationFn: imageProcessing.correctDescription.mutationOptions,
    success: "Description correction saved",
  });
  if (image.status !== "UPLOADED") return null;
  return (
    <section className="space-y-3" aria-label="Image processing">
      <h3 className="text-sm font-medium">
        Image representations and descriptions
      </h3>
      <DetailAction>
        <ImageProcessingActions image={image} />
      </DetailAction>
      {status.data ? (
        <>
          <p className="text-xs text-muted-foreground">
            Description:{" "}
            {status.data.status.description
              ? workStateLabel(status.data.status.description)
              : "Not processed"}{" "}
            · Background removal:{" "}
            {status.data.status.cutout
              ? workStateLabel(status.data.status.cutout)
              : "Not processed"}
          </p>
          {!status.data.representations.transparent ? (
            <p className="text-muted-foreground">
              Transparent image unavailable
            </p>
          ) : null}
          <DescriptionSummary status={status.data} image={image} />
          <IdentificationSummary image={image} />
          <details>
            <summary className="text-sm">Technical analysis history</summary>
            <ImageAnalysisHistory id={id} />
          </details>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Recent jobs</h4>
            </div>
            <RecordList
              empty="No processing jobs yet."
              state={
                recentRuns.isPending
                  ? { status: "pending" }
                  : recentRuns.error
                    ? {
                        status: "error",
                        error: recentRuns.error,
                        title: "recent image jobs",
                        onRetry: () => void recentRuns.refetch(),
                      }
                    : undefined
              }
            >
              {(recentRuns.data?.items ?? []).map((run) => (
                <RecordRow
                  key={run.id}
                  leading={<WorkStateDot state={run.state} />}
                  primary={
                    <a
                      className="hover:underline"
                      href={`/runs?selected=${encodeURIComponent(run.id)}`}
                    >
                      {run.workLabel}
                    </a>
                  }
                  secondary={[
                    workStateLabel(run.state),
                    run.executors.length
                      ? [
                          ...new Set(
                            run.executors.map((executor) =>
                              executor.kind === "device" ? "Apple" : "Cloud",
                            ),
                          ),
                        ].join(" · ")
                      : "Executor not assigned",
                  ].join(" · ")}
                  trailing={
                    <DateDisplay timestamp={run.createdAt} clock="day" />
                  }
                  detail={
                    workIssueText(run) ? (
                      <p className="text-xs text-muted-foreground">
                        <ShortcodeProse>
                          {workIssueText(run) ?? ""}
                        </ShortcodeProse>
                      </p>
                    ) : undefined
                  }
                />
              ))}
            </RecordList>
          </section>
        </>
      ) : status.error ? (
        <ErrorDisplay
          error={status.error}
          title="processing status"
          onRetry={() => void status.refetch()}
        />
      ) : (
        <p>Loading processing status…</p>
      )}
      <Textarea
        aria-label="Corrected image description"
        value={correction}
        onChange={(event) => setCorrection(event.target.value)}
        placeholder="Confirm a description or correct a model claim"
        maxLength={4000}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !correction.trim()}
          onClick={() => save.mutate({ id, description: correction.trim() })}
        >
          Save correction
        </Button>
      </div>
    </section>
  );
}

function useImageProcessingStatus(id: ReturnType<typeof imageShortcode.parse>) {
  return useQuery({
    ...imageProcessing.status.queryOptions({ id }),
    refetchInterval: (query) =>
      Object.values(query.state.data?.status ?? {}).some((value) =>
        ["pending", "leased", "waiting_for_device"].includes(value ?? ""),
      )
        ? 15_000
        : false,
    refetchIntervalInBackground: false,
  });
}

export const ImageDetailActions: DetailSlotComponent<"image"> = ({
  record,
}) => <ImageProcessingActions image={record} />;

function ImageProcessingActions({ image }: { image: ImageWithEntity }) {
  const id = imageShortcode.parse(image.id);
  const status = useImageProcessingStatus(id);
  const [compareOpen, setCompareOpen] = useState(false);
  const schedule = useActionMutation({
    mutationFn: imageProcessing.schedule.mutationOptions,
    success: (result) =>
      result.submissionId ? (
        <a
          className="underline"
          href={`/runs?submissionId=${encodeURIComponent(result.submissionId)}`}
        >
          Image processing queued — view submission
        </a>
      ) : (
        "Image processing queued"
      ),
  });
  const evaluate = useActionMutation({
    mutationFn: imageProcessing.evaluateAppleDescription.mutationOptions,
    success: "Apple description evaluation queued",
  });
  const retry = useActionMutation({
    mutationFn: imageProcessing.retry.mutationOptions,
    success: "Failed image processing retried",
  });
  const update = useActionMutation({
    mutationFn: imageOperations.update.mutationOptions,
    success: "Image preference saved",
  });
  if (image.status !== "UPLOADED") return null;
  return (
    <>
      <div className="flex flex-wrap gap-2 text-sm">
        <a
          className={buttonVariants({ variant: "outline" })}
          href={image.url}
          target="_blank"
          rel="noreferrer"
        >
          View original
        </a>
        {status.data?.representations.transparent ? (
          <a
            className={buttonVariants({ variant: "outline" })}
            href={status.data.representations.transparent}
            target="_blank"
            rel="noreferrer"
          >
            View transparent PNG
          </a>
        ) : null}
        {status.data?.representations.transparent ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setCompareOpen(true)}
          >
            Compare original and result
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({
              id,
              data: {
                filename: image.filename,
                useOriginal: !image.useOriginal,
              },
            })
          }
        >
          {image.useOriginal ? "Prefer transparent image" : "Use original"}
        </Button>
      </div>
      {status.data ? (
        <>
          {status.data.status.description === "failed" ||
          status.data.status.cutout === "failed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ id })}
            >
              Retry failed processing
            </Button>
          ) : null}
        </>
      ) : null}
      <a
        className={buttonVariants({ variant: "outline" })}
        href={`/runs?subjectId=${encodeURIComponent(id)}`}
      >
        View processing jobs
      </a>
      <Button
        size="sm"
        variant="outline"
        disabled={schedule.isPending}
        onClick={() =>
          schedule.mutate(scheduleImageProcessingInput.parse({ id }))
        }
      >
        Queue missing processing
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={evaluate.isPending}
        onClick={() => evaluate.mutate({ id })}
      >
        Queue Apple description
      </Button>
      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Original and processed result</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <figure>
              <figcaption className="mb-2 text-sm font-medium">
                Original
              </figcaption>
              <a href={image.url} target="_blank" rel="noreferrer">
                <Image
                  src={image.url}
                  alt="Original image"
                  displayWidth={640}
                  className="max-h-[60vh] w-full object-contain"
                />
              </a>
            </figure>
            <figure>
              <figcaption className="mb-2 text-sm font-medium">
                Transparent result
              </figcaption>
              <a
                href={status.data?.representations.transparent ?? image.url}
                target="_blank"
                rel="noreferrer"
              >
                <Image
                  src={status.data?.representations.transparent ?? image.url}
                  alt="Processed image"
                  displayWidth={640}
                  className="max-h-[60vh] w-full object-contain"
                  style={{
                    backgroundColor: "var(--color-card)",
                    backgroundImage:
                      "conic-gradient(var(--color-muted) 25%, transparent 0 50%, var(--color-muted) 0 75%, transparent 0)",
                    backgroundSize: "16px 16px",
                  }}
                />
              </a>
            </figure>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
