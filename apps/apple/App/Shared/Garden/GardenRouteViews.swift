import CubbyKit
import SwiftUI

struct GardenPlantingRouteView: View {
    @Environment(AppModel.self) private var appModel
    let id: String
    @State private var garden: GardenModel?
    @State private var planting: GardenPlantingOut?
    @State private var error: String?

    var body: some View {
        Group {
            if let planting, let garden {
                GardenPlantingDetailView(
                    model: garden, planting: planting, guide: garden.guide(for: planting.ingredientId),
                    source: garden.guideSource, uploader: GardenImageUploader(service: appModel.client))
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load planting", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(GardenStrings.retry) { Task { await load() } }
                }
            } else {
                LoadingIndicator.screen()
            }
        }
        .porcelainScreen()
        .task(id: id) { await load() }
    }
    private func load() async {
        error = nil
        let model = GardenModel.SharedStore.model(for: appModel.client)
        garden = model
        await model.loadIfNeeded()
        do { planting = try await appModel.client.gardenPlanting(id: id) } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "garden.planting.load")
        }
    }
}

struct GardenEntryRouteView: View {
    @Environment(AppModel.self) private var appModel
    let id: String
    @State private var garden: GardenModel?
    @State private var entry: GardenEntryOut?
    @State private var error: String?
    @State private var correcting = false

    var body: some View {
        Group {
            if let entry, let garden {
                List {
                    GardenEntrySummary(entry: entry, linksToEntry: false)
                    if let error { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button(entry.anchorsPeriod ? GardenStrings.editNote : GardenStrings.editEntry) {
                            correcting = true
                        }
                    }
                }
                .sheet(isPresented: $correcting, onDismiss: { Task { await refreshEntry() } }) {
                    GardenEntryCorrectionSheet(
                        model: garden, entry: entry, uploader: GardenImageUploader(service: appModel.client))
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load entry", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(GardenStrings.retry) { Task { await refreshEntry() } }
                }
            } else {
                LoadingIndicator.screen()
            }
        }
        .porcelainScreen()
        .navigationTitle("Garden entry")
        .task(id: id) {
            let model = GardenModel.SharedStore.model(for: appModel.client)
            garden = model
            await model.loadIfNeeded()
            await refreshEntry()
        }
        .refreshable { await refreshEntry() }
    }
    private func refreshEntry() async {
        error = nil
        do { entry = try await appModel.client.gardenEntry(id: id) } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "garden.entry.load")
        }
    }
}

/// Link targets and photo controls are siblings so previewing a photo never pushes the entry.
struct GardenEntrySummary: View {
    let entry: GardenEntryOut
    var linksToEntry = true
    private var heading: some View {
        VStack(alignment: .leading) {
            HStack(spacing: PorcelainTokens.Space.sm) {
                Text(entry.displayName).font(.porcelainBody.weight(.semibold))
                if entry.anchorsPeriod {
                    Text(GardenStrings.startedHere)
                        .font(.porcelainLabel.weight(.semibold))
                        .foregroundStyle(PorcelainTokens.cobalt)
                        .padding(.horizontal, PorcelainTokens.Space.xs)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(PorcelainTokens.cobalt.opacity(0.12))
                        )
                }
            }
            Text(
                entry.observedOn.date?.formatted(date: .abbreviated, time: .omitted)
                    ?? entry.observedOn.rawValue
            )
            .font(.porcelainLabel)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if linksToEntry {
                NavigationLink(value: Route.entityDetail(.gardenEntry, id: entry.id)) { heading }
            } else {
                heading
            }
            NavigationLink(value: Route.entityDetail(.location, id: entry.locationId.rawValue)) {
                Text(entry.locationName).font(.porcelainLabel)
            }
            if let plantingID = entry.plantingId {
                NavigationLink(value: Route.entityDetail(.planting, id: plantingID)) {
                    Text(entry.plantingName ?? "View planting").font(.porcelainLabel)
                }
            }
            if let amount = entry.harvestAmount {
                Text(entry.plantingId == nil ? GardenStrings.harvestSummary(amount) : amount)
            }
            if let note = entry.note { Text(note) }
            GardenImageStrip(images: entry.images)
        }
        .padding(.vertical, 8)
    }
}

struct GardenBedJournalView: View {
    @Environment(AppModel.self) private var appModel
    let locationID: String?
    private enum LoadPhase: Equatable { case idle, loading, loaded }
    @State private var phase: LoadPhase = .idle
    @State private var entries: [GardenEntryOut] = []
    @State private var page = 1
    @State private var hasMore = false
    /// The concurrency guard, separate from `phase`: `phase` only ever advances `.idle` →
    /// `.loading` → `.loaded` (once) so the empty state cannot flash before the first page
    /// answers, while `isLoading` gates every individual request including a later refresh or
    /// "Load more".
    @State private var isLoading = false
    @State private var message: String?
    @State private var adding = false
    @State private var failedReset = true
    @State private var pendingReset = false
    @State private var garden: GardenModel?
    private var locationName: String {
        garden?.options.locations.first(where: { $0.id == locationID })?.name ?? "Bed"
    }

    var body: some View {
        List {
            if let locationID, garden != nil {
                Section {
                    NavigationLink(value: Route.entityDetail(.location, id: locationID)) {
                        Text(locationName)
                    }
                    Button(GardenStrings.addPhotosOrLogEntry) { adding = true }
                }
            }
            ForEach(entries) { GardenEntrySummary(entry: $0) }
            if let message {
                Section {
                    Text(message).foregroundStyle(PorcelainTokens.destructive)
                    Button(GardenStrings.retry) { Task { await load(reset: failedReset) } }
                }
            }
            // Tri-state like `EntityListView`: `.idle`/`.loading` never render the empty state, so
            // "No entries yet." cannot flash before the first page has actually come back.
            if phase == .loaded, entries.isEmpty, message == nil {
                Text(GardenStrings.noEntriesYet).foregroundStyle(.secondary)
            }
            if hasMore {
                Button(isLoading ? GardenStrings.loading : GardenStrings.loadMore) {
                    Task { await load() }
                }
                .disabled(isLoading)
            }
        }
        .overlay { if phase != .loaded { LoadingIndicator.screen() } }
        .navigationTitle(
            locationID == nil ? GardenStrings.gardenJournal : GardenStrings.areaJournal(locationName)
        )
        .task {
            let model = GardenModel.SharedStore.model(for: appModel.client)
            garden = model
            await model.loadIfNeeded()
            await load(reset: true)
        }
        .refreshable { await load(reset: true) }
        .sheet(isPresented: $adding, onDismiss: { Task { await load(reset: true) } }) {
            if let garden, let locationID {
                GardenEntrySheet(
                    model: garden,
                    target: .location(
                        .init(
                            id: LocationCode(locationID), name: locationName, gardenKind: nil,
                            gardenConditions: nil,
                            plantings: [])),
                    uploader: GardenImageUploader(service: appModel.client))
            }
        }
    }
    private func load(reset: Bool = false) async {
        guard !isLoading else {
            if reset { pendingReset = true }
            return
        }
        if phase == .idle { phase = .loading }
        isLoading = true
        message = nil
        defer {
            isLoading = false
            phase = .loaded
            if pendingReset {
                pendingReset = false
                Task { await load(reset: true) }
            }
        }
        do {
            let result = try await appModel.client.gardenEntries(
                locationID: locationID, page: reset ? 1 : page)
            let existingIDs = reset ? Set<String>() : Set(entries.map(\.id))
            entries = (reset ? [] : entries) + result.items.filter { !existingIDs.contains($0.id) }
            hasMore = result.hasMore
            page = (reset ? 1 : page) + 1
        } catch {
            failedReset = reset
            message = error.localizedDescription
            Diagnostics.report(error, context: "garden.location.entries")
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { GardenBedJournalView(locationID: nil) }
}
