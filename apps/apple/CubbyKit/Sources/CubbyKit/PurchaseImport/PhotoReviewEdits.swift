import Foundation

/// Retains proposal evidence and review history when changing a review answer.
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

    public static func removingProductChange(group: PhotoGroupProposal, field: String) throws -> JSONValue {
        var body = try retainedGroup(group)
        var review = body["review"]?.objectValue ?? [:]
        var changes = review["productChanges"]?.objectValue ?? [:]
        changes[field] = nil
        review["productChanges"] = changes.isEmpty ? nil : .object(changes)
        body["review"] = .object(review)
        return .object(body)
    }

    public static func createAfterRejection(group: PhotoGroupProposal) throws -> JSONValue {
        var body = try retainedGroup(group)
        let name = group.review?.observedName ?? productName(group)
        body["product"] = ["kind": "create", "create": ["name": .string(name)]]
        var review = body["review"]?.objectValue ?? [:]
        review["observedName"] = .string(name)
        review["productChanges"] = nil
        body["review"] = .object(review)
        if var inventory = body["inventory"]?.objectValue {
            inventory["existingEntryId"] = nil
            inventory["mode"] = "create"
            body["inventory"] = .object(inventory)
        }
        return .object(body)
    }

    private static func retainedGroup(_ group: PhotoGroupProposal) throws -> [String: JSONValue] {
        var body =
            try ownership(
                group: group, locationID: group.inventory?.locationId?.rawValue,
                quantity: group.inventory?.quantity ?? 1,
                stockIntent: group.review?.stockIntent.rawValue
            ).objectValue ?? [:]
        if let inventory = group.inventory {
            var retained = try JSONValue(encoding: inventory).objectValue ?? [:]
            retained["locationName"] = nil
            if inventory.ownershipMode == .explicit {
                retained["ownerPartyId"] = inventory.ownerPartyId.map(JSONValue.string) ?? .null
            }
            body["inventory"] = .object(retained)
        }
        return body
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
