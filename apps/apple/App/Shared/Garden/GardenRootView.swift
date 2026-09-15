import CubbyKit
import SwiftUI

/// A deliberately small garden home: current lists by place, planning stays visible, and every
/// write starts with a short sheet rather than a spatial editor or a scheduler.
struct GardenRootView: View {
    @Environment(AppModel.self) private var appModel
    @State private var garden: GardenModel?
    @State private var showingCreate = false
    @State private var entryTarget: GardenEntryTarget?
    @State private var action: GardenPlantingAction?
    @State private var detailPlanting: GardenPlanting?
    @State private var showingFinished = false
    @State private var showingSetup = false

    var body: some View {
        Group {
            if let garden {
                content(garden)
            } else {
                LoadingIndicator.screen(label: "Loading garden")
            }
        }
        .porcelainScreen()
        .navigationTitle("Garden")
        .task(id: appModel.host) { await setup() }
        .sheet(isPresented: $showingCreate) {
            if let garden { GardenPlantingSheet(model: garden) }
        }
        .sheet(item: $entryTarget) { target in
            if let garden {
                GardenEntrySheet(
                    model: garden,
                    target: target,
                    uploader: GardenImageUploader(service: appModel.client)
                )
            }
        }
        .sheet(item: $action) { action in
            if let garden { GardenPlantingActionSheet(model: garden, action: action) }
        }
        .navigationDestination(item: $detailPlanting) { planting in
            if let garden {
                GardenPlantingDetailView(
                    model: garden, planting: planting, guide: garden.guide(for: planting.ingredient.id),
                    source: garden.guideSource, uploader: GardenImageUploader(service: appModel.client))
            }
        }
        .sheet(isPresented: $showingFinished) {
            if let garden { FinishedPlantingsSheet(plantings: garden.overview.finishedPlantings) }
        }
        .sheet(isPresented: $showingSetup) {
            if let garden { GardenSetupSheet(model: garden) }
        }
        .toolbar {
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    showingSetup = true
                } label: {
                    Label(GardenStrings.gardenSetup, systemImage: "slider.horizontal.3")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingCreate = true
                } label: {
                    Label(GardenStrings.addPlanting, systemImage: "plus")
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ garden: GardenModel) -> some View {
        switch garden.phase {
        case .idle, .loading:
            LoadingIndicator.screen(label: "Loading garden")
        case .failed(let message):
            ContentUnavailableView {
                Label(GardenStrings.couldNotLoadGarden, systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button(GardenStrings.retry) { Task { await garden.load() } }
            }
        case .loaded:
            List {
                if let error = garden.saveError {
                    Text(error)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.destructive)
                }
                if garden.guideError != nil {
                    Text("Planting guides are temporarily unavailable. You can still record the garden.")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                if garden.overview.locations.isEmpty {
                    ContentUnavailableView {
                        Label(GardenStrings.noGardenLocationsYet, systemImage: "leaf")
                    } description: {
                        Text(GardenStrings.noGardenLocationsDescription)
                    } actions: {
                        Button(GardenStrings.gardenSetup) { showingSetup = true }
                    }
                    .frame(maxWidth: .infinity)
                }
                ForEach(garden.overview.locations) { location in
                    GardenLocationSection(
                        location: location,
                        onEntry: { entryTarget = .location(location) },
                        onAction: { selection in
                            if case .entry(let planting) = selection {
                                entryTarget = .planting(planting)
                            } else {
                                action = selection
                            }
                        },
                        onDetail: { detailPlanting = $0 }
                    )
                }
                if !garden.overview.unassignedPlantings.isEmpty {
                    GardenLocationSection(
                        location: GardenLocation(
                            id: "unassigned",
                            name: GardenStrings.noLocationYet,
                            plantings: garden.overview.unassignedPlantings
                        ),
                        onEntry: {},
                        onAction: { selection in
                            if case .entry(let planting) = selection {
                                entryTarget = .planting(planting)
                            } else {
                                action = selection
                            }
                        },
                        onDetail: { detailPlanting = $0 }
                    )
                }
                if !garden.overview.finishedPlantings.isEmpty {
                    Button {
                        showingFinished = true
                    } label: {
                        Label(
                            "Finished plantings (\(garden.overview.finishedPlantings.count))",
                            systemImage: "archivebox"
                        )
                        .font(.porcelainBody)
                    }
                    .buttonStyle(.borderless)
                }
                NavigationLink {
                    GardenHistoryView(
                        model: garden, uploader: GardenImageUploader(service: appModel.client))
                } label: {
                    Label(GardenStrings.gardenJournal, systemImage: "clock.arrow.circlepath")
                        .font(.porcelainBody)
                }
                .accessibilityHint("Browse past garden notes, harvests, moves, and photos")
            }
            .accessibilityIdentifier("garden.overview")
            .refreshControl { await garden.refresh() }
        }
    }

    private func setup() async {
        let garden = GardenModel.SharedStore.model(for: appModel.client)
        self.garden = garden
        await garden.loadIfNeeded()
    }
}

private struct GardenLocationSection: View {
    let location: GardenLocation
    let onEntry: () -> Void
    let onAction: (GardenPlantingAction) -> Void
    let onDetail: (GardenPlanting) -> Void

    var body: some View {
        Section {
            if location.plantings.isEmpty {
                Text("Nothing recorded here yet").foregroundStyle(.secondary)
            } else {
                ForEach(location.plantings) { planting in
                    GardenPlantingRow(planting: planting, onAction: onAction, onDetail: onDetail)
                }
            }
        } header: {
            HStack {
                if location.id == "unassigned" {
                    Text(location.name)
                } else {
                    NavigationLink(value: Route.gardenBedJournal(id: location.id)) { Text(location.name) }
                    Spacer()
                    Button(action: onEntry) { Label(GardenStrings.logEntry, systemImage: "camera") }
                        .labelStyle(.iconOnly)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("\(GardenStrings.logEntry) at \(location.name)")
                }
            }
        } footer: {
            if let locationDetail { Text(locationDetail) }
        }
    }

    private var locationDetail: String? {
        [location.gardenKind, location.conditions].compactMap { $0 }.joined(separator: " · ").nilIfEmpty
    }
}

private struct GardenPlantingRow: View {
    let planting: GardenPlanting
    let onAction: (GardenPlantingAction) -> Void
    let onDetail: (GardenPlanting) -> Void

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            Button {
                onDetail(planting)
            } label: {
                HStack(spacing: PorcelainTokens.Space.md) {
                    Image(systemName: planting.status == .planned ? "calendar" : "leaf")
                        .foregroundStyle(PorcelainTokens.cobalt)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(planting.displayName).font(.porcelainBody.weight(.semibold))
                        Text(subtitle).font(.porcelainLabel).foregroundStyle(
                            PorcelainTokens.graphiteSecondary)
                    }
                    Spacer(minLength: PorcelainTokens.Space.sm)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("garden.planting.\(planting.id)")
            Menu {
                Button {
                    onDetail(planting)
                } label: {
                    Label(GardenStrings.viewPlanting, systemImage: "info.circle")
                }
                Button {
                    onAction(.entry(planting))
                } label: {
                    Label(GardenStrings.logEntry, systemImage: "square.and.pencil")
                }
                if planting.status == .planned {
                    Button {
                        onAction(.start(planting))
                    } label: {
                        Label(GardenStrings.startPlanting, systemImage: "play")
                    }
                }
                if planting.status != .finished {
                    if planting.status == .growing {
                        Button {
                            onAction(.move(planting))
                        } label: {
                            Label(GardenStrings.moveEverything, systemImage: "arrow.right")
                        }
                        Button {
                            onAction(.split(planting))
                        } label: {
                            Label(GardenStrings.moveSomeSeedlings, systemImage: "arrow.triangle.branch")
                        }
                    }
                    Button {
                        onAction(.finish(planting))
                    } label: {
                        Label(GardenStrings.finishPlanting, systemImage: "checkmark.circle")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(minWidth: PorcelainTokens.touchTarget, minHeight: PorcelainTokens.touchTarget)
            }
            .accessibilityLabel("More actions for \(planting.displayName)")
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        let details = [planting.status.rawValue.capitalized, planting.variety, planting.quantity]
            .compactMap { $0?.nilIfEmpty }
        return details.joined(separator: " · ")
    }
}

enum GardenEntryTarget: Identifiable {
    case location(GardenLocation)
    case planting(GardenPlanting)

    var id: String {
        switch self {
        case .location(let location): "location-\(location.id)"
        case .planting(let planting): "planting-\(planting.id)"
        }
    }

    var locationID: String? {
        switch self {
        case .location(let location): location.id
        case .planting(let planting): planting.location?.id
        }
    }

    var planting: GardenPlanting? {
        if case .planting(let planting) = self { return planting }
        return nil
    }
}

enum GardenPlantingAction: Identifiable {
    case entry(GardenPlanting)
    case start(GardenPlanting)
    case move(GardenPlanting)
    case split(GardenPlanting)
    case finish(GardenPlanting)

    var id: String {
        switch self {
        case .entry(let planting): "entry-\(planting.id)"
        case .start(let planting): "start-\(planting.id)"
        case .move(let planting): "move-\(planting.id)"
        case .split(let planting): "split-\(planting.id)"
        case .finish(let planting): "finish-\(planting.id)"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { GardenRootView() }
}
