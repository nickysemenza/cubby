import CubbyKit
import SwiftUI

/// The planting detail's `location-history` slot: the periods as rows, and a link into the
/// correction form. Reads `status`, `locationId`, `locationName` and `finishedOn` off the row.
struct GardenLocationHistorySlot: View {
    let row: EntityRow
    @Environment(AppModel.self) private var appModel
    @State private var history: GardenLocationHistoryModel?
    @State private var correcting = false

    var body: some View {
        if let history {
            if let error = history.error {
                Text(error).foregroundStyle(.secondary)
                Button(GardenStrings.retry) { Task { await history.load() } }
            } else if history.isLoading, history.periods.isEmpty {
                LoadingIndicator(label: "Loading location history")
            } else if history.periods.isEmpty {
                Text("No location dates recorded.").foregroundStyle(.secondary)
            }
            ForEach(history.periods) { period in
                NavigationLink(value: Route.entityDetail(.location, id: period.locationId.rawValue)) {
                    LabeledContent(period.locationName) {
                        Text(span(period)).font(.porcelainLabel).foregroundStyle(.secondary)
                    }
                }
            }
            Button(
                history.periods.isEmpty
                    ? GardenStrings.confirmLocationDates : GardenStrings.correctLocationDates,
                systemImage: "calendar.badge.clock"
            ) { correcting = true }
            .disabled(
                row.raw["status"]?.stringValue == "planned"
                    && row.raw["locationId"]?.stringValue == nil
            )
            .sheet(isPresented: $correcting, onDismiss: { Task { await history.load() } }) {
                NavigationStack {
                    GardenLocationHistoryEditor(history: history, planting: row)
                }
                .environment(appModel)
            }
        } else {
            LoadingIndicator(label: "Loading location history")
                .task {
                    let model = GardenLocationHistoryModel(service: appModel.client, plantingID: row.id)
                    history = model
                    await model.load()
                }
        }
    }

    private func span(_ period: GardenLocationPeriodOut) -> String {
        let since =
            period.inLocationSince.date?.formatted(date: .abbreviated, time: .omitted)
            ?? period.inLocationSince.rawValue
        let kind = period.startKind == .recorded ? " (\(GardenStrings.recordedAsLater.lowercased()))" : ""
        guard let ended = period.endedOn?.date else { return "\(since)\(kind) →" }
        return "\(since)\(kind) – \(ended.formatted(date: .abbreviated, time: .omitted))"
    }
}

/// Confirms or corrects a planting's location dates; adjacent periods share a boundary.
struct GardenLocationHistoryEditor: View {
    let history: GardenLocationHistoryModel
    let planting: EntityRow
    @State private var revised: [GardenLocationPeriodOut] = []
    @State private var initialLocationDate = Date.now
    @State private var initialLastDay = Date.now
    /// Set once from the *first* load, so the title never flips from "Confirm" to "Correct" the
    /// moment a not-yet-saved period is added locally (`docs/terminology.md` § Garden).
    @State private var hadExistingPeriods = false
    @State private var draftDismissal = DraftDismissalState()
    @Environment(\.dismiss) private var dismiss
    private let originalInitialLocationDate: Date
    private let originalInitialLastDay: Date

    init(history: GardenLocationHistoryModel, planting: EntityRow) {
        self.history = history
        self.planting = planting
        let initialLocationDate = Date.now
        let initialLastDay =
            planting.raw["finishedOn"]?.stringValue.flatMap { PlainDate(rawValue: $0).date } ?? .now
        originalInitialLocationDate = initialLocationDate
        originalInitialLastDay = initialLastDay
        _initialLocationDate = State(initialValue: initialLocationDate)
        _initialLastDay = State(initialValue: initialLastDay)
    }

    private var status: String { planting.raw["status"]?.stringValue ?? "" }
    private var isFinished: Bool { status == "finished" }

    private var title: String {
        hadExistingPeriods ? GardenStrings.correctLocationDates : GardenStrings.confirmLocationDates
    }

    var body: some View {
        Form {
            if let error = history.error {
                VStack(spacing: PorcelainTokens.Space.sm) {
                    ContentUnavailableView(
                        "Couldn't load location history", systemImage: "exclamationmark.triangle",
                        description: Text(error))
                    Button(GardenStrings.retry) {
                        Task {
                            await history.load()
                            revised = history.periods
                        }
                    }
                }
            }
            ForEach($revised) { $period in
                Section(period.locationName) {
                    DatePicker(
                        GardenStrings.inThisLocationSince,
                        selection: Binding(
                            get: { period.inLocationSince.date ?? .now },
                            set: { reviseBoundary(sequence: period.sequence, date: $0, start: true) }),
                        displayedComponents: .date)
                    LabeledContent(
                        "Recorded as",
                        value: period.startKind == .actual
                            ? GardenStrings.recordedAsActual : GardenStrings.recordedAsLater)
                    if period.startKind == .recorded {
                        Text(GardenStrings.earlierPresenceUnknown)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let ended = period.endedOn?.date {
                        DatePicker(
                            "Ended",
                            selection: Binding(
                                get: { ended },
                                set: { reviseBoundary(sequence: period.sequence, date: $0, start: false) }),
                            displayedComponents: .date)
                    } else {
                        Text("Current location").foregroundStyle(.secondary)
                    }
                }
            }
            if history.isLoading && revised.isEmpty { LoadingIndicator() }
            if revised.isEmpty, !history.isLoading, history.error == nil, status != "planned",
                let locationID = planting.raw["locationId"]?.stringValue
            {
                let location = GardenOption(
                    id: locationID, name: planting.raw["locationName"]?.stringValue ?? locationID)
                Section("Add location history") {
                    Text(
                        "No location date has been recorded for this planting. This does not create a sowing or transplant date."
                    )
                    .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    LabeledContent(GardenStrings.location, value: location.name)
                    DatePicker(
                        GardenStrings.inThisLocationSince, selection: $initialLocationDate,
                        displayedComponents: .date)
                    if isFinished {
                        DatePicker(
                            "Last day in this location", selection: $initialLastDay,
                            displayedComponents: .date)
                    }
                    Button("Record this date") { Task { await saveInitialPeriod(location: location) } }
                        .disabled(history.isSaving)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(title)
        .task {
            await history.load()
            revised = history.periods
            hadExistingPeriods = !history.periods.isEmpty
        }
        .disabled(history.isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(history.isSaving ? "Close" : GardenStrings.cancel) {
                    draftDismissal.request(isDirty: isDirty, isSaving: history.isSaving, dismiss: dismiss)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(GardenStrings.save) {
                    Task {
                        if await history.save(revised) {
                            revised = history.periods
                            dismiss()
                        }
                    }
                }
                .disabled(history.isSaving || revised.isEmpty)
            }
        }
        .nativeSheet(.editor)
        .draftDismissal(
            $draftDismissal, isDirty: isDirty, isSaving: history.isSaving,
            onDiscard: { dismiss() }, onCloseWhileSaving: { dismiss() })
    }

    private var isDirty: Bool {
        revised != history.periods || initialLocationDate != originalInitialLocationDate
            || initialLastDay != originalInitialLastDay
    }

    private func saveInitialPeriod(location: GardenOption) async {
        let first = GardenLocationPeriodOut(
            sequence: 0, locationId: LocationCode(location.id), locationName: location.name,
            inLocationSince: PlainDate(initialLocationDate),
            endedOn: isFinished ? PlainDate(initialLastDay) : nil, startKind: .actual)
        if await history.save([first]) {
            revised = history.periods
            dismiss()
        }
    }

    private func reviseBoundary(sequence: Int, date: Date, start: Bool) {
        guard let index = revised.firstIndex(where: { $0.sequence == sequence }) else { return }
        let day = PlainDate(date)
        if start {
            revised[index].inLocationSince = day
            if index > 0 { revised[index - 1].endedOn = day }
        } else {
            revised[index].endedOn = day
            if index + 1 < revised.count { revised[index + 1].inLocationSince = day }
        }
    }
}

#Preview("Location history") {
    NavigationStack {
        GardenLocationHistoryEditor(
            history: GardenLocationHistoryModel(service: PreviewGardenService(), plantingID: "PLT-4001"),
            planting: GardenPreviewFixtures.growingPlantingRow)
    }
}
