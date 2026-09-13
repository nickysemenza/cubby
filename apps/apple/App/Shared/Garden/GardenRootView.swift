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
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .porcelainScreen()
        .navigationTitle("Garden")
        .task(id: appModel.host) { await setup() }
        .sheet(isPresented: $showingCreate) {
            if let garden { GardenPlantingSheet(model: garden).gardenEditorSize() }
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
            if let garden { GardenPlantingActionSheet(model: garden, action: action).gardenEditorSize() }
        }
        .navigationDestination(item: $detailPlanting) { planting in
            if let garden {
                GardenPlantingDetailView(
                    model: garden, planting: planting, guide: garden.guide(for: planting.ingredient.id),
                    source: garden.guideSource, uploader: GardenImageUploader(service: appModel.client))
            }
        }
        .sheet(isPresented: $showingFinished) {
            if let garden {
                FinishedPlantingsSheet(plantings: garden.overview.finishedPlantings).gardenEditorSize()
            }
        }
        .sheet(isPresented: $showingSetup) {
            if let garden { GardenSetupSheet(model: garden).gardenEditorSize() }
        }
        .toolbar {
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    showingSetup = true
                } label: {
                    Label("Garden setup", systemImage: "slider.horizontal.3")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingCreate = true
                } label: {
                    Label("Add planting", systemImage: "plus")
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ garden: GardenModel) -> some View {
        switch garden.phase {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load the garden", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await garden.load() } }
            }
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
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
                        ContentUnavailableView(
                            "No garden locations yet",
                            systemImage: "leaf",
                            description: Text("Create a bed or tray in Locations, then add what is growing.")
                        )
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
                                name: "Planning without a location",
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
                        Label("Garden history", systemImage: "clock.arrow.circlepath")
                            .font(.porcelainBody)
                    }
                    .accessibilityHint("Browse past garden notes, harvests, moves, and photos")
                }
                .padding(PorcelainTokens.Space.lg)
                .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await garden.refresh() }
        }
    }

    private func setup() async {
        let garden = GardenModel(service: appModel.client)
        self.garden = garden
        await garden.load()
    }
}

private struct GardenLocationSection: View {
    let location: GardenLocation
    let onEntry: () -> Void
    let onAction: (GardenPlantingAction) -> Void
    let onDetail: (GardenPlanting) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    if location.id == "unassigned" {
                        Text(location.name).font(.porcelainTitle)
                    } else {
                        NavigationLink(value: Route.gardenBedJournal(id: location.id)) {
                            Text(location.name).font(.porcelainTitle)
                        }
                    }
                    if let detail = locationDetail {
                        Text(detail).font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
                Spacer()
                Button(action: onEntry) { Image(systemName: "camera") }
                    .accessibilityLabel("Log garden entry at \(location.name)")
            }
            Panel(padding: 0, spacing: 0) {
                if location.plantings.isEmpty {
                    Text("Nothing recorded here yet")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .padding(PorcelainTokens.Space.md)
                } else {
                    ForEach(Array(location.plantings.enumerated()), id: \.element.id) { index, planting in
                        if index > 0 { PanelDivider() }
                        GardenPlantingRow(planting: planting, onAction: onAction, onDetail: onDetail)
                    }
                }
            }
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
            Image(systemName: planting.status == .planned ? "calendar" : "leaf")
                .foregroundStyle(PorcelainTokens.cobalt)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(planting.ingredient.name).font(.porcelainBody.weight(.semibold))
                Text(subtitle).font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            Menu {
                Button {
                    onDetail(planting)
                } label: {
                    Label("View planting", systemImage: "info.circle")
                }
                Button {
                    onAction(.entry(planting))
                } label: {
                    Label("Log note, photo, or harvest", systemImage: "square.and.pencil")
                }
                if planting.status == .planned {
                    Button {
                        onAction(.start(planting))
                    } label: {
                        Label("Start planting", systemImage: "play")
                    }
                }
                if planting.status == .growing {
                    Button {
                        onAction(.move(planting))
                    } label: {
                        Label("Move all", systemImage: "arrow.right")
                    }
                    Button {
                        onAction(.split(planting))
                    } label: {
                        Label("Move some seedlings", systemImage: "arrow.triangle.branch")
                    }
                    Button(role: .destructive) {
                        onAction(.finish(planting))
                    } label: {
                        Label("Finish planting", systemImage: "checkmark.circle")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(minWidth: PorcelainTokens.touchTarget, minHeight: PorcelainTokens.touchTarget)
            }
        }
        .padding(PorcelainTokens.Space.md)
        .contentShape(Rectangle())
        .onTapGesture { onDetail(planting) }
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

#Preview {
    NavigationStack { GardenRootView() }.environment(PreviewFixtures.signedInModel())
}
