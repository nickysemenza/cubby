import Foundation

/// A response belongs to one request in one mounted editor, even when two responses pick the same value.
public struct FieldSuggestionReviewScope: Sendable {
    public struct Ticket: Sendable, Equatable {
        fileprivate let editor: UUID
        fileprivate let generation: Int
    }

    private let editor = UUID()
    private var generation = 0
    private var active = true

    public init() {}

    public mutating func beginRequest() -> Ticket {
        generation += 1
        return Ticket(editor: editor, generation: generation)
    }

    public func accepts(_ ticket: Ticket) -> Bool {
        active && ticket.editor == editor && ticket.generation == generation
    }

    public mutating func invalidate() {
        active = false
        generation += 1
    }
}
