import Foundation

/// Retains proposal evidence and review history when changing the inventory answer.
public enum PhotoReviewEdits {
    public static func ownership(
        group: PhotoGroupProposal, locationID: String?, quantity: Int, stockIntent: String? = nil
    ) throws -> JSONValue {
        var body: [String: JSONValue] = [
            "groupKey": .string(group.groupKey),
            "images": try JSONValue(encoding: group.images),
            "skip": try JSONValue(encoding: group.skip),
        ]
        switch group.product {
        case .create(let product):
            body["product"] = ["kind": "create", "create": try JSONValue(encoding: product.create)]
        case .existing(let product):
            guard let selected = product.existing else { throw EditError.missingProduct }
            body["product"] = ["kind": "existing", "existingId": .string(selected.id.rawValue)]
        }
        if let evidence = group.evidence { body["evidence"] = .string(evidence) }
        var review =
            try group.review.flatMap { try JSONValue(encoding: $0).objectValue } ?? [
                "observedName": .string(productName(group)), "unresolvedReason": .null,
            ]
        review["unresolvedReason"] = group.review?.unresolvedReason.map(JSONValue.string) ?? .null
        if let concerns = group.review?.resolvedConcerns {
            review["resolvedConcerns"] = .array(
                try concerns.map { concern in
                    var item = try JSONValue(encoding: concern).objectValue ?? [:]
                    item["reply"] = concern.reply.map(JSONValue.string) ?? .null
                    return .object(item)
                })
        }
        review["stockIntent"] = .string(stockIntent ?? (locationID == nil ? "evidence" : "receive"))
        body["review"] = .object(review)
        if let locationID {
            var inventory = try group.inventory.flatMap { try JSONValue(encoding: $0).objectValue } ?? [:]
            inventory["locationName"] = nil
            inventory["locationId"] = .string(locationID)
            inventory["quantity"] = .number(Double(quantity))
            if group.inventory?.locationId?.rawValue != locationID {
                inventory["existingEntryId"] = nil
                inventory["mode"] = "create"
            }
            if group.inventory?.ownershipMode == .explicit {
                inventory["ownerPartyId"] =
                    group.inventory?.ownerPartyId.map(JSONValue.string) ?? .null
            }
            body["inventory"] = .object(inventory)
        }
        return .object(body)
    }

    private static func productName(_ group: PhotoGroupProposal) -> String {
        switch group.product {
        case .create(let product): product.create.name
        case .existing(let product): product.existing?.name ?? "Product"
        }
    }

    private enum EditError: String, LocalizedError {
        case missingProduct = "Choose a Product before saving inventory."
        var errorDescription: String? { rawValue }
    }
}
