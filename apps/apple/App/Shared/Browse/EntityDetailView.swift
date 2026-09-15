import CubbyKit
import SwiftUI

/// One entity's detail screen. Owns a `GenericEntityDetailModel` created per host, mirroring
/// `EntityListView`/`CaptureView`.
struct EntityDetailView: View {
    let key: EntityKey
    let id: String

    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityDetailModel?
    @State private var photoCapture: PhotoCaptureModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        content
            .porcelainScreen()
            .navigationTitle(model?.row?.title ?? descriptor.singular)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .task(id: id) { await setup() }
            .refreshControl { await model?.refresh(id: id) }
            .userActivity(NSUserActivityTypeBrowsingWeb, isActive: model?.row != nil) { activity in
                guard let row = model?.row else { return }
                activity.webpageURL = appModel.webURL(for: row.id)
                activity.title = row.title
                activity.isEligibleForHandoff = true
                // Spotlight indexing is a separate path (`SpotlightIndexer`); this activity is
                // Handoff-only.
                activity.isEligibleForSearch = false
            }
            .toolbar {
                if let row = model?.row {
                    ToolbarItem {
                        ShareLink(item: appModel.webURL(for: row.id)) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                    ToolbarItem {
                        Menu {
                            Button {
                                Clipboard.copy(appModel.webURL(for: row.id).absoluteString)
                            } label: {
                                Label("Copy link", systemImage: "link")
                            }
                            Button {
                                Clipboard.copy(row.id)
                            } label: {
                                Label("Copy shortcode", systemImage: "number")
                            }
                        } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                    }
                }
                // Any entity whose update takes pendingImageIds can take a photo; the cover
                // choice inside the sheet is product-only.
                if descriptor.acceptsImages, let row = model?.row {
                    ToolbarItem {
                        Button {
                            photoCapture = PhotoCaptureModel(
                                client: appModel.client, entity: key, entityID: row.id,
                                entityTitle: row.title,
                                featurePrints: appModel.featurePrints
                            )
                        } label: {
                            Label("Add photo", systemImage: "camera.badge.ellipsis")
                        }
                    }
                }
            }
            .sheet(item: $photoCapture) { capture in
                AddPhotoSheet(capture: capture) { _ in
                    Task { await model?.refresh(id: id) }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let model, let row = model.row {
            VStack(spacing: 0) {
                if let error = model.refreshError {
                    HStack {
                        Text(error).font(.callout)
                        Button("Retry") { Task { await model.refresh(id: id) } }
                    }.padding()
                }
                EntityDetailContent(descriptor: descriptor, row: row)
            }
        } else if let model {
            switch model.phase {
            case .idle, .loading:
                LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't load \(descriptor.singular)", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await model.loadInitial(id: id) } }
                }
            case .loaded:
                ContentUnavailableView("Not found", systemImage: "questionmark.folder")
            }
        } else {
            LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
        }
    }

    private func setup() async {
        if model == nil { model = GenericEntityDetailModel(descriptor: descriptor, client: appModel.client) }
        await model?.loadInitial(id: id)
    }

}

/// Plain-data detail rendering, shared by the real screen and `#Preview`s so neither needs a
/// network round trip to render. Reading order is the web inspector's: identity, then the truth
/// already in the payload, then everything else, then the raw record.
struct EntityDetailContent: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    @State private var showingRaw = false
    @State private var showingPhoto = false

    #if os(macOS)
        private let heroMaxHeight: CGFloat = 360
    #else
        private let heroMaxHeight: CGFloat = 280
    #endif

    private var stats: [EntityStat] { EntityFacts.stats(descriptor: descriptor, row: row) }

    // Relationship reads for the two hand-tuned entities. Empty/nil everywhere else, so the
    // generic path (every other entity) never pays for this. There is no product gallery: every
    // payload's `images` field carries shortcodes only (see `DetailRelations.swift`), so the hero
    // below falls back to the single `coverImageUrl` like every other entity.
    private var productStockedAt: [ProductStockLocation] {
        descriptor.key == .product ? ProductRelations.stockedAt(from: row) : []
    }
    private var locationParent: LocationParentRef? {
        descriptor.key == .location ? LocationRelations.parent(from: row) : nil
    }
    private var locationType: String? {
        descriptor.key == .location ? row.raw["type"]?.stringValue : nil
    }
    private var locationAiDescription: String? {
        guard descriptor.key == .location, let text = row.raw["aiDescription"]?.stringValue, !text.isEmpty
        else { return nil }
        return text
    }
    private var locationInventoryItems: [LocationInventoryItem] {
        descriptor.key == .location ? LocationRelations.inventoryItems(from: row) : []
    }
    private var locationChildren: [LocationChildSummary] {
        descriptor.key == .location ? LocationRelations.children(from: row) : []
    }

    var body: some View {
        Form {
            Section {
                if heroPhoto != nil { hero }
                identity
                if let locationAiDescription { Text(locationAiDescription) }
            }
            if !stats.isEmpty {
                Section("Overview") {
                    ForEach(stats) { stat in
                        LabeledContent(stat.label) {
                            VStack(alignment: .trailing) {
                                Text(stat.value).textSelection(.enabled)
                                if let detail = stat.detail {
                                    Text(detail).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            if descriptor.key == .product {
                Section("Stocked at") { ProductStockedAtSection(locations: productStockedAt) }
            }
            if descriptor.key == .location {
                Section("Contents") { LocationContentsSection(items: locationInventoryItems) }
                if !locationChildren.isEmpty {
                    Section("Sub-locations") { LocationSubLocationsSection(children: locationChildren) }
                }
            }
            if !detailRows.isEmpty {
                Section("Details") {
                    ForEach(detailRows, id: \.field.key) { entry in
                        LabeledContent(entry.field.label, value: entry.value)
                            .textSelection(.enabled)
                    }
                }
            }
            Section { rawDisclosure }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("detail.\(descriptor.key.rawValue)")
        .photoPreviewPresentation(isPresented: $showingPhoto) {
            if let photo = heroPhoto { PhotoPreview(photos: [photo], selectedID: photo.id) }
        }
    }

    private var heroPhoto: PhotoAttachment? {
        guard let url = row.imageURL else { return nil }
        return PhotoAttachment(
            id: row.id, filename: row.title, source: .remote(url),
            imageID: descriptor.key == .image ? nil : row.raw["coverImageId"]?.stringValue)
    }

    @ViewBuilder
    private var hero: some View {
        if let photo = heroPhoto {
            Button {
                showingPhoto = true
            } label: {
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                    .fill(PorcelainTokens.inset)
                    .aspectRatio(4.0 / 3.0, contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: heroMaxHeight)
                    .overlay {
                        PhotoAttachmentImage(photo: photo, renderedWidth: PorcelainTokens.readingWidth)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                    .overlay(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                            .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                    )
            }.buttonStyle(.plain).accessibilityLabel("Preview \(photo.filename)")
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
            if let parent = locationParent {
                NavigationLink(value: Route.entityDetail(.location, id: parent.id)) {
                    HStack(spacing: PorcelainTokens.Space.xs) {
                        Image(systemName: "chevron.left")
                            .font(.porcelainLabel.weight(.semibold))
                        Text(parent.name)
                            .font(.porcelainLabel)
                    }
                    .foregroundStyle(PorcelainTokens.cobalt)
                }
                .buttonStyle(.plain)
            }
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
                if let locationType {
                    Text("· \(locationType.capitalized)")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
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
        var identityKeys: Set<String> = ["id", "shortcode", descriptor.titleField]
        if descriptor.key == .location {
            // Shown instead by the identity breadcrumb (`parentId`/`type`) and the quiet paragraph
            // (`aiDescription`) above — repeating them here would be the same fact twice.
            identityKeys.formUnion(["type", "parentId", "aiDescription"])
        }
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

/// A product with multiple `inventoryEntry` rows, so the "Stocked at" panel renders. `images`
/// carries shortcodes only on the wire now (no gallery to render — see `DetailRelations.swift`),
/// and a stock location's `location` no longer carries `ancestors`, so `ancestorPath` is nil.
/// Private to this file — no network, no `PreviewFixtures`.
#Preview("Product with stock") {
    let raw: JSONValue = .object([
        "id": .string("PRD-2345"),
        "name": .string("Cast Iron Skillet"),
        "manufacturer": .string("Lodge"),
        "category": .string("Cookware"),
        "primaryGtin": .string("00075536010014"),
        "onHandUnits": .number(3),
        "pricing": .object(["effectivePrice": .number(24.95), "source": .string("derived")]),
        "images": .array([.string("IMG-1"), .string("IMG-2")]),
        "inventoryEntry": .array([
            .object([
                "id": .string("IE-1"),
                "amount": .object(["value": .number(2), "unit": .string("units")]),
                "placement": .string("stock"),
                "location": .object(["id": .string("LOC-1001"), "name": .string("Pantry Shelf B")]),
            ]),
            .object([
                "id": .string("IE-2"),
                "amount": .object(["value": .number(1), "unit": .string("units")]),
                "placement": .string("installed"),
                "location": .object(["id": .string("LOC-1002"), "name": .string("Garage Cabinet")]),
            ]),
        ]),
    ])
    let row = EntityRow(
        id: "PRD-2345", title: "Cast Iron Skillet", subtitle: "Lodge", imageURL: nil, raw: raw)
    return NavigationStack {
        EntityDetailContent(descriptor: EntityCatalog[.product], row: row)
            .navigationTitle("Cast Iron Skillet")
    }
}

/// A location with a parent, direct inventory, and sub-locations, so the breadcrumb, "Contents",
/// and "Sub-locations" panels all render.
#Preview("Location with parent + contents") {
    let raw: JSONValue = .object([
        "id": .string("LOC-1001"),
        "name": .string("Pantry Shelf B"),
        "type": .string("shelf"),
        "aiDescription": .string("Dry goods and cast iron, middle shelf of the pantry."),
        "directItemCount": .number(2),
        "totalItemCount": .number(5),
        "parent": .object(["id": .string("LOC-1"), "name": .string("Kitchen Pantry")]),
        "inventoryItems": .array([
            .object([
                "id": .string("INV-1"), "productId": .string("PRD-2345"),
                "productName": .string("Cast Iron Skillet"),
                "amount": .object(["value": .number(1), "unit": .string("units")]),
            ]),
            .object([
                "id": .string("INV-2"), "productId": .string("PRD-2346"),
                "productName": .string("Enameled Dutch Oven"),
                "amount": .object(["value": .number(1), "unit": .string("units")]),
            ]),
        ]),
        "children": .array([
            .object([
                "id": .string("LOC-1002"), "name": .string("Shelf B, left bin"),
                "directItemCount": .number(3),
            ])
        ]),
    ])
    let row = EntityRow(id: "LOC-1001", title: "Pantry Shelf B", subtitle: nil, imageURL: nil, raw: raw)
    return NavigationStack {
        EntityDetailContent(descriptor: EntityCatalog[.location], row: row)
            .navigationTitle("Pantry Shelf B")
    }
}
