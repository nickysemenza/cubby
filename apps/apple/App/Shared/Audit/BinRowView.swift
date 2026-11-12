import CubbyKit
import SwiftUI

/// One expected row in a bin: what's there, then one statement of what (if anything) you've staged
/// about it. Every decision stays pending until the bin's Done commits them together. Tap opens the
/// full set of decisions, the context menu repeats them (the Mac's primary path), and swipe reaches
/// the two most common ones directly. Meant as a `List` row — the swipe actions depend on it.
struct BinRowView: View {
    let session: RecountSession
    let row: RecountRow
    let resolution: RecountResolution?
    let isDuplicate: Bool
    var binName: String? = nil

    @State private var showingDialog = false
    @State private var showingAdjust = false
    @State private var showingMoveTo = false

    var body: some View {
        Button {
            showingDialog = true
        } label: {
            rowContent
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows every count decision for this item")
        .accessibilityAction(named: "Adjust count") { showingAdjust = true }
        .accessibilityAction(named: "Move to…") { showingMoveTo = true }
        .accessibilityAction(named: "Move to Unknown") { Task { await session.relocateToUnknown(row.id) } }
        .swipeActions(edge: .leading) {
            Button("Verify") { session.stage(.verify, for: row.id) }
                .tint(FieldGuideTokens.positive)
        }
        .swipeActions(edge: .trailing) {
            Button("Remove", role: .destructive) { session.stage(.remove, for: row.id) }
        }
        .contextMenu { decisionButtons }
        .confirmationDialog(row.product.name, isPresented: $showingDialog, titleVisibility: .visible) {
            decisionButtons
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showingAdjust) {
            AdjustCountSheet(session: session, row: row, binName: binName)
        }
        .sheet(isPresented: $showingMoveTo) {
            BinMoveToSheet(session: session, id: row.id)
        }
    }

    @ViewBuilder
    private var decisionButtons: some View {
        Button("Verify") { session.stage(.verify, for: row.id) }
        Button("Adjust count…") { showingAdjust = true }
        Button("Remove", role: .destructive) { session.stage(.remove, for: row.id) }
        Button("Move to Unknown") { Task { await session.relocateToUnknown(row.id) } }
        Button("Move to…") { showingMoveTo = true }
        if resolution != nil {
            Button("Clear decision") { session.clearResolution(for: row.id) }
        }
    }

    private var rowContent: some View {
        HStack(alignment: .top, spacing: FieldGuideTokens.Space.md) {
            Thumb(url: row.product.coverImageURL, size: 48, symbol: "shippingbox")
            VStack(alignment: .leading, spacing: 2) {
                Text(row.product.name)
                    .font(.fieldGuideTitle)
                    .foregroundStyle(FieldGuideTokens.graphite)
                    .lineLimit(2)
                if let identityLine {
                    Text(identityLine)
                        .font(.fieldGuideLabel)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        .lineLimit(2)
                }
                quantityLine
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.sm)
        .frame(minHeight: FieldGuideTokens.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Brand, then the stocked-twice flag for a one-of-a-kind product, on one subordinate line so
    /// neither crowds the product name.
    private var identityLine: String? {
        let parts = [row.product.brandName, isDuplicate ? "One of a kind, stocked in several places" : nil]
            .compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// One quantity statement: the stored amount, the staged change and that it is pending. An
    /// untouched row prints only its stored amount, since Done verifies it.
    /// One wrapping `Text`, so a long move target flows onto a second line instead of truncating.
    private var quantityLine: Text {
        let stored = Text(quantityText).foregroundStyle(FieldGuideTokens.graphiteSecondary)
        guard let pending else { return stored.font(.fieldGuideData) }
        let symbol = Text(Image(systemName: pending.symbol)).foregroundStyle(pending.tone.color)
        let status = Text("· \(pending.label)").foregroundStyle(pending.tone.color)
        return Text("\(symbol) \(stored) \(status)").font(.fieldGuideData)
    }

    private var quantityText: String {
        let stored = Self.amountText(row.amount)
        if case .adjust(let amount) = resolution { return "\(stored) → \(Self.amountText(amount))" }
        return stored
    }

    private var pending: (label: String, symbol: String, tone: StatusChip.Tone)? {
        switch resolution {
        case nil: nil
        case .verify: ("Verify pending", "checkmark.circle", .positive)
        case .adjust: ("Count pending", "pencil.circle", .warning)
        case .remove: ("Removal pending", "minus.circle", .destructive)
        case .relocate(_, let name): ("Move to \(name) pending", "arrow.right.circle", .warning)
        }
    }

    static func amountText(_ amount: Amount) -> String {
        ValueFormat.amount(unit: amount.unit, value: amount.value)
    }
}

/// A location picker scoped to relocation: every stocked location except the bin being counted —
/// moving a row into the bin it is already expected in would just be Verify.
private struct BinMoveToSheet: View {
    let session: RecountSession
    let id: InventoryEntryCode
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var query = ""

    private var candidates: [(node: LocationTreeNode, depth: Int)] {
        let all = session.tree?.scopeCandidates() ?? []
        let currentBinID = session.currentBin?.id
        let scoped = all.filter { $0.node.id != currentBinID }
        guard !query.isEmpty else { return scoped }
        return scoped.filter {
            $0.node.name.localizedCaseInsensitiveContains(query)
                || $0.node.id.rawValue.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List(candidates, id: \.node.id) { entry in
                Button {
                    session.stage(.relocate(entry.node.id, name: entry.node.name), for: id)
                    dismiss()
                } label: {
                    HStack(spacing: FieldGuideTokens.Space.md) {
                        Thumb(
                            url: entry.node.coverImageURL, size: 40,
                            symbol: EntityCatalog[.location].sfSymbol)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.node.name)
                                .font(.fieldGuideBody)
                                .foregroundStyle(FieldGuideTokens.graphite)
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                .fixedSize(horizontal: false, vertical: true)
                            if dynamicTypeSize.isAccessibilitySize {
                                Text(entry.node.id.rawValue)
                                    .font(.fieldGuideCode)
                                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                            }
                        }
                        .layoutPriority(1)
                        Spacer(minLength: FieldGuideTokens.Space.sm)
                        if !dynamicTypeSize.isAccessibilitySize {
                            Text(entry.node.id.rawValue)
                                .font(.fieldGuideCode)
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                    }
                    .padding(.leading, CGFloat(entry.depth) * 14)
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
            .fieldGuideScreen()
            .searchable(text: $query, prompt: "Filter locations")
            .navigationTitle("Move to")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .nativeSheet(.picker)
    }
}

#Preview("Bin row — expected") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    List {
        BinRowView(
            session: RecountSession(service: appModel.client),
            row: AuditPreviewData.sampleRow,
            resolution: nil,
            isDuplicate: false
        )
    }
    .listStyle(.plain)
}

#Preview("Bin row — resolved") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    List {
        BinRowView(
            session: RecountSession(service: appModel.client),
            row: AuditPreviewData.sampleRow,
            resolution: .adjust(Amount(value: 2, unit: "each")),
            isDuplicate: true
        )
        BinRowView(
            session: RecountSession(service: appModel.client),
            row: AuditPreviewData.sampleRow,
            resolution: .relocate(LocationCode("LOC-1002"), name: "Hall closet"),
            isDuplicate: false
        )
    }
    .listStyle(.plain)
}
