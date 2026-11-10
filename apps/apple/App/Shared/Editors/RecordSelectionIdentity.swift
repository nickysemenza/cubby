import CubbyKit
import SwiftUI

/// Stored choices resolve through the ordinary detail read in both fields and picker sheets.
/// Failed or missing reads never replace the saved value or expose its identifier as a name.
@MainActor
@Observable
final class RecordSelectionResolver {
    private(set) var rows: [String: EntityRow] = [:]
    private(set) var missing: Set<String> = []
    private(set) var errors: [String: String] = [:]

    func title(_ id: String, descriptor: EntityDescriptor) -> String {
        if missing.contains(id) { return "\(descriptor.singular) no longer available" }
        if errors[id] != nil { return "Unavailable \(descriptor.singular)" }
        guard let row = rows[id], row.title != id,
            !row.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return "Unnamed \(descriptor.singular)"
        }
        return row.title
    }

    func remember(_ row: EntityRow) {
        rows[row.id] = row
        missing.remove(row.id)
        errors[row.id] = nil
    }

    func resolve(_ ids: [String], descriptor: EntityDescriptor, client: CubbyClient, retry: Bool = false)
        async
    {
        for id in ids {
            guard !Task.isCancelled else { return }
            if !retry && (rows[id] != nil || missing.contains(id) || errors[id] != nil) { continue }
            errors[id] = nil
            do {
                let row = try await client.row(descriptor, id: id)
                try Task.checkCancellation()
                if let row { remember(row) } else { missing.insert(id) }
            } catch {
                guard !Task.isCancelled else { return }
                Diagnostics.report(error, context: "picker.selection")
                errors[id] = error.userMessage
            }
        }
    }
}

struct RecordSelectionIdentity: View {
    let id: String
    let descriptor: EntityDescriptor
    let resolver: RecordSelectionResolver
    let retry: @MainActor () async -> Void
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        if let row = resolver.rows[id] {
            HStack(spacing: FieldGuideTokens.Space.sm) {
                Thumb(
                    url: row.imageURL, size: RecordRowMetrics.thumbnail,
                    symbol: descriptor.recordSymbol(in: row), emoji: descriptor.recordEmoji(in: row))
                Text(resolver.title(id, descriptor: descriptor))
                    .lineLimit(textSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if resolver.missing.contains(id) {
            Label("\(descriptor.singular) no longer available", systemImage: "questionmark.folder")
                .foregroundStyle(.secondary)
        } else if let message = resolver.errors[id] {
            InlineLoadFailure(message: message, retry: retry)
        } else {
            LoadingIndicator(label: "Loading selection")
        }
    }
}

#Preview("Loading stored selection") {
    RecordSelectionIdentity(
        id: "synthetic-choice", descriptor: EntityCatalog[.vendor], resolver: RecordSelectionResolver(),
        retry: {})
}
