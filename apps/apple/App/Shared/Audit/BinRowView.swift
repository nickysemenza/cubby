import CubbyKit
import SwiftUI

/// One expected row in a bin: what's there, what (if anything) you've staged about it. Tap opens
/// the full set of decisions; swipe reaches the two most common ones directly. Meant as a `List`
/// row — the swipe actions depend on it.
struct BinRowView: View {
    let session: RecountSession
    let row: RecountRow
    let resolution: RecountResolution?
    let isDuplicate: Bool

    @State private var showingDialog = false
    @State private var showingAdjust = false
    @State private var showingMoveTo = false

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            Thumb(url: row.product.coverImageURL, size: 48, symbol: "shippingbox")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PorcelainTokens.Space.xs) {
                    Text(row.product.name)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .lineLimit(2)
                    if isDuplicate {
                        Eyebrow("Duplicate")
                    }
                }
                if let manufacturer = row.product.manufacturer {
                    Text(manufacturer)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
                Text(Self.amountText(row.amount))
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            StatusChip(text: statusLabel, tone: statusTone)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .contentShape(Rectangle())
        .onTapGesture { showingDialog = true }
        .swipeActions(edge: .leading) {
            Button("Verify") { session.stage(.verify, for: row.id) }
                .tint(PorcelainTokens.positive)
        }
        .swipeActions(edge: .trailing) {
            Button("Remove", role: .destructive) { session.stage(.remove, for: row.id) }
        }
        .confirmationDialog(row.product.name, isPresented: $showingDialog, titleVisibility: .visible) {
            Button("Verify") { session.stage(.verify, for: row.id) }
            Button("Adjust count…") { showingAdjust = true }
            Button("Remove", role: .destructive) { session.stage(.remove, for: row.id) }
            Button("Move to Unknown") { Task { await session.relocateToUnknown(row.id) } }
            Button("Move to…") { showingMoveTo = true }
            if resolution != nil {
                Button("Clear") { session.clearResolution(for: row.id) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showingAdjust) {
            AdjustCountSheet(session: session, id: row.id, amount: row.amount)
        }
        .sheet(isPresented: $showingMoveTo) {
            BinMoveToSheet(session: session, id: row.id)
        }
    }

    private var statusLabel: String {
        switch resolution {
        case nil: "Expected"
        case .verify: "Verified"
        case .adjust(let amount): "Adjusted to \(Self.amountText(amount))"
        case .remove: "Remove"
        case .relocate(_, let name): "Move to \(name)"
        }
    }

    private var statusTone: StatusChip.Tone {
        switch resolution {
        case nil: .neutral
        case .verify: .positive
        case .adjust: .warning
        case .remove: .destructive
        case .relocate: .warning
        }
    }

    private static func amountText(_ amount: Amount) -> String {
        let value =
            amount.value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(amount.value)) : String(amount.value)
        return "\(value) \(amount.unit)"
    }
}

/// A location picker scoped to relocation: every stocked location except the bin being counted —
/// moving a row into the bin it is already expected in would just be Verify.
private struct BinMoveToSheet: View {
    let session: RecountSession
    let id: InventoryEntryCode
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var candidates: [(node: LocationTreeNode, depth: Int)] {
        let all = session.tree?.scopeCandidates() ?? []
        let currentBinID = session.currentBin?.id
        let scoped = all.filter { $0.node.id != currentBinID }
        guard !query.isEmpty else { return scoped }
        return scoped.filter { $0.node.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List(candidates, id: \.node.id) { entry in
                Button {
                    session.stage(.relocate(entry.node.id, name: entry.node.name), for: id)
                    dismiss()
                } label: {
                    HStack(spacing: PorcelainTokens.Space.md) {
                        Text(entry.node.name)
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.graphite)
                            .lineLimit(1)
                        Spacer(minLength: PorcelainTokens.Space.sm)
                        Text(entry.node.id.rawValue)
                            .font(.porcelainCode)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                    .padding(.leading, CGFloat(entry.depth) * 14)
                    .frame(minHeight: PorcelainTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .porcelainListRow()
            }
            .listStyle(.plain)
            .porcelainScreen()
            .searchable(text: $query, prompt: "Filter locations")
            .navigationTitle("Move to")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 360, minHeight: 420)
        #endif
    }
}

#Preview("Bin row — expected") {
    List {
        BinRowView(
            session: RecountSession(service: PreviewFixtures.signedInModel().client),
            row: AuditPreviewData.sampleRow,
            resolution: nil,
            isDuplicate: false
        )
    }
    .listStyle(.plain)
}

#Preview("Bin row — resolved") {
    List {
        BinRowView(
            session: RecountSession(service: PreviewFixtures.signedInModel().client),
            row: AuditPreviewData.sampleRow,
            resolution: .adjust(Amount(value: 2, unit: "each")),
            isDuplicate: true
        )
    }
    .listStyle(.plain)
}
