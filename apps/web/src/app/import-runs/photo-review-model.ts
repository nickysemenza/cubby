import type {
  PhotoGroupProposal,
  PhotoGroupProposalGroup,
} from "@cubby/schemas/photo-import-run";

/**
 * Pure edits over a run's proposed groups. Each returns the `save` payload —
 * the rewritten groups plus any groupKeys that became empty — so one POST
 * applies a move, split or merge atomically and the server re-checks that
 * every image still sits in exactly one group.
 */
export type ProposalEdit = {
  groups: PhotoGroupProposalGroup[];
  removeGroupKeys: string[];
};

type ImageId = PhotoGroupProposalGroup["images"][number]["id"];

/** A proposal as the `save` action accepts it. A Product or Location deleted
 * after proposing falls back to "new product named after the group" and "no
 * inventory" so the reviewer can still edit the group. */
export function toGroupInput(
  proposal: PhotoGroupProposal,
): PhotoGroupProposalGroup {
  const product: PhotoGroupProposalGroup["product"] =
    proposal.product.kind === "create"
      ? proposal.product
      : proposal.product.existing
        ? { kind: "existing", existingId: proposal.product.existing.id }
        : { kind: "create", create: { name: proposal.groupKey } };
  const inventory = proposal.inventory;
  return {
    groupKey: proposal.groupKey,
    images: proposal.images,
    skip: proposal.skip,
    product,
    inventory: inventory?.locationId
      ? {
          locationId: inventory.locationId,
          quantity: inventory.quantity,
          ownershipMode: inventory.ownershipMode,
          ownerPartyId: inventory.ownerPartyId,
        }
      : undefined,
    evidence: proposal.evidence,
  };
}

const withoutImage = (
  group: PhotoGroupProposalGroup,
  imageId: ImageId,
): PhotoGroupProposalGroup => ({
  ...group,
  images: group.images.filter((image) => image.id !== imageId),
  skip: (group.skip ?? []).filter((image) => image.id !== imageId),
});

const isEmpty = (group: PhotoGroupProposalGroup) =>
  group.images.length === 0 && (group.skip ?? []).length === 0;

/** A groupKey no proposal in the run uses yet. */
function freshGroupKey(taken: readonly string[], base: string): string {
  const used = new Set(taken);
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Move one image into `toGroupKey` (or a brand-new group when it is null),
 * from whichever proposed group holds it — or from the unassigned pool. The
 * moved photo becomes the target's `item` shot unless it already has one.
 */
export function moveImage(
  proposals: readonly PhotoGroupProposal[],
  imageId: ImageId,
  toGroupKey: string | null,
): ProposalEdit {
  const source = proposals.find(
    (proposal) =>
      proposal.state === "proposed" &&
      [...proposal.images, ...proposal.skip].some(
        (image) => image.id === imageId,
      ),
  );
  const groups: PhotoGroupProposalGroup[] = [];
  const removeGroupKeys: string[] = [];
  if (source) {
    const trimmed = withoutImage(toGroupInput(source), imageId);
    if (isEmpty(trimmed)) removeGroupKeys.push(source.groupKey);
    else groups.push(trimmed);
  }
  if (toGroupKey === null) {
    const base = source?.groupKey ?? "group";
    const groupKey = freshGroupKey(
      proposals.map((proposal) => proposal.groupKey),
      base,
    );
    const sourceProduct = source ? toGroupInput(source).product : null;
    groups.push({
      groupKey,
      images: [{ id: imageId, purpose: "item" }],
      skip: [],
      product:
        sourceProduct?.kind === "create"
          ? {
              kind: "create",
              create: { name: `${sourceProduct.create.name} (split)` },
            }
          : { kind: "create", create: { name: groupKey } },
    });
    return { groups, removeGroupKeys };
  }
  const target = proposals.find((proposal) => proposal.groupKey === toGroupKey);
  if (!target) throw new Error(`Group ${toGroupKey} is not on this page`);
  const targetInput = withoutImage(toGroupInput(target), imageId);
  const hasItem = targetInput.images.some((image) => image.purpose === "item");
  groups.push({
    ...targetInput,
    images: [
      ...targetInput.images,
      { id: imageId, purpose: hasItem ? "label" : "item" },
    ],
  });
  return { groups, removeGroupKeys };
}

/** Fold every photo of `fromGroupKey` into `intoGroupKey`, dropping the emptied group. */
export function mergeGroups(
  proposals: readonly PhotoGroupProposal[],
  fromGroupKey: string,
  intoGroupKey: string,
): ProposalEdit {
  const from = proposals.find((proposal) => proposal.groupKey === fromGroupKey);
  const into = proposals.find((proposal) => proposal.groupKey === intoGroupKey);
  if (!from || !into) throw new Error("Both groups must be on this page");
  const target = toGroupInput(into);
  const hasItem = target.images.some((image) => image.purpose === "item");
  return {
    groups: [
      {
        ...target,
        images: [
          ...target.images,
          // The absorbed group's photos are supporting shots of the survivor.
          ...from.images.map((image) => ({
            id: image.id,
            purpose: hasItem ? ("label" as const) : image.purpose,
          })),
        ],
        skip: [...(target.skip ?? []), ...from.skip],
      },
    ],
    removeGroupKeys: [fromGroupKey],
  };
}
