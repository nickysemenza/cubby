import Foundation

/// The boundary between generated OpenAPI types and the domain types in `Models.swift`.
///
/// This is the only file allowed to spell a `Components.Schemas.*` name. The generated names are
/// positional for most nested schemas (`OutputSchema46`), so everything here reaches values by
/// property and lets inference carry the types; a regeneration that renames a nested schema
/// only ever breaks this file.

typealias ScanBody = Components.Schemas.InputInventory_scanAtLocationBody
typealias ScanResponse = Components.Schemas.OutputInventory_scanAtLocationResponse200
typealias ResolveBody = Components.Schemas.InputInventory_resolveScanStraysBody
typealias ResolveResponse = Components.Schemas.OutputInventory_resolveScanStraysResponse200
typealias FindByUPCBody = Components.Schemas.InputProduct_findOrCreateByUPCBody
typealias FindByUPCResponse = Components.Schemas.OutputProduct_findOrCreateByUPCResponse200
typealias ProductGetResponse = Components.Schemas.OutputResources_product_getResponse200
typealias InventoryCreateBody = Components.Schemas.InputResources_inventory_createBody
typealias AskBody = Components.Schemas.InputAgent_askBody
typealias AskResponse = Components.Schemas.OutputAgent_askResponse200

extension ScanBody {
    init(location: LocationCode, code: ScanCode) {
        let codePayload: CodePayload
        switch code {
        case .barcode(let value):
            codePayload = CodePayload(value1: .case1(.init(kind: .barcode, value: value)), value2: nil)
        case .isbn(let value):
            codePayload = CodePayload(value1: .case2(.init(kind: .isbn, value: value)), value2: nil)
        case .product(let product):
            codePayload = CodePayload(value1: nil, value2: .init(kind: .product, value: product.rawValue))
        }
        self.init(locationId: .init(value1: location.rawValue), code: codePayload)
    }
}

extension ScanResult {
    init(_ response: ScanResponse) {
        let data = response.data
        outcome = ScanOutcome(rawValue: data.outcome.rawValue) ?? .queued
        product = ScannedProduct(
            id: ProductCode(data.product.id),
            name: data.product.name,
            created: data.product.created,
            manufacturer: data.product.manufacturer,
            hasPrice: data.product.hasPrice
        )
        strays = data.strays.map { stray in
            Stray(
                entryId: InventoryEntryCode(stray.entryId),
                locationId: LocationCode(stray.location.id),
                locationName: stray.location.name,
                ambiguousQuantity: stray.ambiguousQuantity
            )
        }
    }
}

extension ResolveBody {
    init(target: LocationCode, moves: [StrayMove]) {
        self.init(
            targetLocationId: target.rawValue,
            moves: moves.map { move in
                MovesPayloadPayload(
                    entryId: move.entryId.rawValue,
                    quantity: move.quantity.map { MovesPayloadPayload.QuantityPayload(value1: .init($0)) }
                )
            }
        )
    }
}

/// An inventory amount on the wire is `{value, unit, upperValue?}`; "each" is the unit every
/// scanned or counted row uses, so the count-based helpers hard-code it.
extension Components.Schemas.InputSchema24 {
    init(_ value: Double, unit: String = "each") {
        self.init(value: value, unit: unit, upperValue: nil)
    }
}

extension StrayResolution {
    init(_ response: ResolveResponse) {
        moved = response.data.moved
        skipped = response.data.skipped.map {
            Skipped(entryId: InventoryEntryCode($0.entryId), reason: $0.reason.rawValue, message: $0.message)
        }
    }
}

extension FoundProduct {
    init(_ response: FindByUPCResponse) {
        let p = response.data.product
        product = ProductSummary(
            id: ProductCode(p.id),
            name: p.name,
            manufacturer: p.manufacturer,
            coverImageURL: p.coverImageUrl.flatMap(URL.init(string:))
        )
        created = response.data.created
    }
}

extension ProductSummary {
    init(_ response: ProductGetResponse) {
        let p = response.data
        self.init(
            id: ProductCode(p.id),
            name: p.name,
            manufacturer: p.manufacturer,
            coverImageURL: p.coverImageUrl.flatMap(URL.init(string:))
        )
    }
}

extension AgentAnswer {
    init(_ response: AskResponse) {
        answer = response.data.answer
        sources = (response.data.sources ?? []).map {
            Source(entityType: $0.entityType.rawValue, id: $0.id, name: $0.name, detail: $0.detail)
        }
    }
}
