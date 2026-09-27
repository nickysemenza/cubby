import CubbyKit
import SwiftUI

/// Several existing products carry the same scanned code (two pack sizes of one barcode, say).
/// Shared by `SearchView`'s inline code panel and `ScanLookupSheet`.
struct ProductMatchesPanel: View {
    let rows: [EntityRow]
    /// The GTIN-14 the code is stored as.
    let code: String
    let onSelect: (EntityRow) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("\(rows.count) products carry \(code)")
            Panel(padding: 0, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { PanelDivider(inset: FieldGuideTokens.Space.lg + 56) }
                    Button {
                        onSelect(row)
                    } label: {
                        HStack(spacing: FieldGuideTokens.Space.md) {
                            Thumb(url: row.imageURL, size: 56, symbol: "shippingbox")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(FieldGuideTokens.graphite)
                                    .lineLimit(2)
                                if let subtitle = row.subtitle, !subtitle.isEmpty {
                                    Text(subtitle)
                                        .font(.fieldGuideBody)
                                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: FieldGuideTokens.Space.sm)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        }
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .padding(.vertical, FieldGuideTokens.Space.md)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// A well-formed barcode or ISBN no product carries yet. Offers to create one (seeded from the
/// upstream catalog answer when there is one) or to stock it at a location without creating
/// anything — the same two exits the web `/scan` page offers.
struct UnknownCodePanel: View {
    /// The GTIN-14 the code is stored as.
    let code: String
    let catalog: UpcLookupOutput?
    var creating = false
    let onCreate: () -> Void
    let onStock: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("No product carries \(code)")
            Panel {
                if let catalog {
                    HStack(spacing: FieldGuideTokens.Space.md) {
                        Thumb(url: catalog.imageURL, size: 56, symbol: "shippingbox")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(catalog.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(FieldGuideTokens.graphite)
                                .lineLimit(2)
                            if let manufacturer = catalog.manufacturerOrBrand {
                                Text(manufacturer)
                                    .font(.fieldGuideBody)
                                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: FieldGuideTokens.Space.sm)
                    }
                } else {
                    Text("Cubby's catalog doesn't recognize this code either.")
                        .font(.fieldGuideBody)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                HStack(spacing: FieldGuideTokens.Space.sm) {
                    Button("Create product", action: onCreate)
                        .buttonStyle(.borderedProminent)
                        .tint(FieldGuideTokens.interaction)
                        .disabled(creating)
                    Button("Stock it at a location", action: onStock)
                        .buttonStyle(.bordered)
                        .disabled(creating)
                    if creating {
                        LoadingIndicator(label: "Creating product").controlSize(.small)
                    }
                }
            }
        }
    }
}

#Preview("Product matches") {
    ScrollView {
        ProductMatchesPanel(rows: PreviewFixtures.sampleRows, code: "00012345678905") { _ in }
            .padding(FieldGuideTokens.Space.lg)
    }
    .background(FieldGuideTokens.canvas)
}

#Preview("Unknown code") {
    ScrollView {
        UnknownCodePanel(
            code: "00012345678905",
            catalog: UpcLookupOutput(
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
