import CubbyKit
import SwiftUI

/// Plain-data relationship rendering for the two entities whose detail payload is worth more than
/// the generic stats grid: `Product` (gallery, stocked-at) and `Location` (parent, contents,
/// sub-locations). Everything here reads `EntityRow.raw` directly — nothing issues a request, and
/// nothing here is generic-entity machinery, so `EntityDetailContent` opts in per `descriptor.key`.

// MARK: - Product: gallery

/// One uploaded product image, ready for `AsyncImage`.
struct ProductGalleryImage: Identifiable, Hashable {
    let id: String
    let url: URL
}

/// One place a product is physically stocked, from `inventoryEntry`.
struct ProductStockLocation: Identifiable, Hashable {
    let id: String
    let locationId: String
    let locationName: String
    let ancestorPath: String?
    let amountText: String?
    let placement: String?
}

/// Parses the relationship arrays a product detail payload carries alongside its scalar fields.
enum ProductRelations {
    /// Images that finished uploading, in payload order. A `PENDING`/`FAILED` image never earns a
    /// gallery page — that failure state belongs to the ingredient workbench, not the detail screen.
    static func gallery(from row: EntityRow) -> [ProductGalleryImage] {
        guard let images = row.raw["images"]?.arrayValue else { return [] }
        return images.compactMap { image in
            guard image["status"]?.stringValue == "UPLOADED",
                let id = image["id"]?.stringValue,
                let urlString = image["url"]?.stringValue,
                let url = URL(string: urlString)
            else { return nil }
            return ProductGalleryImage(id: id, url: url)
        }
    }

    /// Every place this product is physically stocked, from `inventoryEntry`.
    static func stockedAt(from row: EntityRow) -> [ProductStockLocation] {
        guard let entries = row.raw["inventoryEntry"]?.arrayValue else { return [] }
        return entries.compactMap { entry in
            guard let id = entry["id"]?.stringValue,
                let location = entry["location"],
                let locationId = location["id"]?.stringValue
            else { return nil }
            let ancestorNames = location["ancestors"]?.arrayValue?.compactMap { $0["name"]?.stringValue }
            let ancestorPath = (ancestorNames?.isEmpty == false) ? ancestorNames?.joined(separator: " › ") : nil
            return ProductStockLocation(
                id: id,
                locationId: locationId,
                locationName: location["name"]?.stringValue ?? locationId,
                ancestorPath: ancestorPath,
                amountText: EntityFacts.amount(entry["amount"]),
                placement: entry["placement"]?.stringValue
            )
        }
    }
}

/// A swipeable hero for a product with more than one uploaded photo. `EntityDetailContent` keeps
/// its plain single-image hero for zero or one photo — this view only earns its place once there
/// is something to swipe between.
struct ProductGalleryHero: View {
    let images: [ProductGalleryImage]
    var maxHeight: CGFloat = 280

    @State private var page = 0

    var body: some View {
        VStack(spacing: PorcelainTokens.Space.sm) {
            TabView(selection: $page) {
                ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
                    AsyncImage(url: image.url) { phase in
                        if case .success(let loaded) = phase {
                            loaded.resizable().scaledToFill()
                        } else if case .failure = phase {
                            galleryPlaceholder
                        } else {
                            ProgressView().controlSize(.small)
                        }
                    }
                    .tag(index)
                }
            }
            #if os(iOS)
            .tabViewStyle(.page(indexDisplayMode: .never))
            #endif
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: maxHeight)
            .background(PorcelainTokens.inset)
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                    .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
            )

            if images.count > 1 {
                HStack(spacing: PorcelainTokens.Space.xs) {
                    ForEach(images.indices, id: \.self) { index in
                        Circle()
                            .fill(index == page ? PorcelainTokens.cobalt : PorcelainTokens.hairline)
                            .frame(width: 6, height: 6)
                    }
                }
                .accessibilityHidden(true)
            }
        }
    }

    private var galleryPlaceholder: some View {
        Image(systemName: "photo")
            .font(.system(size: 32, weight: .light))
            .foregroundStyle(PorcelainTokens.graphiteSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "Stocked at": every `inventoryEntry` for a product, each a link to its location.
struct ProductStockedAtSection: View {
    let locations: [ProductStockLocation]

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Stocked at")
            if locations.isEmpty {
                Panel {
                    Text("Not stocked anywhere")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            } else {
                Panel(padding: 0, spacing: 0) {
                    ForEach(Array(locations.enumerated()), id: \.element.id) { index, location in
                        if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg) }
                        NavigationLink(value: Route.entityDetail(.location, id: location.locationId)) {
                            ProductStockLocationRow(location: location)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct ProductStockLocationRow: View {
    let location: ProductStockLocation

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            DomainMark(.location)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(location.locationName)
                    .font(.porcelainTitle)
                    .foregroundStyle(PorcelainTokens.graphite)
                if let ancestorPath = location.ancestorPath {
                    Text(ancestorPath)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            VStack(alignment: .trailing, spacing: 4) {
                if let amountText = location.amountText {
                    Text(amountText)
                        .font(.porcelainData)
                        .foregroundStyle(PorcelainTokens.graphite)
                }
                if let placement = location.placement, placement != "stock" {
                    StatusChip(text: placement.capitalized)
                }
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

// MARK: - Location: parent, contents, sub-locations

/// The tappable breadcrumb above a location's title.
struct LocationParentRef: Identifiable, Hashable {
    let id: String
    let name: String
}

/// One product physically stocked in a location, from `inventoryItems`.
struct LocationInventoryItem: Identifiable, Hashable {
    let id: String
    let productId: String
    let productName: String
    let amountText: String?
}

/// One direct child of a location, from `children`.
struct LocationChildSummary: Identifiable, Hashable {
    let id: String
    let name: String
    let directItemCount: Int?
}

/// Parses the relationship fields a location detail payload carries alongside its scalar fields.
enum LocationRelations {
    static func parent(from row: EntityRow) -> LocationParentRef? {
        guard let parent = row.raw["parent"], let id = parent["id"]?.stringValue else { return nil }
        return LocationParentRef(id: id, name: parent["name"]?.stringValue ?? id)
    }

    static func inventoryItems(from row: EntityRow) -> [LocationInventoryItem] {
        guard let items = row.raw["inventoryItems"]?.arrayValue else { return [] }
        return items.compactMap { item in
            guard let id = item["id"]?.stringValue, let productId = item["productId"]?.stringValue else {
                return nil
            }
            return LocationInventoryItem(
                id: id,
                productId: productId,
                productName: item["productName"]?.stringValue ?? productId,
                amountText: EntityFacts.amount(item["amount"])
            )
        }
    }

    static func children(from row: EntityRow) -> [LocationChildSummary] {
        guard let children = row.raw["children"]?.arrayValue else { return [] }
        return children.compactMap { child in
            guard let id = child["id"]?.stringValue else { return nil }
            return LocationChildSummary(
                id: id,
                name: child["name"]?.stringValue ?? id,
                directItemCount: EntityFacts.number(child["directItemCount"]).map(Int.init)
            )
        }
    }
}

/// "Contents": products stocked directly in this location, each a link to its product. Capped so a
/// bin with hundreds of rows doesn't turn the detail screen into a second list view.
struct LocationContentsSection: View {
    let items: [LocationInventoryItem]
    private let cap = 25

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Contents")
            if items.isEmpty {
                Panel {
                    Text("Nothing stocked here")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            } else {
                Panel(padding: 0, spacing: 0) {
                    ForEach(Array(visibleItems.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg) }
                        NavigationLink(value: Route.entityDetail(.product, id: item.productId)) {
                            LocationInventoryItemRow(item: item)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if items.count > cap {
                    Text("+\(items.count - cap) more")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .padding(.horizontal, PorcelainTokens.Space.xs)
                }
            }
        }
    }

    private var visibleItems: [LocationInventoryItem] { Array(items.prefix(cap)) }
}

private struct LocationInventoryItemRow: View {
    let item: LocationInventoryItem

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            DomainMark(.product)
            Text(item.productName)
                .font(.porcelainTitle)
                .foregroundStyle(PorcelainTokens.graphite)
                .lineLimit(2)
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let amountText = item.amountText {
                Text(amountText)
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

/// "Sub-locations": the direct children of this location. Omitted entirely for a leaf location
/// rather than showing an eyebrow over an empty panel — most locations have no children.
struct LocationSubLocationsSection: View {
    let children: [LocationChildSummary]

    var body: some View {
        if !children.isEmpty {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                Eyebrow("Sub-locations")
                Panel(padding: 0, spacing: 0) {
                    ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                        if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg) }
                        NavigationLink(value: Route.entityDetail(.location, id: child.id)) {
                            LocationChildRow(child: child)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct LocationChildRow: View {
    let child: LocationChildSummary

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            DomainMark(.location)
            Text(child.name)
                .font(.porcelainTitle)
                .foregroundStyle(PorcelainTokens.graphite)
                .lineLimit(2)
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let count = child.directItemCount {
                Text("\(count) item\(count == 1 ? "" : "s")")
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

// MARK: - Previews (private sample data; no network)

#Preview("Product gallery") {
    ProductGalleryHero(images: [
        ProductGalleryImage(id: "IMG-1", url: URL(string: "https://images.cubby.invalid/skillet-1.jpg")!),
        ProductGalleryImage(id: "IMG-2", url: URL(string: "https://images.cubby.invalid/skillet-2.jpg")!),
        ProductGalleryImage(id: "IMG-3", url: URL(string: "https://images.cubby.invalid/skillet-3.jpg")!),
    ])
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}

#Preview("Stocked at") {
    NavigationStack {
        ScrollView {
            ProductStockedAtSection(locations: [
                ProductStockLocation(
                    id: "IE-1", locationId: "LOC-1001", locationName: "Pantry Shelf B",
                    ancestorPath: "Kitchen › Pantry", amountText: "3 units", placement: "stock"
                ),
                ProductStockLocation(
                    id: "IE-2", locationId: "LOC-1002", locationName: "Garage Cabinet",
                    ancestorPath: "Garage", amountText: "1 unit", placement: "installed"
                ),
            ])
            .padding(PorcelainTokens.Space.lg)
        }
        .porcelainScreen()
    }
}

#Preview("Stocked at (empty)") {
    ScrollView {
        ProductStockedAtSection(locations: [])
            .padding(PorcelainTokens.Space.lg)
    }
    .background(PorcelainTokens.canvas)
}

#Preview("Location contents + sub-locations") {
    NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                LocationContentsSection(items: [
                    LocationInventoryItem(
                        id: "INV-1", productId: "PRD-1001", productName: "Cast Iron Skillet",
                        amountText: "1 unit"
                    ),
                    LocationInventoryItem(
                        id: "INV-2", productId: "PRD-1002", productName: "Enameled Dutch Oven",
                        amountText: "2 units"
                    ),
                ])
                LocationSubLocationsSection(children: [
                    LocationChildSummary(id: "LOC-2001", name: "Top shelf", directItemCount: 4),
                    LocationChildSummary(id: "LOC-2002", name: "Bottom shelf", directItemCount: 0),
                ])
            }
            .padding(PorcelainTokens.Space.lg)
        }
        .porcelainScreen()
    }
}

#Preview("Location contents (empty)") {
    ScrollView {
        LocationContentsSection(items: [])
            .padding(PorcelainTokens.Space.lg)
    }
    .background(PorcelainTokens.canvas)
}
