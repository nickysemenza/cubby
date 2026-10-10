import {
  GTIN_KIND,
  GTIN_SOURCE,
  normalizeGtin,
} from "@cubby/schemas/external-id";
import { runEntityId } from "@cubby/schemas/identifiers";
import { retainedMailContent } from "@cubby/schemas/mailbox-research";
import {
  researchSourceMetadata,
  retainedResearchObservation,
  type ResearchIdentifierCandidate,
  type ResearchObservation,
  type ResearchImageCandidate,
  type RetainedResearchObservation,
} from "@cubby/schemas/research";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
  validateExternalHttpUrl,
} from "@cubby/shared/external-fetch";
import { sha256Hex, sha256Uuid } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env as appEnv } from "~/env";
import { wasm } from "~/lib/wasm";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { ledgerParty, run, runEvidence, runTarget } from "~/server/db/schema";
import {
  getDb,
  isTransaction,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

import {
  productionBrowserEvidenceStorage,
  type BrowserEvidenceStorage,
} from "./browser-results";
import { mailAttachmentReadableContent } from "./research-attachment-content";
import { fetchPublicPage, type FetchPage } from "./server-page-fetch";
import { structuredProductsFromJsonLd } from "./structured-products";

const retentionInput = z.object({
  runId: z.uuid(),
  workRef: z.uuid(),
  callId: z.string().trim().min(1).max(200),
  kind: z.enum([
    "web_page",
    "mail_message",
    "browser_capture",
    "upload_evidence",
  ]),
  sourceMetadata: researchSourceMetadata,
  content: z.string().max(MAX_EXTERNAL_HTML_BYTES),
});
export type RetainResearchObservationInput = z.input<typeof retentionInput>;
export type ResearchObservationPorts = {
  storage?: BrowserEvidenceStorage;
  fetchPage?: FetchPage;
  keyPrefix?: string;
  search?: ResearchWebEnvironment["AI"]["websearch"];
};
export type ResearchWebEnvironment = Pick<Env, "R2_KEY_PREFIX"> & {
  AI: Pick<Env["AI"], "websearch">;
};
type Client = DrizzleClient | DrizzleTransaction;
const activeWork = ["pending", "prepared", "needs_evidence"];

/** The caller supplies the exact target; no queue-order inference is allowed. */
async function liveWork(
  client: Client,
  input: { runId: string; workRef: string },
) {
  const [scope] = await client
    .select({ shortcode: run.shortcode })
    .from(run)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(run.id, runEntityId.parse(input.runId)),
        inArray(run.status, ["running", "paused_offline"]),
        notDeleted(run),
      ),
    )
    .limit(1);
  if (!scope) throw new Error("Research run is not live.");
  const [target] = await client
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(
      and(
        eq(runTarget.id, input.workRef),
        eq(runTarget.runId, runEntityId.parse(input.runId)),
        inArray(runTarget.state, activeWork),
      ),
    )
    .limit(1);
  if (!target) throw new Error("Research work is not live in this run.");
  return scope;
}

async function lockObservationWork(
  tx: DrizzleTransaction,
  input: { runId: string; workRef: string },
) {
  const [locked] = await tx
    .select({ retiredAt: run.retiredAt })
    .from(run)
    .where(eq(run.id, runEntityId.parse(input.runId)))
    .for("update");
  if (locked?.retiredAt)
    throw new Error(
      "Research coordinator permanently retired: unrelated_source.",
    );
  const scope = await liveWork(tx, input);
  await tx
    .select({ id: runTarget.id })
    .from(runTarget)
    .where(eq(runTarget.id, input.workRef))
    .for("update");
  await liveWork(tx, input);
  return scope;
}

async function markObservationUploaded(
  tx: DrizzleTransaction,
  evidence: typeof runEvidence.$inferSelect,
) {
  const metadata = z
    .record(z.string(), z.unknown())
    .parse(evidence.sourceMetadata);
  await tx
    .update(runEvidence)
    .set({ sourceMetadata: { ...metadata, researchUploadState: "uploaded" } })
    .where(eq(runEvidence.id, evidence.id));
}

/** Public URLs are leads only; rejected links cannot authorize a server fetch. */
const publicURL = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    return validateExternalHttpUrl(raw).href;
  } catch {
    return null;
  }
};

type CompactedResearchPage = ReturnType<typeof wasm.compact_browser_page>;

async function identifierCandidates(
  structured: ReturnType<typeof structuredProductsFromJsonLd> | null,
  servedURL: string | null,
  evidenceId: string,
) {
  const candidates: ResearchIdentifierCandidate[] = [];
  const add = async (
    kind: ResearchIdentifierCandidate["kind"],
    externalId: string,
    source: string | null,
  ) => {
    if (
      !servedURL ||
      candidates.some(
        (candidate) =>
          candidate.kind === kind &&
          candidate.externalId === externalId &&
          candidate.source === source,
      )
    )
      return;
    candidates.push({
      candidateRef: await sha256Uuid(
        `research-identifier:${evidenceId}:${kind}:${source}:${externalId}`,
      ),
      evidenceId,
      kind,
      source,
      externalId,
      sourceURL: servedURL,
      origin: "json_ld",
    });
  };
  for (const product of structured?.products ?? []) {
    for (const sku of product.skus) await add("retailer_sku", sku, null);
    for (const mpn of product.mpns) await add("manufacturer_part", mpn, null);
    for (const gtin of product.gtins) {
      const normalized = normalizeGtin(gtin);
      if (normalized) await add(GTIN_KIND, normalized, GTIN_SOURCE);
    }
    for (const id of product.productIds) await add("item_number", id, null);
  }
  return candidates;
}

async function imageCandidates(
  page: CompactedResearchPage | null,
  servedURL: string | null,
  evidenceId: string,
) {
  const images: ResearchImageCandidate[] = [];
  for (const image of page?.images ?? []) {
    const url = publicURL(image.src);
    if (!url || !servedURL || images.some((candidate) => candidate.url === url))
      continue;
    images.push({
      candidateRef: await sha256Uuid(`research-image:${evidenceId}:${url}`),
      evidenceId,
      sourceURL: servedURL,
      url,
      alt: image.alt.slice(0, 500) || null,
      naturalWidth: image.width ?? null,
      naturalHeight: image.height ?? null,
      highResolutionUrl: publicURL(image.high_resolution),
    });
    if (images.length === 200) break;
  }
  return images;
}

const mailEnvelope = z.looseObject({ content: retainedMailContent });

/** Present MIME bodies before layout bytes consume the bounded model view. */
function readableMail(content: string) {
  const readable = mailAttachmentReadableContent(content);
  let original;
  try {
    original = JSON.parse(readable);
  } catch {
    return { text: readable, links: [] };
  }
  const parsed = mailEnvelope.safeParse(original);
  if (!parsed.success) return { text: readable, links: [] };
  const { bodyHtml, ...body } = parsed.data.content;
  const html = bodyHtml ? wasm.compact_browser_page(bodyHtml, "") : null;
  return {
    links: html?.links ?? [],
    text: JSON.stringify({
      ...parsed.data,
      content: {
        ...body,
        htmlText: html?.text ?? null,
        links:
          html?.links.map(({ href, text }) => ({ url: href, label: text })) ??
          [],
      },
    }),
  };
}

function pageObservation(
  input: z.output<typeof retentionInput>,
  page: CompactedResearchPage | null,
  mail: ReturnType<typeof readableMail> | null,
  structured: ReturnType<typeof structuredProductsFromJsonLd> | null,
  capturedAt: string,
): ResearchObservation {
  const metadata = input.sourceMetadata;
  const sourceURL = publicURL(metadata.sourceURL);
  const servedURL = publicURL(metadata.servedURL ?? metadata.sourceURL);
  const text = page?.text ?? mail?.text ?? input.content;
  return {
    sourceURL,
    servedURL,
    canonicalUrl: publicURL(page?.canonical_url),
    title: (metadata.title ?? page?.title ?? metadata.subject ?? "").slice(
      0,
      500,
    ),
    capturedAt,
    readableText: text.slice(0, 24 * 1_024),
    textTruncated: text.length > 24 * 1_024,
    truncated: metadata.truncated,
    observationId: metadata.observationId ?? null,
    actions: metadata.actions,
    actionsTruncated: metadata.actionsTruncated,
    variantMarkers: (page?.variant_markers ?? [])
      .map((marker) => marker.slice(0, 500))
      .slice(0, 50),
    links: (page?.links ?? mail?.links ?? [])
      .flatMap((link, index) => {
        const url = publicURL(link.href);
        return url
          ? [
              {
                id: `link-${index + 1}`,
                url,
                label: link.text.slice(0, 300) || null,
              },
            ]
          : [];
      })
      .slice(0, 200),
    authenticationRequired: page?.has_password_input ?? false,
    structuredProducts: structured,
  };
}

async function deriveObservation(
  input: z.output<typeof retentionInput>,
  evidenceId: string,
  capturedAt: string,
): Promise<RetainedResearchObservation> {
  const metadata = input.sourceMetadata;
  const servedURL = publicURL(metadata.servedURL ?? metadata.sourceURL);
  const page = ["mail_message", "upload_evidence"].includes(input.kind)
    ? null
    : wasm.compact_browser_page(input.content, servedURL ?? "");
  const mail = ["mail_message", "upload_evidence"].includes(input.kind)
    ? readableMail(input.content)
    : null;
  const structured =
    page && servedURL
      ? structuredProductsFromJsonLd({
          pageURL: servedURL,
          blocks: page.json_ld,
          omitted: page.json_ld_omitted + (metadata.truncated ? 1 : 0),
        })
      : null;
  return retainedResearchObservation.parse({
    evidenceId,
    observation: pageObservation(input, page, mail, structured, capturedAt),
    identifierCandidates: await identifierCandidates(
      structured,
      servedURL,
      evidenceId,
    ),
    imageCandidates: await imageCandidates(page, servedURL, evidenceId),
  });
}

/** Immutable bytes and derivation share one explicit call/run/target identity. */
export async function retainResearchObservation(
  db: Database,
  rawInput: RetainResearchObservationInput,
  ports: ResearchObservationPorts = {},
): Promise<RetainedResearchObservation> {
  if (isTransaction(getDb(db)))
    throw new Error(
      "Research retention requires its own durable transactions, not a savepoint-bound handle.",
    );
  const input = retentionInput.parse(rawInput);
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > MAX_EXTERNAL_HTML_BYTES)
    throw new Error("Research source exceeds the retained byte limit.");
  const checksum = await sha256Hex(bytes);
  const fingerprint = await sha256Hex(
    JSON.stringify({
      workRef: input.workRef,
      kind: input.kind,
      sourceMetadata: input.sourceMetadata,
      checksum,
    }),
  );
  const evidenceId = await sha256Uuid(
    `research-observation:${input.runId}:${input.callId}`,
  );
  const metadataSchema = z.object({
    researchFingerprint: z.string(),
    research: retainedResearchObservation,
    researchUploadState:
      researchSourceMetadata.shape.researchUploadState.default("uploaded"),
  });
  const assertSameManifest = (evidence: typeof runEvidence.$inferSelect) => {
    const metadata = metadataSchema.parse(evidence.sourceMetadata);
    if (
      evidence.targetId !== input.workRef ||
      evidence.runId !== input.runId ||
      metadata.researchFingerprint !== fingerprint
    )
      throw new Error(
        "Research observation replay was rebound or its source changed.",
      );
    return metadata;
  };
  // A real committed manifest survives partial storage writes and later DB
  // failures. A savepoint cannot provide this boundary.
  const manifest = await withTransaction(db, async (tx) => {
    const scope = await lockObservationWork(tx, input);
    const [existing] = await tx
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, evidenceId))
      .limit(1);
    if (existing) {
      assertSameManifest(existing);
      return existing;
    }
    const capturedAt =
      input.sourceMetadata.capturedAt ?? new Date().toISOString();
    const retained = await deriveObservation(input, evidenceId, capturedAt);
    const objectKey = `${ports.keyPrefix ?? appEnv.R2_KEY_PREFIX}/import-runs/${scope.shortcode}/${input.workRef}/${evidenceId}-${checksum}.${["mail_message", "upload_evidence"].includes(input.kind) ? "txt" : "html"}`;
    const mediaType = ["mail_message", "upload_evidence"].includes(input.kind)
      ? "text/plain"
      : "text/html";
    const [created] = await tx
      .insert(runEvidence)
      .values({
        id: evidenceId,
        runId: runEntityId.parse(input.runId),
        targetId: input.workRef,
        kind: input.kind,
        objectKey,
        checksum,
        mediaType,
        byteSize: bytes.byteLength,
        sourceMetadata: {
          ...input.sourceMetadata,
          capturedAt,
          researchFingerprint: fingerprint,
          research: retained,
          researchUploadState: "pending",
        },
      })
      .returning();
    if (!created)
      throw new Error("Research evidence manifest did not persist.");
    return created;
  });
  const metadata = assertSameManifest(manifest);
  if (metadata.researchUploadState === "uploaded") return metadata.research;
  return withTransaction(db, async (tx) => {
    // Retirement locks the same Run before freezing deletion keys. Either it
    // blocks this PUT or it waits for these bytes and their uploaded marker.
    await lockObservationWork(tx, input);
    const [current] = await tx
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, evidenceId))
      .limit(1);
    if (!current) throw new Error("Research evidence manifest is unavailable.");
    const currentMetadata = assertSameManifest(current);
    if (currentMetadata.researchUploadState === "uploaded")
      return currentMetadata.research;
    await (ports.storage ?? productionBrowserEvidenceStorage).put(
      current.objectKey,
      bytes,
      `${current.mediaType}; charset=utf-8`,
    );
    await markObservationUploaded(tx, current);
    return currentMetadata.research;
  });
}

async function replayWebObservation(
  db: Database,
  input: { runId: string; workRef: string },
  evidenceId: string,
  requestedURL: string,
  storage: BrowserEvidenceStorage,
) {
  return withTransaction(db, async (tx) => {
    await lockObservationWork(tx, input);
    const [existing] = await tx
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.id, evidenceId));
    if (!existing)
      throw new Error("Research evidence manifest is unavailable.");
    const metadata = z
      .object({
        requestedURL: z.url(),
        research: retainedResearchObservation,
        researchUploadState:
          researchSourceMetadata.shape.researchUploadState.default("uploaded"),
      })
      .parse(existing.sourceMetadata);
    if (
      existing.runId !== input.runId ||
      existing.targetId !== input.workRef ||
      existing.kind !== "web_page" ||
      metadata.requestedURL !== requestedURL
    )
      throw new Error(
        "Research web read replay was rebound to a different source or work.",
      );
    if (metadata.researchUploadState === "pending") {
      if (isTransaction(getDb(db)))
        throw new Error(
          "Research retention requires its own durable transactions, not a savepoint-bound handle.",
        );
      if (!storage.get)
        throw new Error(
          "Research evidence upload is pending; its retained bytes reader is unavailable.",
        );
      // An uncertain PUT can already have written the immutable original.
      // Never replace it with a fresh fetch or accept the manifest alone.
      const content = await storage.get(existing.objectKey);
      const bytes = new TextEncoder().encode(content);
      if (
        bytes.byteLength !== existing.byteSize ||
        (await sha256Hex(bytes)) !== existing.checksum
      )
        throw new Error("Pending research evidence checksum changed.");
      await markObservationUploaded(tx, existing);
    }
    return metadata.research;
  });
}

export async function webReadResearch(
  db: Database,
  environment: Pick<ResearchWebEnvironment, "R2_KEY_PREFIX">,
  input: { runId: string; workRef: string; callId: string; url: string },
  ports: ResearchObservationPorts = {},
) {
  await liveWork(getDb(db), input);
  const requested = validateExternalHttpUrl(input.url);
  const address = retentionInput
    .pick({ runId: true, workRef: true, callId: true })
    .parse(input);
  const evidenceId = await sha256Uuid(
    `research-observation:${address.runId}:${address.callId}`,
  );
  const [existing] = await getDb(db)
    .select({ id: runEvidence.id })
    .from(runEvidence)
    .where(eq(runEvidence.id, evidenceId))
    .limit(1);
  if (existing)
    return replayWebObservation(
      db,
      input,
      evidenceId,
      requested.href,
      ports.storage ?? productionBrowserEvidenceStorage,
    );
  const fetched = await (ports.fetchPage ?? fetchPublicPage)(requested.href, [
    requested.hostname,
  ]);
  if (fetched.status !== "fetched")
    throw new Error(`Public research page refused: ${fetched.reason}`);
  const served = validateExternalHttpUrl(fetched.url);
  return retainResearchObservation(
    db,
    {
      ...input,
      kind: "web_page",
      sourceMetadata: {
        sourceURL: requested.href,
        requestedURL: requested.href,
        servedURL: served.href,
      },
      content: fetched.html,
    },
    { ...ports, keyPrefix: environment.R2_KEY_PREFIX },
  );
}

const searchResponse = z.object({
  items: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .max(20),
});

/** Search descriptions guide the next read; they are never factual evidence. */
export async function webSearchResearch(
  db: Database,
  environment: ResearchWebEnvironment,
  input: { runId: string; workRef: string; callId: string; query: string },
  ports: Pick<ResearchObservationPorts, "search"> = {},
) {
  await liveWork(getDb(db), input);
  const query = z.string().trim().min(1).max(1_024).parse(input.query);
  const request = {
    gatewayId: CUBBY_AI_GATEWAY_ID,
    query,
    limit: 10,
  };
  const response = ports.search
    ? await ports.search(request)
    : await environment.AI.websearch(request);
  const bytes = await readResponseWithLimit(response, MAX_EXTERNAL_HTML_BYTES);
  if (!response.ok)
    throw new Error(
      `Web search HTTP ${response.status}: ${new TextDecoder().decode(bytes)}`,
    );
  const result = searchResponse.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  await liveWork(getDb(db), input);
  return {
    query,
    results: result.items
      .flatMap((item) => {
        const url = publicURL(item.url);
        return url
          ? [
              {
                url,
                title: item.title?.slice(0, 500) ?? null,
                description: item.description?.slice(0, 4_000) ?? null,
              },
            ]
          : [];
      })
      .slice(0, 10),
  };
}
