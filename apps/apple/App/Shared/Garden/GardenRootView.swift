import CubbyKit
import SwiftUI

/// A deliberately small garden home: what is growing by place, planning stays visible, and every
/// write is the generic editor or one of the four workflow verbs. Growing areas are ordinary
/// `.area` locations; their details, plantings and entries are the generic screens.
struct GardenRootView: View {
    /// The pseudo-location that groups plantings not yet in a bed or tray; never sent anywhere.
    static let unassignedID = LocationCode("unassigned")

    @Environment(AppModel.self) private var appModel
    @State private var garden: GardenModel?
    @State private var creating: GardenCreate?
    @State private var action: PendingAction?

    private struct PendingAction: Identifiable {
        let verb: GardenPlantingAction
        let planting: EntityRow
        var id: String { "\(verb.rawValue)-\(planting.id)" }
    }

    private enum GardenCreate: Identifiable {
        case planting
        case growingArea
        case entry(locationID: String?, plantingID: String?)

        var id: String {
            switch self {
            case .planting: "planting"
            case .growingArea: "growingArea"
            case .entry(let locationID, let plantingID): "entry-\(locationID ?? "")-\(plantingID ?? "")"
            }
        }

        var key: EntityKey {
            switch self {
            case .planting: .planting
            case .growingArea: .location
            case .entry: .gardenEntry
            }
        }

        var prefill: [String: JSONValue] {
            switch self {
            case .planting: return ["status": .string("growing")]
            case .growingArea: return ["type": .string("area")]
            case .entry(let locationID, let plantingID):
                var draft: [String: JSONValue] = ["observedOn": .string(PlainDate(.now).rawValue)]
                if let locationID { draft["locationId"] = .string(locationID) }
                if let plantingID { draft["plantingId"] = .string(plantingID) }
                return draft
            }
        }
    }

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
        .task(id: appModel.entityMutationRevision) {
            guard appModel.entityMutationRevision > 0,
                !appModel.entityMutationKeys.isDisjoint(with: [.planting, .gardenEntry, .location]),
                garden?.phase == .loaded
            else { return }
            await garden?.refresh()
        }
        .sheet(item: $creating) { create in
            EntityEditorSheet(key: create.key, mode: .create(prefill: create.prefill)) { _ in
                Task { await garden?.refresh() }
            }
            .environment(appModel)
        }
        .sheet(item: $action) { pending in
            GardenPlantingActionSheet(
                model: GardenActionsModel(service: appModel.client), action: pending.verb,
                planting: pending.planting
            ) {
                appModel.recordEntityMutation(keys: [.planting, .gardenEntry, .location])
            }
            .environment(appModel)
        }
        .toolbar {
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    creating = .growingArea
                } label: {
                    Label(GardenStrings.addGrowingArea, systemImage: "square.dashed")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    creating = .planting
                } label: {
                    Label(GardenStrings.addPlanting, systemImage: "plus")
                }
                .accessibilityIdentifier("garden.addPlanting")
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
                        Button(GardenStrings.addGrowingArea) { creating = .growingArea }
                    }
                    .frame(maxWidth: .infinity)
                }
                ForEach(garden.overview.locations) { location in
                    GardenLocationSection(
                        location: location,
                        onEntry: { creating = .entry(locationID: location.id.rawValue, plantingID: nil) },
                        onLogEntry: { planting in
                            creating = .entry(
                                locationID: planting.locationId?.rawValue, plantingID: planting.id)
                        },
                        onAction: { verb, planting in
                            action = PendingAction(verb: verb, planting: Self.row(planting))
                        }
                    )
                }
                if !garden.overview.unassigned.isEmpty {
                    GardenLocationSection(
                        location: GardenLocationSummaryOut(
                            id: Self.unassignedID,
                            name: GardenStrings.noLocationYet,
                            gardenKind: nil,
                            gardenConditions: nil,
                            plantings: garden.overview.unassigned
                        ),
                        onEntry: {},
                        onLogEntry: { planting in
                            creating = .entry(locationID: nil, plantingID: planting.id)
                        },
                        onAction: { verb, planting in
                            action = PendingAction(verb: verb, planting: Self.row(planting))
                        }
                    )
                }
                Section {
                    if !garden.overview.finished.isEmpty {
                        NavigationLink(
                            value: Route.entityList(
                                .planting, filters: EntityFilterState(["status": .many(["finished"])]))
                        ) {
                            Label(
                                "Finished plantings (\(garden.overview.finished.count))",
                                systemImage: "archivebox"
                            )
                            .font(.porcelainBody)
                        }
                    }
                    NavigationLink(value: Route.entityList(.gardenEntry)) {
                        Label(GardenStrings.gardenJournal, systemImage: "clock.arrow.circlepath")
                            .font(.porcelainBody)
                    }
                    .accessibilityHint("Browse past garden notes, harvests, moves, and photos")
                }
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

    /// The overview's planting as the generic screens read it, for the action sheets.
    private static func row(_ planting: GardenPlantingOut) -> EntityRow {
        let raw = (try? JSONValue(encoding: planting)) ?? .null
        return EntityCatalog[.planting].row(from: raw)
            ?? EntityRow(id: planting.id, title: planting.displayName, subtitle: nil, imageURL: nil, raw: raw)
    }
}

private struct GardenLocationSection: View {
    let location: GardenLocationSummaryOut
    let onEntry: () -> Void
    let onLogEntry: (GardenPlantingOut) -> Void
    let onAction: (GardenPlantingAction, GardenPlantingOut) -> Void

    var body: some View {
        Section {
            if location.plantings.isEmpty {
                Text("Nothing recorded here yet").foregroundStyle(.secondary)
            } else {
                ForEach(location.plantings) { planting in
                    GardenPlantingRow(planting: planting, onLogEntry: onLogEntry, onAction: onAction)
                }
            }
        } header: {
            HStack {
                if location.id == GardenRootView.unassignedID {
                    Text(location.name)
                } else {
                    NavigationLink(value: Route.entityDetail(.location, id: location.id.rawValue)) {
                        Text(location.name)
                    }
                    Spacer()
                    NavigationLink(
                        value: Route.entityList(
                            .gardenEntry,
                            filters: EntityFilterState(["locationId": .many([location.id.rawValue])]))
                    ) {
                        Label(GardenStrings.gardenJournal, systemImage: "clock.arrow.circlepath")
                    }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("\(location.name) journal")
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
        let detail = [location.gardenKind?.rawValue, location.gardenConditions].compactMap { $0 }
            .joined(separator: " · ")
        return detail.isEmpty ? nil : detail
    }
}

private struct GardenPlantingRow: View {
    let planting: GardenPlantingOut
    let onLogEntry: (GardenPlantingOut) -> Void
    let onAction: (GardenPlantingAction, GardenPlantingOut) -> Void

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            NavigationLink(value: Route.entityDetail(.planting, id: planting.id)) {
                HStack(spacing: PorcelainTokens.Space.md) {
                    Image(systemName: planting.status == .planned ? "calendar" : "leaf")
                        .foregroundStyle(PorcelainTokens.cobalt)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(planting.displayName).font(.porcelainBody.weight(.semibold))
                        Text(subtitle).font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                    Spacer(minLength: PorcelainTokens.Space.sm)
                }
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("garden.planting.\(planting.id)")
            Menu {
                Button {
                    onLogEntry(planting)
                } label: {
                    Label(GardenStrings.logEntry, systemImage: "square.and.pencil")
                }
                ForEach(
                    [GardenPlantingAction.start, .move, .split, .finish].filter {
                        $0.applies(to: planting.status.rawValue)
                    }
                ) { verb in
                    Button {
                        onAction(verb, planting)
                    } label: {
                        Label(verb.title, systemImage: verb.symbol)
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
            .compactMap { $0 }.filter { !$0.isEmpty }
        return details.joined(separator: " · ")
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { GardenRootView() }
}
