import CubbyKit
import SwiftUI

/// One entity's detail screen. Owns a `GenericEntityDetailModel` created per host, mirroring
/// `EntityListView`/`CaptureView`.
struct EntityDetailView: View {
    let key: EntityKey
    let id: String

    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityDetailModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        content
            .porcelainScreen()
            .navigationTitle(model?.row?.title ?? descriptor.singular)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task(id: appModel.host) { await setup() }
    }

    @ViewBuilder
    private var content: some View {
        if let model {
            switch model.phase {
            case .idle, .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load \(descriptor.singular)",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                if let row = model.row {
                    EntityDetailContent(descriptor: descriptor, row: row)
                } else {
                    ContentUnavailableView("Not found", systemImage: "questionmark.folder")
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func setup() async {
        let model = await GenericEntityDetailModel(descriptor: descriptor, client: appModel.client.raw)
        self.model = model
        await model.load(id: id)
    }
}

/// Plain-data detail rendering, shared by the real screen and `#Preview`s so neither needs a
/// network round trip to render. Reading order is the web inspector's: identity, then the truth
/// already in the payload, then everything else, then the raw record.
struct EntityDetailContent: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    @State private var showingRaw = false

    #if os(macOS)
    private let heroMaxHeight: CGFloat = 360
    #else
    private let heroMaxHeight: CGFloat = 280
    #endif

    private var stats: [EntityStat] { EntityFacts.stats(descriptor: descriptor, row: row) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                hero
                identity
                if !stats.isEmpty {
                    LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                        ForEach(stats) { stat in
                            StatTile(label: stat.label, value: stat.value, detail: stat.detail, mono: stat.mono)
                        }
                    }
                }
                if !detailRows.isEmpty {
                    VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                        Eyebrow("Details")
                        Panel(padding: 0, spacing: 0) {
                            ForEach(Array(detailRows.enumerated()), id: \.element.field.key) { index, entry in
                                if index > 0 { PanelDivider() }
                                LabeledRow(
                                    label: entry.field.label,
                                    value: entry.value,
                                    data: entry.field.kind == .number || entry.field.kind == .date
                                        || entry.field.kind == .timestamp,
                                    mono: entry.field.kind == .identifier
                                )
                            }
                        }
                    }
                }
                rawDisclosure
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
    }

    @ViewBuilder
    private var hero: some View {
        if let url = row.imageURL {
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .fill(PorcelainTokens.inset)
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: heroMaxHeight)
                .overlay {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        } else if case .failure = phase {
                            symbolTile
                        } else {
                            ProgressView().controlSize(.small)
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                .overlay(
                    RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                        .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                )
        } else {
            symbolTile
                .frame(width: 96, height: 96)
                .background(
                    RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel).fill(PorcelainTokens.inset)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                        .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                )
        }
    }

    private var symbolTile: some View {
        Image(systemName: entitySymbol(for: descriptor.key))
            .font(.system(size: 32, weight: .light))
            .foregroundStyle(PorcelainTokens.graphiteSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Text(row.title)
                .font(.title.weight(.semibold))
                .tracking(-0.4)
                .foregroundStyle(PorcelainTokens.graphite)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let subtitle = subtitleLine {
                Text(subtitle)
                    .font(.porcelainBody)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: PorcelainTokens.Space.sm) {
                DomainMark(descriptor.key)
                Text(row.id)
                    .font(.porcelainCode)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .textSelection(.enabled)
                Text(descriptor.singular)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
    }

    /// Manufacturer then category, minus whatever the stats grid already claims — repeating
    /// "supplies" two inches apart is noise, not hierarchy.
    private var subtitleLine: String? {
        let claimed = Set(stats.map(\.value))
        let parts = [row.raw["manufacturer"]?.stringValue, row.raw["category"]?.stringValue]
            .compactMap { $0 }
            .filter { !$0.isEmpty && !claimed.contains($0) }
        if parts.isEmpty { return claimed.contains(row.subtitle ?? "") ? nil : row.subtitle }
        return parts.joined(separator: " · ")
    }

    private var rawDisclosure: some View {
        Panel(padding: PorcelainTokens.Space.md) {
            DisclosureGroup(isExpanded: $showingRaw) {
                Text(prettyJSON(row.raw))
                    .font(.porcelainCode)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, PorcelainTokens.Space.sm)
            } label: {
                Eyebrow("Raw record")
            }
            .tint(PorcelainTokens.graphiteSecondary)
        }
    }

    /// `showInDetail` fields that carry a value, minus the ones the identity block and the stats
    /// grid already show. A detail screen that repeats its own title is a form, not a record.
    private var detailRows: [(field: FieldDescriptor, value: String)] {
        let claimedLabels = Set(stats.map(\.label))
        let identityKeys: Set<String> = ["id", "shortcode", descriptor.titleField]
        return
            descriptor.fields
            .filter(\.showInDetail)
            .sorted { ($0.detailOrder ?? Int.max) < ($1.detailOrder ?? Int.max) }
            .compactMap { field in
                guard !identityKeys.contains(field.key), !claimedLabels.contains(field.label),
                    let value = displayValue(for: field)
                else { return nil }
                return (field, value)
            }
    }

    /// Formats `row.raw[field.key]` per `field.kind`. Returns `nil` (skip the row) for a missing
    /// key or a JSON `null`.
    private func displayValue(for field: FieldDescriptor) -> String? {
        guard let value = row.raw[field.key] else { return nil }
        switch value {
        case .null:
            return nil
        case .string(let string):
            if string.isEmpty { return nil }
            if field.kind == .date || field.kind == .timestamp {
                return EntityFacts.formattedDate(string) ?? string
            }
            return string
        case .number(let number):
            return EntityFacts.format(number)
        case .bool(let bool):
            return bool ? "Yes" : "No"
        case .array(let items):
            if items.isEmpty { return nil }
            if items.allSatisfy({ $0.stringValue != nil }) {
                return items.compactMap(\.stringValue).joined(separator: ", ")
            }
            return "\(items.count) item\(items.count == 1 ? "" : "s")"
        case .object:
            return "{…}"
        }
    }

    private func prettyJSON(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value), let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}

#Preview {
    NavigationStack {
        EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
            .navigationTitle("Cast Iron Skillet")
    }
}
