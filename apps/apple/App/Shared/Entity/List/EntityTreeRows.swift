import CubbyKit
import SwiftUI

/// The leading indent and disclosure of a nested list line: one step per depth, then a chevron
/// for a node with children (a spacer keeps leaves aligned).
struct TreeDisclosure: View {
    let depth: Int
    let expandable: Bool
    let expanded: Bool
    let title: String
    let toggle: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var step: CGFloat = 16

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: CGFloat(depth) * step, height: 1)
            if expandable {
                Button(action: toggle) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(expanded ? "Collapse" : "Expand") \(title)")
            } else if depth > 0 {
                Color.clear.frame(width: 24, height: 1)
            }
        }
    }
}

/// Automatic siblings folded into one row (`list.tree.batch`): "16 Email imports" with its
/// members by state, the most urgent member state, member progress and the newest activity.
/// Expanding it pages the members.
struct EntityBatchRow: View {
    let descriptor: EntityDescriptor
    let batch: ListBatch
    var depth = 0
    var expanded = false
    let toggle: () -> Void

    var body: some View {
        let summary = ListBatchSummary(batch: batch, descriptor: descriptor)
        let kind = descriptor.presentation.listTree?.batchBy.flatMap(descriptor.field)?.optionRoster?
            .first { $0.value == batch.value }
        HStack(alignment: .top, spacing: FieldGuideTokens.Space.xs) {
            TreeDisclosure(
                depth: depth, expandable: true, expanded: expanded, title: summary.title, toggle: toggle)
            RecordListRow(
                title: summary.title, symbol: kind?.glyph?.sfSymbol ?? "square.stack.3d.up",
                showsFallbackImage: true
            ) {
                Text(summary.rollup)
            } rail: {
                if let latest = batch.latestActivity { DateDisplay(date: latest) }
            } supplement: {
                WrappingFactsLayout(spacing: FieldGuideTokens.Space.sm) {
                    if let lead = summary.lead { StateBadge(state: lead, trailing: .some(nil)) }
                    ProgressMeter(value: summary.progress, variant: .row)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([summary.title, summary.rollup, summary.progress.label].joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(expanded ? "Collapses the batch" : "Lists its members")
    }
}

/// A nested branch's paging and load state, under its parent.
struct TreeBranchStatusRow: View {
    let node: EntityTreeNode
    let model: GenericEntityListModel
    @ScaledMetric(relativeTo: .subheadline) private var step: CGFloat = 16

    var body: some View {
        HStack {
            Color.clear.frame(width: CGFloat(node.depth) * step + 24, height: 1)
            switch node.content {
            case .loading: LoadingIndicator(label: "Loading")
            case .failed(let parentID, let message):
                InlineLoadFailure(message: message) { await model.loadMoreChildren(of: parentID) }
            case .more(let parentID):
                Button("Show more") { Task { await model.loadMoreChildren(of: parentID) } }
                    .buttonStyle(.borderless)
            case .record, .batch: EmptyView()
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
    }
}

#Preview("Batch row", traits: .modifier(SignedInPreview())) {
    List {
        EntityBatchRow(
            descriptor: EntityCatalog[.run],
            batch: ListBatch(
                parentId: nil, value: "mail_import", count: 16, phases: ["active": 3, "finished": 13],
                states: ["running": 3, "completed": 12, "failed": 1], latestActivity: .now),
            toggle: {})
    }
    .listStyle(.plain)
}
