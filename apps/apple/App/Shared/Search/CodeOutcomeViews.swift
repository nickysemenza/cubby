import CubbyKit
import SwiftUI

/// Several existing products carry the same scanned code (two pack sizes of one barcode, say).
/// Each candidate draws the shared record row, so its placement, maker and rail facts tell the
/// look-alikes apart; the code stays visible as secondary technical context.
/// Shared by `SearchView`'s inline code panel and `ScanLookupSheet`.
struct ProductMatchesPanel: View {
    let rows: [EntityRow]
    /// The GTIN-14 the code is stored as.
    let code: String
    let onSelect: (EntityRow) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow("\(rows.count) products carry this code")
                Text(code).font(.fieldGuideCode).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Panel(padding: 0, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 {
                        PanelDivider(inset: FieldGuideTokens.Space.md + RecordRowMetrics.thumbnail)
                    }
                    Button {
                        onSelect(row)
                    } label: {
                        HStack(spacing: FieldGuideTokens.Space.sm) {
                            EntityRowView(key: .product, row: row)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("code.match.\(row.id)")
                }
            }
        }
    }
}

/// A well-formed barcode or ISBN no product carries yet. Two different outcomes, each said in
/// words: create a Product with this code now (seeded from the upstream catalog answer when there
/// is one), or open Capture with the code filled in so it is added at a chosen location. The
/// choices stack, so long labels and accessibility sizes never squeeze them side by side.
struct UnknownCodePanel: View {
    /// The GTIN-14 the code is stored as.
    let code: String
    let catalog: UpcLookupOutputValue?
    var creating = false
    let onCreate: () -> Void
    let onStock: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Eyebrow("No product carries this code")
                Text(code).font(.fieldGuideCode).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Panel {
                if let catalog {
                    RecordListRow(
                        title: catalog.name, imageURL: catalog.imageURL, symbol: "shippingbox"
                    ) {
                        Text(
                            [catalog.manufacturerOrBrand, "From the barcode catalog"].compactMap { $0 }
                                .joined(separator: " · "))
                    } rail: {
                        EmptyView()
                    } supplement: {
                        EmptyView()
                    }
                    .accessibilityElement(children: .combine)
                } else {
                    Text("The barcode catalog doesn't recognize this code either.")
                        .font(.fieldGuideBody)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                choice(
                    "Create product",
                    detail: catalog == nil
                        ? "Adds a new product with this code."
                        : "Adds a new product with this code, named from the catalog.",
                    prominent: true, action: onCreate
                )
                .accessibilityIdentifier("code.unknown.create")
                choice(
                    "Stock at a location",
                    detail: "Opens Capture with this code filled in, to add where it is.",
                    prominent: false, action: onStock
                )
                .accessibilityIdentifier("code.unknown.stock")
                if creating {
                    LoadingIndicator(label: "Creating product").controlSize(.small)
                }
            }
        }
    }

    private func choice(_ title: String, detail: String, prominent: Bool, action: @escaping () -> Void)
        -> some View
    {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if prominent {
                Button(title, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(FieldGuideTokens.interaction)
            } else {
                Button(title, action: action)
                    .buttonStyle(.bordered)
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .disabled(creating)
    }
}

#Preview("Product matches") {
    ScrollView {
        ProductMatchesPanel(rows: PreviewFixtures.sampleRows, code: "00012345678905") { _ in }
            .padding(FieldGuideTokens.Space.lg)
    }
    .background(FieldGuideTokens.canvas)
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Unknown code") {
    ScrollView {
        UnknownCodePanel(
            code: "00012345678905",
            catalog: UpcLookupOutputValue(
                upc: "00012345678905", name: "LED bulbs, 4-pack", manufacturer: "Acme", brand: nil,
                category: nil,
                description: nil, priceDollars: nil, imageUrl: nil, source: .upcitemdb, cached: false),
            onCreate: {}, onStock: {}
        )
        .padding(FieldGuideTokens.Space.lg)
    }
    .background(FieldGuideTokens.canvas)
}

#Preview("Unknown code, no catalog hit") {
    ScrollView {
        UnknownCodePanel(code: "00012345678905", catalog: nil, onCreate: {}, onStock: {})
            .padding(FieldGuideTokens.Space.lg)
    }
    .background(FieldGuideTokens.canvas)
}
