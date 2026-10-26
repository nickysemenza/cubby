import CubbyKit
import SwiftUI

/// Declared browse roots in shared sidebar order. Native lists stay in the catalog; web-only
/// roots retain an explicit browser entry point after the native sections.
struct BrowseRootView: View {
    var title = "Browse"

    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        List {
            ForEach(SidebarManifest.sections) { section in
                let destinations = section.destinations.filter {
                    $0.entity != nil && $0.nativeDestination != nil && matchesQuery($0)
                }
                if !destinations.isEmpty {
                    Section {
                        ForEach(destinations, id: \.route) { destination in
                            if let key = destination.entity {
                                row(for: EntityCatalog[key])
                                    .listRowInsets(browseRowInsets)
                            }
                        }
                    } header: {
                        headerTitle(section.label, domain: section.domain.map { AppDomain($0) })
                    }
                }
            }
            if !webDestinations.isEmpty {
                Section {
                    ForEach(webDestinations, id: \.route) { destination in
                        OpenOnWebButton(target: destination.webTarget) {
                            HStack(spacing: FieldGuideTokens.Space.md) {
                                if let key = destination.entity {
                                    DomainMark(key, style: .symbol, size: 15)
                                        .fieldGuideIconSlot()
                                }
                                Text("Open \(destination.label) on web")
                                    .font(.fieldGuideBody)
                                Spacer(minLength: FieldGuideTokens.Space.sm)
                                Image(systemName: "arrow.up.right")
                                    .foregroundStyle(.secondary)
                            }
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                        }
                        .accessibilityIdentifier(
                            "browse.web.\(destination.entity?.rawValue ?? destination.route)"
                        )
                        .listRowInsets(browseRowInsets)
                    }
                } header: {
                    headerTitle("More on web")
                }
            }
            #if os(iOS)
                Section {
                    NavigationLink(value: Route.photosLibrary) {
                        Label("All photos", systemImage: "photo.on.rectangle.angled")
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    .accessibilityIdentifier("library.photos")
                    .listRowInsets(browseRowInsets)
                    Button {
                        model.navigator.openGraph()
                    } label: {
                        Label("Graph", systemImage: "point.3.connected.trianglepath.dotted")
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    .listRowInsets(browseRowInsets)
                } header: {
                    headerTitle("Explore")
                }
            #endif
        }
        .accessibilityIdentifier("browse.catalog")
        .listStyle(.automatic)
        .fieldGuideScreen()
        .navigationTitle(title)
        .searchable(text: $query)
        .overlay {
            if !query.isEmpty
                && !SidebarManifest.sections.flatMap(\.destinations).contains(where: {
                    $0.entity != nil && matchesQuery($0)
                })
            {
                ContentUnavailableView.search(text: query)
            }
        }
        .task(id: model.host) {
            await model.browseCounts.load(client: model.client, host: model.host)
        }
        .refreshControl {
            await model.browseCounts.load(client: model.client, host: model.host, force: true)
        }
    }

    private func headerTitle(_ title: String, domain: AppDomain? = nil) -> some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            if let domain { DomainMark(domain) }
            Text(title).font(.subheadline.weight(.semibold)).textCase(nil)
            Spacer()
        }
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: FieldGuideTokens.Space.lg, bottom: 0, trailing: FieldGuideTokens.Space.lg)
        )
    }

    @ViewBuilder private func row(for descriptor: EntityDescriptor) -> some View {
        #if os(macOS)
            Button {
                model.navigator.macDestination = .entity(descriptor.key)
            } label: {
                EntityBrowseRow(
                    descriptor: descriptor,
                    count: model.browseCounts.count(for: descriptor.key)
                )
            }
            .buttonStyle(.plain)
        #else
            NavigationLink(value: Route.entityList(descriptor.key)) {
                EntityBrowseRow(
                    descriptor: descriptor,
                    count: model.browseCounts.count(for: descriptor.key)
                )
            }
        #endif
    }

    /// The row owns its own 44pt height, so the list must not add its default vertical padding.
    private var browseRowInsets: EdgeInsets {
        EdgeInsets(
            top: 0, leading: FieldGuideTokens.Space.lg,
            bottom: 0, trailing: FieldGuideTokens.Space.lg
        )
    }

    private func matchesQuery(_ destination: SidebarManifest.Destination) -> Bool {
        query.isEmpty || destination.label.localizedCaseInsensitiveContains(query)
            || destination.entity.map { EntityCatalog[$0].plural.localizedCaseInsensitiveContains(query) }
                == true
    }

    private var webDestinations: [SidebarManifest.Destination] {
        SidebarManifest.sections.flatMap(\.destinations).filter {
            $0.entity != nil && $0.nativeDestination == nil && matchesQuery($0)
        }
    }
}

/// Row counts from `dashboard.counts`, loaded once per host. `nil` while loading or on
/// failure, so a Browse row shows nothing on the right rather than a stale or fabricated number.
@Observable
final class BrowseCountsModel {
    private(set) var counts: EntityCounts?
    private var requestedHost: String?

    func load(client: CubbyClient, host: String, force: Bool = false) async {
        guard force || requestedHost != host else { return }
        requestedHost = host
        do {
            let loaded = try await client.dashboardCounts()
            guard requestedHost == host else { return }
            counts = loaded.entityCounts
        } catch {
            guard requestedHost == host else { return }
            requestedHost = nil
            counts = nil
            Diagnostics.report(error, context: "browse.counts")
        }
    }

    func count(for key: EntityKey) -> Int? {
        counts?.count(for: key)
    }
}

/// One catalog row: the entity's own glyph in its domain color, its plural name, and (once loaded)
/// how many records exist.
private struct EntityBrowseRow: View {
    let descriptor: EntityDescriptor
    let count: Int?

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.md) {
            DomainMark(descriptor.key, style: .symbol, size: 15)
                .fieldGuideIconSlot()
            Text(descriptor.plural)
                .font(.fieldGuideBody)
            Spacer(minLength: FieldGuideTokens.Space.sm)
            if let count { NativeCountBadge(count: count) }
        }
        .frame(minHeight: FieldGuideTokens.touchTarget)
        .accessibilityIdentifier("browse.catalog.\(descriptor.key.rawValue)")
    }
}

/// A row's record count: plain, muted, tabular digits at the trailing edge — no box, so a column
/// of counts reads as quiet data rather than a stack of controls. Hierarchical `.secondary` (not a
/// fixed color) so it stays legible on a selected sidebar row.
struct NativeCountBadge: View {
    let count: Int

    var body: some View {
        Text(count.formatted())
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(count.formatted()) records")
    }
}

/// SF Symbol per entity key, used by Browse rows, `DomainMark`, and the list/detail empty states.
/// Read off the generated catalog (`presentation.icons.sfSymbol` in the entity declarations).
func entitySymbol(for key: EntityKey) -> String {
    EntityCatalog[key].sfSymbol
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { BrowseRootView() }
}
