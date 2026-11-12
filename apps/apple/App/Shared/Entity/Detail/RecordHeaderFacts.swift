import CubbyKit
import SwiftUI

/// The record header under the title, from the declarations: progress, the declared
/// `detail.lines`, the AI summary, what waits on a member (`detail.side.needs`), and the kind's
/// explanation folded behind one line. Each field shows here once; later sections omit it.
struct RecordHeaderFacts: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    private var presentation: EntityPresentation { descriptor.presentation }

    var hasContent: Bool {
        descriptor.recordProgress(in: row.raw) != nil || !lines.isEmpty || aiSummary != nil
            || !needs.isEmpty || kindExplanation != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let progress = descriptor.recordProgress(in: row.raw) {
                ProgressMeter(
                    value: progress, note: progressNote,
                    paused: descriptor.recordState(in: row.raw)?.role == .paused)
            }
            ForEach(lines, id: \.field.key) { line in
                LabeledContent {
                    lineValue(line.field, text: line.text)
                } label: {
                    Text(line.label).font(.fieldGuideLabel).foregroundStyle(.secondary)
                }
                .labeledContentStyle(HeaderLineStyle())
            }
            if let aiSummary {
                VStack(alignment: .leading, spacing: 2) {
                    Label("AI-written summary", systemImage: "sparkles")
                        .font(.fieldGuideLabel).foregroundStyle(.secondary)
                    Text(aiSummary).font(.subheadline).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let field = presentation.detailNeeds.flatMap(descriptor.field), !needs.isEmpty {
                DetailDisplayRows(label: field.label, rows: needs)
            }
            if let (option, explanation) = kindExplanation {
                KindExplanation(option: option, explanation: explanation)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct Line {
        let label: String
        let field: FieldDescriptor
        let text: String
    }

    private var lines: [Line] {
        presentation.detailLines.compactMap { line in
            guard let field = descriptor.field(line.field), let text = text(line.field) else { return nil }
            return Line(label: line.label, field: field, text: text)
        }
    }

    private func text(_ key: String) -> String? {
        guard let field = descriptor.field(key),
            let value = EntityFieldValue.text(in: row.raw, field: field, surface: "detail"),
            EntityRowPresentation.isVisibleListFactValue(value)
        else { return nil }
        return value
    }

    /// The progress note, unless a header line already shows that field.
    private var progressNote: String? {
        presentation.recordProgress?.note.flatMap { key in
            presentation.detailLines.contains { $0.field == key } ? nil : text(key)
        }
    }

    private var aiSummary: String? { presentation.detailAISummary.flatMap(text) }

    private var needs: [DetailDisplayRow] {
        presentation.detailNeeds.flatMap(descriptor.field)?.detailItems(in: row.raw) ?? []
    }

    private var kindExplanation: (LabeledOption, OptionExplanation)? {
        guard let option = descriptor.recordKind(in: row.raw), let explanation = option.explanation else {
            return nil
        }
        return (option, explanation)
    }

    /// A line naming a record stays a link to it.
    @ViewBuilder
    private func lineValue(_ field: FieldDescriptor, text: String) -> some View {
        let value = field.surfaceValue(in: row.raw, surface: "detail")
        if let reference = EntityFieldValue.reference(in: row.raw, field: field) {
            NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                Text(text).foregroundStyle(.tint)
            }
            .buttonStyle(.plain)
        } else if let entity = value?["entity"]?.stringValue.flatMap(EntityKey.init(rawValue:)),
            let id = value?["id"]?.stringValue
        {
            NavigationLink(value: Route.entityDetail(entity, id: id)) {
                Text(text).foregroundStyle(.tint).multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
        } else {
            Text(text).textSelection(.enabled)
        }
    }
}

/// A header line: a short label over (phone) or beside (wide) its value.
private struct HeaderLineStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                configuration.label.frame(width: 72, alignment: .leading)
                configuration.content.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 1) {
                configuration.label
                configuration.content.font(.subheadline)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Record header facts", traits: .modifier(SignedInPreview())) {
    List {
        RecordHeaderFacts(
            descriptor: EntityCatalog[.run],
            row: EntityRow(
                id: "RUN-4K7M", title: "Order Emails from a synthetic store", subtitle: nil, imageURL: nil,
                raw: [
                    "id": "RUN-4K7M", "purpose": "mail_import", "displayStatus": "running",
                    "whyLine": [
                        "entity": .null, "id": .null, "title": "You started it", "subtitle": .null,
                        "trailing": .null,
                    ],
                    "outcomeLine": "4 imported, 1 skipped",
                    "progressMeter": [
                        "done": 5, "failed": 1, "active": 2, "stalled": 0, "queued": 4, "total": 12,
                        "unit": "emails",
                    ],
                ]))
    }
}
