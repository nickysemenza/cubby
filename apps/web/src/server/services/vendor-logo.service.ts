import type { ActorContext } from "@cubby/schemas/context";
import type { VendorId, VendorShortcode } from "@cubby/schemas/identifiers";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@cubby/schemas/image";
import type { VendorOut } from "@cubby/schemas/vendor";
import {
  assertResponseContentType,
  fetchExternalResponse,
  readResponseWithLimit,
  validateExternalHttpUrl,
} from "@cubby/shared/external-fetch";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getVendorByShortcode, replaceVendorLogo } from "~/server/repo/vendor";
import {
  filenameForContentType,
  type InspectedImageFile,
  inspectImageFile,
} from "~/server/services/image-integrity";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  contentTypeToExtension,
  deleteS3Object,
  generateImageKey,
  uploadToS3,
} from "~/server/utils/s3";

type LogoCandidate = {
  bytes: Buffer;
  inspected: InspectedImageFile;
  source: "apple-touch-icon" | "google-favicon";
};

type VendorLogoReplacementInput = Parameters<typeof replaceVendorLogo>[1];

interface VendorLogoCandidatePorts {
  fetchResponse: typeof fetchExternalResponse;
  inspect: typeof inspectImageFile;
}

export interface VendorLogoPorts<
  TDatabase,
  TActor,
  TOutput,
  TEntityId,
> extends VendorLogoCandidatePorts {
  contentTypeToExtension: typeof contentTypeToExtension;
  deleteStoredObjects: typeof deleteStoredObjects;
  deleteUploadedObject: typeof deleteS3Object;
  filenameForContentType: typeof filenameForContentType;
  generateImageKey: typeof generateImageKey;
  getVendor: (
    database: TDatabase,
    id: VendorShortcode,
  ) => Promise<{ website: string | null } | null>;
  replaceVendorLogo: (
    database: TDatabase,
    input: VendorLogoReplacementInput,
    actor: TActor,
  ) => Promise<{
    output: TOutput;
    entityId: TEntityId;
    detachedImageKeys: string[];
  }>;
  upload: typeof uploadToS3;
}

export interface NormalizedVendorWebsite {
  hostname: string;
  origin: string;
}

/** Normalize free-text website input into a safe public origin and hostname. */
export function normalizeVendorWebsite(
  website: string,
): NormalizedVendorWebsite {
  const raw = website.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
    ? raw
    : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = validateExternalHttpUrl(withScheme);
  } catch (error) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Record a valid public vendor website before fetching its logo.",
      error,
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  if (!hostname.includes(".")) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Record a valid public vendor website before fetching its logo.",
    );
  }
  return { origin: parsed.origin, hostname };
}

async function readCandidate(
  url: string,
  source: LogoCandidate["source"],
  ports: VendorLogoCandidatePorts,
): Promise<LogoCandidate | null> {
  try {
    const response = await ports.fetchResponse(url);
    if (!response.ok) return null;
    const contentType = assertResponseContentType(
      response,
      ALLOWED_IMAGE_TYPES,
    );
    const bytes = Buffer.from(
      await readResponseWithLimit(response, MAX_IMAGE_UPLOAD_BYTES),
    );
    if (bytes.length === 0) return null;
    const inspected = await ports.inspect(bytes, contentType);
    return { bytes, inspected, source };
  } catch {
    return null;
  }
}

/** Fetch the best Workers-decodable logo candidate without writing anything. */
async function fetchVendorLogoCandidateWithPorts(
  website: string,
  ports: VendorLogoCandidatePorts,
): Promise<LogoCandidate | null> {
  const { origin, hostname } = normalizeVendorWebsite(website);
  const candidates = await Promise.all([
    readCandidate(
      new URL("/apple-touch-icon.png", origin).toString(),
      "apple-touch-icon",
      ports,
    ),
    readCandidate(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`,
      "google-favicon",
      ports,
    ),
  ]);
  return (
    candidates
      .filter((candidate): candidate is LogoCandidate => candidate !== null)
      .sort((a, b) => {
        const aSize = Math.max(a.inspected.width ?? 0, a.inspected.height ?? 0);
        const bSize = Math.max(b.inspected.width ?? 0, b.inspected.height ?? 0);
        return bSize - aSize;
      })[0] ?? null
  );
}

/** Fetch, verify, store, and attach one vendor logo from its recorded website. */
async function fetchAndAttachVendorLogoWithPorts<
  TDatabase,
  TActor,
  TOutput,
  TEntityId,
>(
  database: TDatabase,
  id: VendorShortcode,
  actor: TActor,
  ports: VendorLogoPorts<TDatabase, TActor, TOutput, TEntityId>,
): Promise<{ output: TOutput; entityId: TEntityId }> {
  const current = await ports.getVendor(database, id);
  if (!current) {
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
  }
  if (!current.website) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "Record a vendor website before fetching its logo.",
    );
  }

  const candidate = await fetchVendorLogoCandidateWithPorts(
    current.website,
    ports,
  );
  if (!candidate) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      "No usable logo was found at the recorded vendor website.",
    );
  }

  const extension = ports.contentTypeToExtension(
    candidate.inspected.contentType,
  );
  const filename = ports.filenameForContentType(
    `vendor-${id}.${extension}`,
    candidate.inspected.contentType,
  );
  const key = ports.generateImageKey(filename);
  await ports.upload({
    key,
    body: candidate.bytes,
    contentType: candidate.inspected.contentType,
  });

  try {
    const result = await ports.replaceVendorLogo(
      database,
      {
        id,
        expectedWebsite: current.website,
        image: {
          key,
          filename,
          size: candidate.bytes.length,
          ...candidate.inspected,
        },
      },
      actor,
    );
    await ports.deleteStoredObjects(result.detachedImageKeys);
    return { output: result.output, entityId: result.entityId };
  } catch (error) {
    // SILENT: this is rollback for the `replaceVendorLogo` failure being
    // rethrown below (`error`); losing the rollback itself only strands
    // the uploaded R2 object, and must not replace the original failure.
    await ports.deleteUploadedObject(key).catch((cleanupError) => {
      console.error("Failed to roll back vendor logo object:", cleanupError);
    });
    throw error;
  }
}

const productionVendorLogoPorts: VendorLogoPorts<
  Database,
  ActorContext,
  VendorOut,
  VendorId
> = {
  contentTypeToExtension,
  deleteStoredObjects,
  deleteUploadedObject: deleteS3Object,
  fetchResponse: fetchExternalResponse,
  filenameForContentType,
  generateImageKey,
  getVendor: getVendorByShortcode,
  inspect: inspectImageFile,
  replaceVendorLogo,
  upload: uploadToS3,
};

/** Bind the logo workflow to real infrastructure or an explicit in-memory port. */
export function createVendorLogoService<TDatabase, TActor, TOutput, TEntityId>(
  ports: VendorLogoPorts<TDatabase, TActor, TOutput, TEntityId>,
) {
  return {
    fetchAndAttachVendorLogo: (
      database: TDatabase,
      id: VendorShortcode,
      actor: TActor,
    ) => fetchAndAttachVendorLogoWithPorts(database, id, actor, ports),
    fetchVendorLogoCandidate: (website: string) =>
      fetchVendorLogoCandidateWithPorts(website, ports),
  };
}

const productionVendorLogo = createVendorLogoService(productionVendorLogoPorts);
export const fetchAndAttachVendorLogo =
  productionVendorLogo.fetchAndAttachVendorLogo;
