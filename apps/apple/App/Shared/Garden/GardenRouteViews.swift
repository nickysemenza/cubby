import CubbyKit
import SwiftUI

struct GardenPlantingRouteView: View {
    @Environment(AppModel.self) private var appModel
    let id: String
    @State private var garden: GardenModel?
    @State private var planting: GardenPlanting?
    @State private var error: String?

    var body: some View {
        Group {
            if let planting, let garden {
                GardenPlantingDetailView(
                    model: garden, planting: planting, guide: garden.guide(for: planting.ingredient.id),
                    source: garden.guideSource, uploader: GardenImageUploader(service: appModel.client))
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't load planting", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .porcelainScreen()
        .task(id: id) { await load() }
    }
    private func load() async {
        error = nil
        let model = GardenModel(service: appModel.client)
        garden = model
        await model.load()
        do { planting = try await appModel.client.gardenPlanting(id: id) } catch {
            self.error = error.localizedDescription
        }
    }
}

struct GardenEntryRouteView: View {
    @Environment(AppModel.self) private var appModel
    let id: String
    @State private var garden: GardenModel?
    @State private var entry: GardenEntry?
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
                    ToolbarItem(placement: .primaryAction) { Button("Edit entry") { correcting = true } }
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
                    Button("Retry") { Task { await refreshEntry() } }
                }
            } else {
                ProgressView()
            }
        }
        .porcelainScreen()
        .navigationTitle("Garden entry")
        .task(id: id) {
            let model = GardenModel(service: appModel.client)
            garden = model
            await model.load()
            await refreshEntry()
        }
        .refreshable { await refreshEntry() }
    }
    private func refreshEntry() async {
        error = nil
        do { entry = try await appModel.client.gardenEntry(id: id) } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Link targets and photo controls are siblings so previewing a photo never pushes the entry.
struct GardenEntrySummary: View {
    let entry: GardenEntry
    var linksToEntry = true
    private var title: String {
        let kind = entry.kind.rawValue.capitalized
        return entry.plantingID == nil ? "Whole-bed \(kind.lowercased())" : kind
    }
    private var heading: some View {
        VStack(alignment: .leading) {
            Text(title).font(.porcelainBody.weight(.semibold))
            Text(entry.observedAt.formatted(date: .abbreviated, time: .omitted)).font(.porcelainLabel)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if linksToEntry {
                NavigationLink(value: Route.entityDetail(.gardenEntry, id: entry.id)) { heading }
            } else {
                heading
            }
            NavigationLink(value: Route.entityDetail(.location, id: entry.locationID)) {
                Text(entry.locationName ?? "View location").font(.porcelainLabel)
            }
            if let plantingID = entry.plantingID {
                NavigationLink(value: Route.entityDetail(.planting, id: plantingID)) {
                    Text(entry.plantingName ?? "View planting").font(.porcelainLabel)
                }
            }
            if let amount = entry.harvestAmount {
                Text(entry.plantingID == nil ? "Bed harvest: \(amount)" : amount)
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
    @State private var entries: [GardenEntry] = []
    @State private var page = 1
    @State private var hasMore = false
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
                    Button("Add photos / Log entry") { adding = true }
                }
            }
            ForEach(entries) { GardenEntrySummary(entry: $0) }
            if let message {
                Section {
                    Text(message).foregroundStyle(PorcelainTokens.destructive)
                    Button("Retry") { Task { await load(reset: failedReset) } }
                }
            }
            if entries.isEmpty && !isLoading && message == nil {
                Text("No entries yet.").foregroundStyle(.secondary)
            }
            if hasMore {
                Button(isLoading ? "Loading…" : "Load more") { Task { await load() } }.disabled(isLoading)
            }
        }
        .overlay { if isLoading && entries.isEmpty { ProgressView() } }
        .navigationTitle(locationID == nil ? "Garden journal" : "\(locationName) journal")
        .task {
            let model = GardenModel(service: appModel.client)
            garden = model
            await model.load()
            await load(reset: true)
        }
        .refreshable { await load(reset: true) }
        .sheet(isPresented: $adding, onDismiss: { Task { await load(reset: true) } }) {
            if let garden, let locationID {
                GardenEntrySheet(
                    model: garden, target: .location(.init(id: locationID, name: locationName)),
                    uploader: GardenImageUploader(service: appModel.client))
            }
        }
    }
    private func load(reset: Bool = false) async {
        guard !isLoading else {
            if reset { pendingReset = true }
            return
        }
        isLoading = true
        message = nil
        defer {
            isLoading = false
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
        }
    }
}

#Preview {
    NavigationStack { GardenBedJournalView(locationID: nil) }.environment(PreviewFixtures.signedInModel())
}
