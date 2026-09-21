import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { image as imageOperations } from "~/entities/image.functions";
import { imageProcessing } from "~/lib/image-processing.functions";

export function ImageProcessingPanel({ image }: { image: ImageWithEntity }) {
  const id = imageShortcode.parse(image.id);
  const status = useQuery(imageProcessing.status.queryOptions({ id }));
  const [correction, setCorrection] = useState("");
  const save = useActionMutation({
    mutationFn: imageProcessing.correctDescription.mutationOptions,
    success: "Description correction saved",
  });
  const schedule = useActionMutation({
    mutationFn: imageProcessing.schedule.mutationOptions,
    success: "Image processing queued",
  });
  const evaluate = useActionMutation({
    mutationFn: imageProcessing.evaluateAppleDescription.mutationOptions,
    success: "Apple description evaluation queued",
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
          {status.data.correction ? (
            <p>
              <strong>Confirmed correction:</strong>{" "}
              {status.data.correction.description}
            </p>
          ) : null}
          {status.data.analyses.find((analysis) => analysis.preferred)?.result
            .description ? (
            <p>
              {
                status.data.analyses.find((analysis) => analysis.preferred)
                  ?.result.description
              }
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm">
              Analysis history ({status.data.analyses.length})
            </summary>
            <ol className="space-y-3 pt-2">
              {status.data.analyses.map((analysis) => (
                <li
                  key={`${analysis.provider}:${analysis.model}:${analysis.inputFingerprint}`}
                  className="text-sm"
                >
                  <p className="text-xs text-muted-foreground">
                    {analysis.provider} · {analysis.model} · prompt{" "}
                    {analysis.promptRevision} · schema{" "}
                    {analysis.resultSchemaRevision} · {analysis.createdAt}
                    {analysis.preferred ? " · Preferred" : ""}
                  </p>
                  <p>{analysis.result.description}</p>
                  <p>Cutout eligibility: {analysis.result.cutoutEligibility}</p>
                  <ul>
                    {analysis.result.claims.map((claim) => (
                      <li
                        key={`${claim.imageId}:${claim.evidenceKind}:${claim.text}`}
                      >
                        {claim.evidenceKind}: {claim.text}
                        {claim.imageId ? (
                          <a
                            className="ml-1 underline"
                            href={`/images/${claim.imageId}`}
                          >
                            Source
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : status.error ? (
        <p role="alert">Unable to load processing status.</p>
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
    </section>
  );
}
