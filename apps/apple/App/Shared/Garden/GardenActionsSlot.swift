import CubbyKit
import SwiftUI

/// The planting hero's verbs (`startPlanting`, `movePlanting`, `splitPlanting`, `finishPlanting`)
/// plus the photo import: each opens a short sheet over `GardenActionsModel`. These stay explicit
/// RPCs because a move or split must atomically preserve the location history
/// (`docs/terminology.md` § Garden); everything else about a planting is the generic editor's.
@MainActor
@Observable
final class GardenActionsModel {
    let service: any GardenService
    private(set) var locations: [GardenOption] = []
    private(set) var isSaving = false
    private(set) var error: String?

    init(service: any GardenService) {
        self.service = service
    }

    func loadLocations() async {
        guard locations.isEmpty else { return }
        do {
            locations = try await service.gardenOptions(search: nil).locations
        } catch {
            self.error = Self.message(for: error)
            Diagnostics.report(error, context: "garden.actions.options")
        }
    }

    func start(id: String, at locationID: String, on date: Date, method: GardenStartMethod) async -> Bool {
        await save {
            try await self.service.startGardenPlanting(
                id: id, locationID: locationID, startedAt: date, method: method)
        }
    }

    func move(_ input: GardenMovePlantingInput) async -> Bool {
        await save { try await self.service.moveGardenPlanting(input) }
    }

    func split(_ input: GardenSplitPlantingInput) async -> Bool {
        await save { try await self.service.splitGardenPlanting(input) }
    }

    func finish(id: String, on date: Date, note: String?) async -> Bool {
        await save { try await self.service.finishGardenPlanting(id: id, finishedAt: date, note: note) }
    }

    private func save(_ operation: () async throws -> Void) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            try await operation()
            return true
        } catch {
            self.error = Self.message(for: error)
            Diagnostics.report(error, context: "garden.actions.save")
            return false
        }
    }

    private static func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}

enum GardenPlantingAction: String, Identifiable {
    case start = "startPlanting"
    case move = "movePlanting"
    case split = "splitPlanting"
    case finish = "finishPlanting"

    var id: String { rawValue }

    /// Each verb is simultaneously the trigger, the dialog title, and the submit label.
    var title: String {
        switch self {
        case .start: GardenStrings.startPlanting
        case .move: GardenStrings.moveEverything
        case .split: GardenStrings.moveSomeSeedlings
        case .finish: GardenStrings.finishPlanting
        }
    }

    var symbol: String {
        switch self {
        case .start: "play"
        case .move: "arrow.right"
        case .split: "arrow.triangle.branch"
        case .finish: "checkmark.circle"
        }
    }

    var explanation: String {
        switch self {
        case .start: GardenStrings.startPlantingExplanation
        case .move: GardenStrings.moveEverythingExplanation
        case .split: GardenStrings.moveSomeSeedlingsExplanation
        case .finish: GardenStrings.finishPlantingExplanation
        }
    }

    /// Which verbs a planting in `status` can take.
    func applies(to status: String?) -> Bool {
        switch self {
        case .start: status == "planned"
        case .move, .split: status == "growing"
        case .finish: status != "finished"
        }
    }
}

/// The hero action row for a planting: the declared verbs the row's status allows, and Import photos.
struct GardenPlantingActionsRow: View {
    let row: EntityRow
    let declared: [String]
    let onChanged: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var action: GardenPlantingAction?
    @State private var importing = false
    @State private var importItems: [PhotoSelectionItem]?

    private var status: String? { row.raw["status"]?.stringValue }

    private var actions: [GardenPlantingAction] {
        declared.compactMap(GardenPlantingAction.init(rawValue:)).filter { $0.applies(to: status) }
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: PorcelainTokens.Space.sm) {
                ForEach(actions) { verb in
                    Button(verb.title, systemImage: verb.symbol) { action = verb }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("detail.planting.action.\(verb.rawValue)")
                }
                Button("Import photos", systemImage: "photo.on.rectangle.angled") { importing = true }
                    .buttonStyle(.bordered)
            }
            .frame(minHeight: PorcelainTokens.touchTarget)
        }
        .scrollIndicators(.hidden)
        .sheet(item: $action) { verb in
            GardenPlantingActionSheet(
                model: GardenActionsModel(service: appModel.client), action: verb, planting: row
            ) {
                appModel.recordEntityMutation(keys: [.planting, .gardenEntry, .location])
                onChanged()
            }
            .environment(appModel)
        }
        .sheet(isPresented: $importing) {
            NavigationStack {
                Form {
                    Section("Choose photos") {
                        PhotoSourceButtons(maxSelectionCount: 12) { items in
                            importItems = items
                            importing = false
                        }
                    }
                }
                .formStyle(.grouped)
                .navigationTitle("Import photos")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { importing = false } }
                }
            }
            .nativeSheet(.adjustment)
            .environment(appModel)
        }
        .sheet(isPresented: Binding(get: { importItems != nil }, set: { if !$0 { importItems = nil } })) {
            if let importItems {
                GardenPhotoImportSheet(items: importItems) {
                    self.importItems = nil
                    appModel.recordEntityMutation(keys: [.planting, .gardenEntry, .location])
                    onChanged()
                }
                .environment(appModel)
            }
        }
    }
}

struct GardenPlantingActionSheet: View {
    let model: GardenActionsModel
    let action: GardenPlantingAction
    let planting: EntityRow
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var locationID = ""
    @State private var quantity = ""
    @State private var note = ""
    @State private var date = Date.now
    @State private var startMethod: GardenStartMethod = .sow
    @State private var draftDismissal = DraftDismissalState()
    private let initialDate: Date

    init(
        model: GardenActionsModel, action: GardenPlantingAction, planting: EntityRow,
        onSaved: @escaping () -> Void
    ) {
        self.model = model
        self.action = action
        self.planting = planting
        self.onSaved = onSaved
        let date = Date.now
        initialDate = date
        _date = State(initialValue: date)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(planting.title).font(.porcelainTitle)
                    Text(action.explanation).font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                if let error = model.error { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                if needsLocation {
                    Section("Destination") {
                        Picker(GardenStrings.location, selection: $locationID) {
                            Text("Choose…").tag("")
                            ForEach(model.locations) { Text($0.name).tag($0.id) }
                        }
                    }
                }
                if action == .start {
                    Section("How") {
                        Picker("Method", selection: $startMethod) {
                            ForEach(GardenStartMethod.allCases, id: \.self) { method in
                                Text(method.rawValue.capitalized).tag(method)
                            }
                        }
                    }
                }
                if action == .split {
                    Section("Amount") {
                        TextField(
                            GardenStrings.quantity, text: $quantity,
                            prompt: Text(GardenStrings.approximateQuantityPrompt))
                    }
                }
                Section("When") {
                    DatePicker(GardenStrings.date, selection: $date, displayedComponents: .date)
                }
                Section(GardenStrings.notes) {
                    TextField(
                        GardenStrings.notes, text: $note,
                        prompt: Text(GardenStrings.notesPlaceholder), axis: .vertical)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(action.title)
            .task { await model.loadLocations() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.isSaving ? "Close" : GardenStrings.cancel) {
                        draftDismissal.request(isDirty: isDirty, isSaving: model.isSaving, dismiss: dismiss)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action.title) { Task { await save() } }
                        .disabled((needsLocation && locationID.isEmpty) || model.isSaving)
                }
            }
        }
        .nativeSheet(.adjustment)
        .draftDismissal(
            $draftDismissal, isDirty: isDirty, isSaving: model.isSaving,
            onDiscard: { dismiss() }, onCloseWhileSaving: { dismiss() })
    }

    private var needsLocation: Bool { action != .finish }
    private var isDirty: Bool {
        !locationID.isEmpty || !quantity.isEmpty || !note.isEmpty || date != initialDate
            || startMethod != .sow
    }

    private func save() async {
        let saved: Bool
        switch action {
        case .start:
            saved = await model.start(id: planting.id, at: locationID, on: date, method: startMethod)
        case .move:
            saved = await model.move(
                GardenMovePlantingInput(
                    plantingId: planting.id, locationId: LocationCode(locationID), movedOn: PlainDate(date),
                    note: note.isEmpty ? nil : note))
        case .split:
            saved = await model.split(
                GardenSplitPlantingInput(
                    plantingId: planting.id, locationId: LocationCode(locationID), movedOn: PlainDate(date),
                    quantity: quantity.isEmpty ? nil : quantity, note: note.isEmpty ? nil : note))
        case .finish:
            saved = await model.finish(id: planting.id, on: date, note: note.isEmpty ? nil : note)
        }
        if saved {
            onSaved()
            dismiss()
        }
    }
}

#Preview("Move everything") {
    GardenPlantingActionSheet(
        model: GardenActionsModel(service: PreviewGardenService()), action: .move,
        planting: GardenPreviewFixtures.growingPlantingRow
    ) {}
}

#Preview("Finish planting") {
    GardenPlantingActionSheet(
        model: GardenActionsModel(service: PreviewGardenService()), action: .finish,
        planting: GardenPreviewFixtures.growingPlantingRow
    ) {}
}
