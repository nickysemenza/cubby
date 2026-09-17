import Foundation

/// The create-editor prefill for the Photos "New ‹entity›" destination: the already-uploaded
/// selection as `pendingImageIds`, plus the selection's earliest capture date for every date field
/// the catalog defaults to today's date (`FieldDescriptor.initial == "today"`) — so a batch of
/// photos taken last week lands on last week's date rather than today's. An entity with no such
/// field (most of them) gets images only; `pendingImageIds` is always present, even for an empty
/// selection, so a caller never has to special-case zero photos.
public func photoCreatePrefill(
    for descriptor: EntityDescriptor, imageIDs: [ImageCode], earliestCapturedAt: Date?
) -> [String: JSONValue] {
    var prefill: [String: JSONValue] = [
        "pendingImageIds": .array(imageIDs.map { .string($0.rawValue) })
    ]
    if let earliestCapturedAt {
        for field in descriptor.fields where field.kind == .date && field.initial == "today" {
            prefill[field.key] = .string(PlainDate(earliestCapturedAt).rawValue)
        }
    }
    return prefill
}
