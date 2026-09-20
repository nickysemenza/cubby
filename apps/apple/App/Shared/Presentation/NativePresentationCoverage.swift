import CubbyKit

/// The native implementation boundary for manifest-declared presentation names.
/// A non-nil reason is intentional: callers must surface it instead of silently dropping content.
enum NativePresentationCoverage {
    static let supportedControlRenderers: Set<String> = [
        "amount", "entity-multi-select", "entity-select", "money", "tag-list", "url", "vendor-name",
    ]
    static let supportedListRenderers: Set<String> = []
    static let supportedDetailRenderers: Set<String> = []
    static let supportedDetailSlots: Set<String> = ["nutrition"]

    static func unsupportedControl(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.controlRenderer else { return nil }
        return supportedControlRenderers.contains(renderer) ? nil : renderer
    }

    static func unsupportedDetail(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.detailRenderer else { return nil }
        return supportedDetailRenderers.contains(renderer) ? nil : renderer
    }

    static func unsupportedSlot(_ slot: String) -> String? {
        supportedDetailSlots.contains(slot) ? nil : slot
    }
}
