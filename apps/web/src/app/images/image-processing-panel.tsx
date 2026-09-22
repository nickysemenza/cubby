import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { imageProcessingStatusOutput } from "@cubby/schemas/image-processing";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Image } from "~/components/ui/image";
import { Textarea } from "~/components/ui/textarea";
import { image as imageOperations } from "~/entities/image.functions";
import { activity } from "~/lib/activity.functions";
import { imageProcessing } from "~/lib/image-processing.functions";

function ImageAnalysisHistory({
  id,
}: {
  id: ReturnType<typeof imageShortcode.parse>;
}) {
  const analyses = useInfiniteQuery(
    imageProcessing.analyses.infiniteQueryOptions(
      { id, limit: 20 },
      {
        pageParamSchema: z.nullable(z.string()),
        initialPageParam: null,
        page: (input, cursor) =>
          cursor === null ? input : { ...input, cursor },
        getNextPageParam: (page) => page.nextCursor ?? undefined,
      },
    ),
  );
  const pages = analyses.data?.pages ?? [];
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Full AI history</h4>
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
              {analysis.provider} · {analysis.model} · {analysis.createdAt}
            </summary>
            <p>{analysis.result.description}</p>
            <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
              {JSON.stringify(analysis, null, 2)}
            </pre>
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
              {analysis.reason}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
              {analysis.rawResultJson}
            </pre>
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
}: {
  status: z.infer<typeof imageProcessingStatusOutput>;
}) {
  const preferred = status.analyses.find((analysis) => analysis.preferred);
  return (
    <>
      {status.correction ? (
        <p>
          <strong>Confirmed correction:</strong> {status.correction.description}
        </p>
      ) : null}
      {preferred ? <p>{preferred.result.description}</p> : null}
    </>
  );
}

export function ImageProcessingPanel({ image }: { image: ImageWithEntity }) {
  const id = imageShortcode.parse(image.id);
  const status = useQuery({
    ...imageProcessing.status.queryOptions({ id }),
    refetchInterval: (query) =>
      Object.values(query.state.data?.status ?? {}).some((value) =>
        ["pending", "leased", "waiting_for_device"].includes(value ?? ""),
      )
        ? 15_000
        : false,
    refetchIntervalInBackground: false,
  });
  const recentRuns = useQuery({
    ...activity.list.queryOptions({ subjectId: id, limit: 10 }),
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.active) ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
  const [correction, setCorrection] = useState("");
  const [compareOpen, setCompareOpen] = useState(false);
  const save = useActionMutation({
    mutationFn: imageProcessing.correctDescription.mutationOptions,
    success: "Description correction saved",
  });
  const schedule = useActionMutation({
    mutationFn: imageProcessing.schedule.mutationOptions,
    success: (result) =>
      result.submissionId ? (
        <a
          className="underline"
          href={`/activity?view=runs&submissionId=${encodeURIComponent(result.submissionId)}`}
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
    <section className="space-y-3" aria-label="Image processing">
      <h3 className="text-sm font-medium">
        Image representations and descriptions
      </h3>
      <div className="flex flex-wrap gap-2 text-sm">
        <a
          className="underline"
          href={image.url}
          target="_blank"
          rel="noreferrer"
        >
          View original
        </a>
        {status.data?.representations.transparent ? (
          <a
            className="underline"
            href={status.data.representations.transparent}
            target="_blank"
            rel="noreferrer"
          >
            View transparent PNG
          </a>
        ) : (
          <span className="text-muted-foreground">
            Transparent image unavailable
          </span>
        )}
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
          <p className="text-xs text-muted-foreground">
            Description: {status.data.status.description ?? "Not processed"} ·
            Background removal: {status.data.status.cutout ?? "Not processed"}
          </p>
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
          <DescriptionSummary status={status.data} />
          <ImageAnalysisHistory id={id} />
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Recent jobs</h4>
              <a
                className="text-xs text-primary hover:underline"
                href={`/activity?view=runs&subjectId=${encodeURIComponent(id)}`}
              >
                View all
              </a>
            </div>
            {(recentRuns.data?.items ?? []).map((run) => (
              <a
                key={run.id}
                className="block border-b border-border py-2 text-sm hover:bg-muted/40"
                href={`/activity?view=runs&selectedRun=${encodeURIComponent(run.id)}`}
              >
                {run.kind.replaceAll("_", " ")} · {run.state}
              </a>
            ))}
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
        <Button
          size="sm"
          variant="outline"
          disabled={schedule.isPending}
          onClick={() =>
            schedule.mutate({ id, kinds: ["describe_image", "subject_lift"] })
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
          Evaluate this image on Apple
        </Button>
      </div>
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
                />
              </a>
            </figure>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
