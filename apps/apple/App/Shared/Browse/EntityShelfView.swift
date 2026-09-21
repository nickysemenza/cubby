import CubbyKit
import SwiftUI

extension ListPresentationChoice {
    var symbol: String {
        switch self {
        case .list: "list.bullet"
        case .cards: "square.grid.2x2"
        case .compact: "square.grid.3x3"
        }
    }
}

/// A manifest-backed card grid. The same rows that drive List drive both card densities, so
/// filters, searches, paging, refreshes, and server-resolved display images stay in one pipeline.
struct EntityShelfView: View {
    let descriptor: EntityDescriptor
    let rows: [EntityRow]
    var density: ListPresentationChoice = .cards
    var section: AppSection = .browse
    var subtitleOverride: ((EntityRow) -> String?)? = nil

    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var columns: [GridItem] {
        [
            GridItem(
                .adaptive(minimum: minimumWidth, maximum: maximumWidth),
                spacing: gridSpacing,
                alignment: .top)
        ]
    }

    private var minimumWidth: CGFloat {
        if dynamicTypeSize.isAccessibilitySize {
            return density == .compact ? 144 : 200
        }
        if horizontalSizeClass == .compact {
            return density == .compact ? 96 : 152
        }
        return density == .compact ? 88 : 176
    }

    private var maximumWidth: CGFloat {
        if dynamicTypeSize.isAccessibilitySize {
            return density == .compact ? 220 : 280
        }
        if horizontalSizeClass == .compact {
            return density == .compact ? 140 : 220
        }
        return density == .compact ? 120 : 240
    }

    private var gridSpacing: CGFloat {
        density == .compact ? PorcelainTokens.Space.sm : PorcelainTokens.Space.md
    }

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: gridSpacing) {
            ForEach(rows) { row in
                destination(for: row)
                    .contextMenu {
                        Button("Copy link", systemImage: "link") {
                            Clipboard.copy(
                                appModel.webURL(for: descriptor.key, id: row.id).absoluteString)
                        }
                        Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                        ShareLink(item: appModel.webURL(for: descriptor.key, id: row.id))
                    }
                    .accessibilityIdentifier(accessibilityIdentifier(for: row))
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.sm)
    }

    @ViewBuilder
    private func destination(for row: EntityRow) -> some View {
        let card = EntityCard(
            title: row.title,
            subtitle: subtitleOverride?(row) ?? subtitle(for: row),
            identifier: row.id,
            imageURL: row.imageURL,
            symbol: descriptor.sfSymbol,
            density: density,
            selected: isSelected(row)
        )

        #if os(macOS)
            Button {
                appModel.navigator.selectRecord(
                    RecordSelection(key: descriptor.key, id: row.id), in: section)
            } label: {
                card
            }
            .buttonStyle(.plain)
        #else
            NavigationLink(value: Route.entityDetail(descriptor.key, id: row.id)) {
                card
            }
            .buttonStyle(.plain)
            .simultaneousGesture(
                TapGesture().onEnded {
                    if section == .search { RecentEntities.record(row.id) }
                })
        #endif
    }

    private func isSelected(_ row: EntityRow) -> Bool {
        #if os(macOS)
            appModel.navigator.selectedRecords[section]
                == RecordSelection(key: descriptor.key, id: row.id)
        #else
            false
        #endif
    }

    private func accessibilityIdentifier(for row: EntityRow) -> String {
        if section == .search { return "search.result.\(row.id)" }
        return "browse.\(descriptor.key.rawValue).\(density.rawValue).\(row.id)"
    }

    private func subtitle(for row: EntityRow) -> String? {
        let parts = descriptor.presentation.shelfSubtitle.compactMap { key -> String? in
            guard let field = descriptor.field(key) else { return nil }
            return EntityFieldValue.text(row.raw[key], field: field)
        }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return row.subtitle
    }
}

/// The visual card is deliberately data-only so Browse and global Search can share identical
/// geometry and accessibility behavior without coupling their different navigation records.
struct EntityCard: View {
    let title: String
    let subtitle: String?
    let identifier: String
    let imageURL: URL?
    let symbol: String
    let density: ListPresentationChoice
    var selected = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: density == .compact ? 4 : PorcelainTokens.Space.sm) {
            GeometryReader { geometry in
                Thumb(
                    url: imageURL,
                    size: min(geometry.size.width, geometry.size.height),
                    symbol: symbol)
            }
            .aspectRatio(1, contentMode: .fit)

            Text(title)
                .font(density == .compact ? .caption.weight(.semibold) : .body.weight(.semibold))
                .foregroundStyle(PorcelainTokens.graphite)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                .multilineTextAlignment(.leading)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(density == .compact ? 6 : PorcelainTokens.Space.sm)
        .background(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .fill(PorcelainTokens.surface)
        )
        .overlay {
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .strokeBorder(
                    selected ? PorcelainTokens.cobalt : PorcelainTokens.hairline,
                    lineWidth: selected ? 2 : PorcelainTokens.hairlineWidth)
        }
        .contentShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var accessibilityLabel: String {
        [title, subtitle, identifier]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: ", ")
    }
}

#Preview("Cards", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        ScrollView {
            EntityShelfView(
                descriptor: EntityCatalog[.product], rows: PreviewFixtures.sampleRows,
                density: .cards)
        }
        .porcelainScreen()
        .navigationTitle("Products")
    }
}

#Preview("Compact · accessibility", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        ScrollView {
            EntityShelfView(
                descriptor: EntityCatalog[.product], rows: PreviewFixtures.sampleRows,
                density: .compact)
        }
        .porcelainScreen()
        .navigationTitle("Products")
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}
