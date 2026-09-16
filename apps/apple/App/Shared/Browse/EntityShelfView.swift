import CubbyKit
import SwiftUI

/// The declared `shelf` list view: a grid of cover images with the title and the catalog's
/// `shelfSubtitle` fields beneath. A row without a cover shows the entity's glyph.
struct EntityShelfView: View {
    let descriptor: EntityDescriptor
    let rows: [EntityRow]

    private let columns = [GridItem(.adaptive(minimum: 132, maximum: 200), spacing: PorcelainTokens.Space.md)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: PorcelainTokens.Space.lg) {
            ForEach(rows) { row in
                NavigationLink(value: Route.entityDetail(descriptor.key, id: row.id)) {
                    VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                        Thumb(url: row.imageURL, size: 132, symbol: descriptor.sfSymbol)
                            .frame(maxWidth: .infinity)
                            .aspectRatio(1, contentMode: .fit)
                        Text(row.title)
                            .font(.porcelainLabel.weight(.semibold))
                            .foregroundStyle(PorcelainTokens.graphite)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let subtitle = subtitle(for: row) {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("browse.\(descriptor.key.rawValue).shelf.\(row.id)")
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.sm)
    }

    private func subtitle(for row: EntityRow) -> String? {
        let parts = descriptor.presentation.shelfSubtitle.compactMap { key -> String? in
            guard let field = descriptor.field(key) else { return nil }
            return EntityFieldValue.text(row.raw[key], field: field)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

#Preview("Shelf") {
    NavigationStack {
        ScrollView {
            EntityShelfView(descriptor: EntityCatalog[.product], rows: PreviewFixtures.sampleRows)
        }
        .porcelainScreen()
        .navigationTitle("Products")
    }
}
