import CubbyKit
import SwiftUI

struct GardenPlantingSheet: View {
    let model: GardenModel
    @Environment(\.dismiss) private var dismiss
    @State private var ingredientID = ""
    @State private var locationID = ""
    @State private var intendedLocationID = ""
    @State private var productID = ""
    @State private var status: GardenPlantingStatus = .growing
    @State private var variety = ""
    @State private var quantity = ""
    @State private var plannedWindow = ""
    @State private var notes = ""
    @State private var useSowingDate = false
    @State private var sownAt = Date.now
    @State private var usePlannedDate = false
    @State private var plannedDate = Date.now
    @State private var useTransplantDate = false
    @State private var transplantedAt = Date.now
    @State private var useInLocationSince = false
    @State private var inLocationSince = Date.now
    @State private var inLocationSinceKind: GardenLocationStartKind = .actual
    @State private var rememberSource = false

    var body: some View {
        NavigationStack {
            Form {
                Section("What") {
                    GardenOptionPicker(
                        GardenStrings.crop, selection: $ingredientID, options: model.options.ingredients,
                        required: true)
                    GardenProductPicker(
                        GardenStrings.sourceProduct, selection: $productID, options: model.options.products)
                    if !productID.isEmpty, currentGrowsIngredientID != ingredientID.nilIfEmpty {
                        Toggle(GardenStrings.rememberSourceToggle, isOn: $rememberSource)
                    }
                    TextField(GardenStrings.variety, text: $variety)
                    TextField(
                        GardenStrings.quantity, text: $quantity,
                        prompt: Text(GardenStrings.approximateQuantityPrompt))
                }
                if let guide = model.guide(for: ingredientID) {
                    GardenGuideSection(guide: guide, source: model.guideSource)
                }
                Section("Where and when") {
                    Picker(GardenStrings.status, selection: $status) {
                        // No "Finished" creation state (G-10): a planting is created only as
                        // currently growing or as a future plan.
                        Text(GardenStrings.growingNow).tag(GardenPlantingStatus.growing)
                        Text(GardenStrings.planned).tag(GardenPlantingStatus.planned)
                    }
                    .pickerStyle(.segmented)
                    GardenOptionPicker(
                        status == .planned ? GardenStrings.plannedFor : GardenStrings.currentLocation,
                        selection: status == .planned ? $intendedLocationID : $locationID,
                        options: model.options.locations,
                        required: status == .growing
                    )
                    if status == .planned {
                        TextField(GardenStrings.planningWindow, text: $plannedWindow)
                        Toggle("Record planned date", isOn: $usePlannedDate)
                        if usePlannedDate {
                            DatePicker(
                                GardenStrings.plannedDate, selection: $plannedDate, displayedComponents: .date
                            )
                        }
                    } else {
                        Toggle("Record sowing date", isOn: $useSowingDate)
                        if useSowingDate {
                            DatePicker(GardenStrings.sowedOn, selection: $sownAt, displayedComponents: .date)
                        }
                        Toggle("Record transplant date", isOn: $useTransplantDate)
                        if useTransplantDate {
                            DatePicker(
                                GardenStrings.transplantedOn, selection: $transplantedAt,
                                displayedComponents: .date)
                        }
                        Toggle(GardenStrings.inThisLocationSince, isOn: $useInLocationSince)
                        if useInLocationSince {
                            DatePicker("Since", selection: $inLocationSince, displayedComponents: .date)
                        }
                    }
                }
                Section(GardenStrings.notes) {
                    TextField(
                        GardenStrings.notes, text: $notes, prompt: Text(GardenStrings.notesPlaceholder),
                        axis: .vertical)
                }
            }
            .porcelainForm()
            .navigationTitle(GardenStrings.addPlanting)
            .onChange(of: productID) { _, id in
                // Prefill only when the crop is still empty: picking a product must never clobber
                // a crop the person already chose (or already had prefilled from a different pick).
                guard ingredientID.isEmpty,
                    let ingredient = model.options.products.first(where: { $0.id == id })?.growsIngredientID
                else { return }
                ingredientID = ingredient
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(GardenStrings.save) { Task { await save() } }
                        .disabled(
                            ingredientID.isEmpty || (status == .growing && locationID.isEmpty)
                                || model.isSaving)
                }
            }
        }
    }

    private var currentGrowsIngredientID: String? {
        model.options.products.first(where: { $0.id == productID })?.growsIngredientID
    }

    private func save() async {
        let saved = await model.create(
            CreateGardenPlanting(
                ingredientID: ingredientID,
                locationID: locationID.nilIfEmpty,
                intendedLocationID: intendedLocationID.nilIfEmpty,
                productID: productID.nilIfEmpty,
                status: status,
                variety: variety.nilIfEmpty,
                quantity: quantity.nilIfEmpty,
                notes: notes.nilIfEmpty,
                plannedWindow: plannedWindow.nilIfEmpty,
                plannedDate: usePlannedDate ? plannedDate : nil,
                sownAt: useSowingDate ? sownAt : nil,
                transplantedAt: useTransplantDate ? transplantedAt : nil,
                inLocationSince: useInLocationSince ? inLocationSince : nil,
                inLocationSinceKind: inLocationSinceKind
            ),
            rememberSource: rememberSource
        )
        if saved { dismiss() }
    }
}

#Preview("Add planting") {
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    GardenPlantingSheet(model: model).task { await model.load() }
}

struct GardenEntrySheet: View {
    let model: GardenModel
    let target: GardenEntryTarget
    let uploader: GardenImageUploader
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind: GardenEntryKind = .observation
    @State private var observedAt = Date.now
    @State private var dateWasEdited = false
    @State private var note = ""
    @State private var harvestAmount = ""
    @State private var selections: [PhotoSelectionItem] = []
    @State private var uploadStatus: String?
    @State private var uploadError: String?
    @State private var uploadedIDs: [ImageCode] = []
    @State private var isUploading = false
    @State private var photoDateNeedsConfirmation = false
    @State private var saveTask: Task<Void, Never>?
    @State private var locationID: String
    @State private var plantingID: String

    init(model: GardenModel, target: GardenEntryTarget, uploader: GardenImageUploader) {
        self.model = model; self.target = target; self.uploader = uploader
        _locationID = State(initialValue: target.locationID ?? "")
        _plantingID = State(initialValue: target.planting?.id ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Entry") {
                    Picker(GardenStrings.entryKind, selection: $kind) {
                        Text(GardenStrings.note).tag(GardenEntryKind.observation)
                        Text(GardenStrings.harvest).tag(GardenEntryKind.harvest)
                    }
                    .pickerStyle(.segmented)
                    GardenObservationDatePicker(
                        label: kind == .harvest ? GardenStrings.harvestDate : GardenStrings.date,
                        selection: Binding(
                            get: { observedAt },
                            set: {
                                dateWasEdited = true
                                photoDateNeedsConfirmation = false
                                observedAt = $0
                            }))
                    GardenOptionPicker(
                        GardenStrings.location, selection: $locationID, options: model.options.locations,
                        required: true)
                    GardenOptionPicker(
                        GardenStrings.about, selection: $plantingID, options: model.allPlantingOptions,
                        noneLabel: GardenStrings.wholeArea)
                    if kind == .harvest { TextField(GardenStrings.harvestAmount, text: $harvestAmount) }
                    TextField(GardenStrings.note, text: $note, axis: .vertical)
                }
                if let error = model.saveError { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                Section("Photos") {
                    PhotoBatch(
                        photos: selections.map {
                            PhotoAttachment(
                                id: $0.id, filename: gardenPhotoLabel($0), source: .local($0.preview),
                                imageID: $0.existingImageID?.rawValue,
                                status: $0.existingImageID == nil ? nil : "Uploaded")
                        },
                        onRemove: isUploading
                            ? nil
                            : { id in
                                selections.removeAll { $0.id == id }
                                applyPhotoDateIfPossible()
                            }
                    )
                    .gardenPhotoGridWidth()
                    GardenPhotoSourceButtons(maxSelectionCount: remainingPhotoCapacity) {
                        selections.append(contentsOf: $0)
                        applyPhotoDateIfPossible()
                    }
                    if photoDateNeedsConfirmation {
                        Text(
                            "These photos have different or unavailable capture dates. Choose the entry date."
                        )
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.destructive)
                        Button("Use \(observedAt.formatted(date: .abbreviated, time: .omitted))") {
                            dateWasEdited = true
                            photoDateNeedsConfirmation = false
                        }
                    }
                    if let uploadStatus { Text(uploadStatus).font(.porcelainLabel) }
                    if let uploadError {
                        Text(uploadError).font(.porcelainLabel).foregroundStyle(PorcelainTokens.destructive)
                    }
                    if let photoSelectionError {
                        Text(photoSelectionError).font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .porcelainForm()
            .disabled(isUploading || model.isSaving)
            .navigationTitle(kind == .harvest ? "Log harvest" : GardenStrings.logEntry)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(GardenStrings.cancel) { dismiss() }.disabled(model.isSaving || isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(GardenStrings.save) { startSave() }
                        .disabled(
                            locationID.isEmpty || model.isSaving || isUploading
                                || photoSelectionError != nil || photoDateNeedsConfirmation)
                }
            }
        }
        .interactiveDismissDisabled(isUploading || model.isSaving)
        .onDisappear { saveTask?.cancel() }
    }

    private func startSave() {
        guard saveTask == nil else { return }
        saveTask = Task {
            await save()
            saveTask = nil
        }
    }

    private func save() async {
        guard !locationID.isEmpty, !isUploading, photoSelectionError == nil,
            !photoDateNeedsConfirmation
        else { return }
        uploadError = nil
        isUploading = true
        defer { isUploading = false }
        do {
            try Task.checkCancellation()
            try await uploadNewSelections()
            try Task.checkCancellation()
        } catch is CancellationError {
            return
        } catch {
            uploadError = error.localizedDescription
            Diagnostics.report(error, context: "garden.entry.upload")
            return
        }
        let saved = await model.record(
            RecordGardenEntry(
                locationID: locationID, plantingID: plantingID.nilIfEmpty, kind: kind,
                observedAt: observedAt,
                note: note.nilIfEmpty, harvestAmount: kind == .harvest ? harvestAmount.nilIfEmpty : nil,
                pendingImageIDs: uploadedIDs))
        guard !Task.isCancelled else { return }
        if saved {
            if !uploadedIDs.isEmpty, let client = model.service as? CubbyClient,
                appModel.client === client
            {
                await appModel.photoMatches.refresh(client: client)
            }
            guard !Task.isCancelled else { return }
            dismiss()
        }
    }

    private func uploadNewSelections() async throws {
        let resolver = GardenPhotoSelectionResolver(sourceItems: selections) { file in
            try Task.checkCancellation()
            let ids = try await uploader.upload([file]) { step in
                Task { @MainActor in
                    uploadStatus =
                        switch step {
                        case .encoding(_, _): "Preparing photo…"
                        case .uploading(_, _): "Uploading photo…"
                        case .done: nil
                        }
                }
            }
            guard let imageID = ids.first else { throw GardenPhotoSelectionResolver.Failure.emptyUpload }
            return imageID
        }
        defer {
            for index in selections.indices {
                if let imageID = resolver.resolvedBySelectionID[selections[index].id] {
                    selections[index].existingImageID = imageID
                }
            }
            uploadedIDs = uniqueImageIDs(selections.compactMap(\.existingImageID))
        }
        let resolution = try await resolver.resolve(selections)
        uploadedIDs = resolution.imageIDs
    }

    private func applyPhotoDateIfPossible() {
        guard !dateWasEdited else { return }
        guard !selections.isEmpty else {
            photoDateNeedsConfirmation = false
            return
        }
        guard
            let first = selections.first?.capturedAt,
            let day = Calendar.current.dateInterval(of: .day, for: first)?.start,
            selections.allSatisfy({
                guard let date = $0.capturedAt else { return false }
                return Calendar.current.isDate(date, inSameDayAs: first)
            })
        else {
            photoDateNeedsConfirmation = true
            return
        }
        observedAt = day
        photoDateNeedsConfirmation = false
    }

    private var photoSelectionError: String? {
        if selections.count > 20 { return "A garden entry can contain at most 20 photos." }
        return GardenPhotoSelectionResolver.validationError(for: selections)
    }

    private var remainingPhotoCapacity: Int { max(0, 20 - selections.count) }
}

#Preview("Garden entry (whole area)") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    GardenEntrySheet(
        model: model, target: .location(GardenPreviewFixtures.overview.locations[0]),
        uploader: GardenImageUploader(service: appModel.client)
    )
    .environment(appModel)
    .task { await model.load() }
}

#Preview("Log harvest") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    GardenEntrySheet(
        model: model, target: .planting(GardenPreviewFixtures.growingPlanting),
        uploader: GardenImageUploader(service: appModel.client)
    )
    .environment(appModel)
    .task { await model.load() }
}

struct GardenPlantingActionSheet: View {
    let model: GardenModel
    let action: GardenPlantingAction
    @Environment(\.dismiss) private var dismiss
    @State private var locationID = ""
    @State private var quantity = ""
    @State private var note = ""
    @State private var date = Date.now
    @State private var startMethod: GardenStartMethod = .sow

    private var planting: GardenPlanting {
        switch action {
        case .entry(let planting), .start(let planting), .move(let planting), .split(let planting),
            .finish(let planting):
            planting
        }
    }

    private var title: String {
        switch action {
        case .entry: GardenStrings.logEntry
        case .start: GardenStrings.startPlanting
        case .move: GardenStrings.moveEverything
        case .split: GardenStrings.moveSomeSeedlings
        case .finish: GardenStrings.finishPlanting
        }
    }

    /// Each verb is simultaneously the trigger, the dialog title, and the submit label
    /// (`docs/terminology.md` § Garden); this is the explanation shown underneath it.
    private var explanation: String {
        switch action {
        case .entry: ""
        case .start: GardenStrings.startPlantingExplanation
        case .move: GardenStrings.moveEverythingExplanation
        case .split: GardenStrings.moveSomeSeedlingsExplanation
        case .finish: GardenStrings.finishPlantingExplanation
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(planting.displayName).font(.porcelainTitle)
                    if !explanation.isEmpty {
                        Text(explanation).font(.porcelainLabel).foregroundStyle(
                            PorcelainTokens.graphiteSecondary)
                    }
                }
                if needsLocation {
                    Section("Destination") {
                        GardenOptionPicker(
                            GardenStrings.location, selection: $locationID, options: model.options.locations,
                            required: true)
                    }
                }
                if case .start = action {
                    Section("How") {
                        Picker("Method", selection: $startMethod) {
                            ForEach(GardenStartMethod.allCases, id: \.self) { method in
                                Text(method.rawValue.capitalized).tag(method)
                            }
                        }
                    }
                }
                if isSplit {
                    Section("Amount") {
                        TextField(
                            GardenStrings.quantity, text: $quantity,
                            prompt: Text(GardenStrings.approximateQuantityPrompt))
                    }
                }
                Section("When") {
                    DatePicker(GardenStrings.date, selection: $date, displayedComponents: .date)
                }
                if needsNote {
                    Section(GardenStrings.notes) {
                        TextField(
                            GardenStrings.notes, text: $note, prompt: Text(GardenStrings.notesPlaceholder),
                            axis: .vertical)
                    }
                }
            }
            .porcelainForm()
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(GardenStrings.save) { Task { await save() } }
                        .disabled((needsLocation && locationID.isEmpty) || model.isSaving)
                }
            }
        }
    }

    private var needsLocation: Bool {
        switch action {
        case .start, .move, .split: true;
        case .entry, .finish: false
        }
    }
    private var isSplit: Bool { if case .split = action { true } else { false } }
    private var needsNote: Bool { if case .entry = action { false } else { true } }

    private func save() async {
        let saved: Bool
        switch action {
        case .entry:
            // This path is routed through the dedicated entry editor so it can include photos.
            saved = false
        case .start(let planting):
            saved = await model.start(id: planting.id, at: locationID, on: date, method: startMethod)
        case .move(let planting):
            saved = await model.move(
                MoveGardenPlanting(
                    plantingID: planting.id, destinationLocationID: locationID, observedAt: date,
                    note: note.nilIfEmpty))
        case .split(let planting):
            saved = await model.split(
                SplitGardenPlanting(
                    plantingID: planting.id, destinationLocationID: locationID, quantity: quantity.nilIfEmpty,
                    observedAt: date, note: note.nilIfEmpty))
        case .finish(let planting):
            saved = await model.finish(id: planting.id, on: date, note: note.nilIfEmpty)
        }
        if saved { dismiss() }
    }
}

#Preview("Move everything") {
    GardenPlantingActionSheet(
        model: GardenModel(service: PreviewGardenService()),
        action: .move(GardenPreviewFixtures.growingPlanting))
}

#Preview("Finish planting") {
    GardenPlantingActionSheet(
        model: GardenModel(service: PreviewGardenService()),
        action: .finish(GardenPreviewFixtures.growingPlanting))
}

struct FinishedPlantingsSheet: View {
    let plantings: [GardenPlanting]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(plantings) { planting in
                NavigationLink {
                    GardenPlantingRouteView(id: planting.id)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(planting.displayName).font(.porcelainBody.weight(.semibold))
                        Text(planting.status.rawValue.capitalized).font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        if let date = planting.sownAt {
                            Text(
                                "\(GardenStrings.sowedOn): \(date.formatted(date: .abbreviated, time: .omitted))"
                            )
                            .font(.porcelainLabel)
                        }
                        if let date = planting.finishedAt {
                            Text(
                                "Finished: \(date.formatted(date: .abbreviated, time: .omitted))"
                            )
                            .font(.porcelainLabel)
                        }
                    }
                }
            }
            .porcelainForm()
            .navigationTitle("Finished plantings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.done) { dismiss() } }
            }
        }
    }
}

#Preview("Finished plantings") {
    FinishedPlantingsSheet(plantings: [GardenPreviewFixtures.finishedPlanting])
}

struct GardenPlantingDetailView: View {
    let model: GardenModel
    let planting: GardenPlanting
    let guide: GardenGuide?
    let source: (String) -> GardenGuideSource?
    let uploader: GardenImageUploader
    @State private var editing = false
    @State private var loggingEntry = false
    @State private var pendingAction: GardenPlantingAction?
    @State private var showingLocationHistory = false
    @State private var section: DetailSection = .journal

    private enum DetailSection: String, CaseIterable, Identifiable {
        case journal = "Journal", about = "About"
        var id: String { rawValue }
    }

    var body: some View {
        let planting = model.allPlantings.first(where: { $0.id == self.planting.id }) ?? self.planting
        List {
            Picker("View", selection: $section) {
                ForEach(DetailSection.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            if section == .journal {
                GardenPlantingJournal(model: model, planting: planting, uploader: uploader)
            } else {
                Section(GardenStrings.about) {
                    NavigationLink(value: Route.entityDetail(.ingredient, id: planting.ingredient.id)) {
                        LabeledContent(GardenStrings.crop, value: planting.ingredient.name)
                    }
                    LabeledContent(GardenStrings.status, value: planting.status.rawValue.capitalized)
                    if let variety = planting.variety {
                        LabeledContent(GardenStrings.variety, value: variety)
                    }
                    if let quantity = planting.quantity {
                        LabeledContent(GardenStrings.quantity, value: quantity)
                    }
                    if let location = planting.location {
                        NavigationLink(value: Route.entityDetail(.location, id: location.id)) {
                            LabeledContent(GardenStrings.location, value: location.name)
                        }
                        NavigationLink(value: Route.gardenBedJournal(id: location.id)) {
                            Text(GardenStrings.areaJournal(location.name))
                        }
                    } else if let intended = planting.intendedLocation {
                        NavigationLink(value: Route.entityDetail(.location, id: intended.id)) {
                            LabeledContent(GardenStrings.intendedDestination, value: intended.name)
                        }
                    }
                    NavigationLink("Location history") {
                        GardenLocationHistoryView(service: model.service, planting: planting)
                    }
                    if let parentID = planting.parentPlantingID {
                        NavigationLink(value: Route.entityDetail(.planting, id: parentID)) {
                            Text(GardenStrings.originalTrayPlanting)
                        }
                    }
                    if let planned = planting.plannedWindow { LabeledContent("Plan", value: planned) }
                    if let date = planting.plannedDate {
                        LabeledContent(
                            GardenStrings.plannedDate,
                            value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let date = planting.sownAt {
                        LabeledContent(
                            GardenStrings.sowedOn, value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let date = planting.transplantedAt {
                        LabeledContent(
                            GardenStrings.transplantedOn,
                            value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let sourceProduct = planting.product {
                        NavigationLink(value: Route.entityDetail(.product, id: sourceProduct.id)) {
                            LabeledContent(GardenStrings.source, value: sourceProduct.name)
                        }
                    }
                    if let date = planting.finishedAt {
                        LabeledContent("Finished", value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                }
                if let notes = planting.notes { Section(GardenStrings.notes) { Text(notes) } }
                if let guide {
                    Section(GardenStrings.plantingGuide) {
                        DisclosureGroup("Show guide") {
                            ForEach(guide.windows) { window in
                                GardenGuideWindowDetail(window: window, source: source(window.sourceID))
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(planting.displayName)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Menu {
                    Button {
                        loggingEntry = true
                    } label: {
                        Label(GardenStrings.logEntry, systemImage: "square.and.pencil")
                    }
                    if planting.status == .growing {
                        Button {
                            pendingAction = .move(planting)
                        } label: {
                            Label(GardenStrings.moveEverything, systemImage: "arrow.right")
                        }
                        Button {
                            pendingAction = .split(planting)
                        } label: {
                            Label(GardenStrings.moveSomeSeedlings, systemImage: "arrow.triangle.branch")
                        }
                    }
                    Button {
                        showingLocationHistory = true
                    } label: {
                        Label(GardenStrings.correctLocationDates, systemImage: "calendar.badge.clock")
                    }
                    if planting.status != .finished {
                        Button {
                            pendingAction = .finish(planting)
                        } label: {
                            Label(GardenStrings.finishPlanting, systemImage: "checkmark.circle")
                        }
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis.circle")
                }
                Button("Edit") { editing = true }
            }
        }
        .sheet(isPresented: $editing) {
            GardenPlantingCorrectionSheet(model: model, planting: planting)
        }
        .sheet(isPresented: $loggingEntry) {
            GardenEntrySheet(model: model, target: .planting(planting), uploader: uploader)
        }
        .sheet(item: $pendingAction) { action in
            GardenPlantingActionSheet(model: model, action: action)
        }
        .navigationDestination(isPresented: $showingLocationHistory) {
            GardenLocationHistoryView(service: model.service, planting: planting)
        }
    }
}

private struct GardenGuideWindowDetail: View {
    let window: GardenGuideWindow
    let source: GardenGuideSource?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(summary).font(.porcelainBody.weight(.semibold))
            if let note = window.note { Text(note).font(.porcelainLabel) }
            if let source {
                Link(GardenStrings.viewSource, destination: source.url).font(.porcelainLabel)
                if let published = source.publishedOrRevised {
                    Text("\(GardenStrings.publishedOrRevised): \(published)").font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Text("\(GardenStrings.reviewed): \(source.reviewedAt)").font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                if !source.basedOn.isEmpty {
                    Text("\(GardenStrings.basedOn): \(source.basedOn.joined(separator: "; "))")
                        .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Text(GardenStrings.sourcesMayDiffer).font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var summary: String {
        let monthNames = window.months.compactMap { Calendar.current.monthSymbols[safe: $0 - 1] }
        let scope = [window.microclimate, window.monthPart].compactMap { $0 }.joined(separator: " · ")
        return [window.method, monthNames.joined(separator: ", "), scope].filter { !$0.isEmpty }.joined(
            separator: " · ")
    }
}

#Preview("Planting detail") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    NavigationStack {
        GardenPlantingDetailView(
            model: model, planting: GardenPreviewFixtures.growingPlanting,
            guide: GardenPreviewFixtures.guides.guides.first,
            source: { id in GardenPreviewFixtures.guides.sources.first(where: { $0.id == id }) },
            uploader: GardenImageUploader(service: appModel.client))
    }
    .environment(appModel)
    .task { await model.load() }
}

private struct GardenPlantingCorrectionSheet: View {
    let model: GardenModel; let planting: GardenPlanting
    @Environment(\.dismiss) private var dismiss
    @State private var ingredientID: String; @State private var productID: String;
    @State private var intendedID: String
    @State private var variety: String; @State private var quantity: String; @State private var notes: String;
    @State private var window: String
    @State private var planned: Date; @State private var sowed: Date; @State private var transplanted: Date
    @State private var hasPlanned: Bool; @State private var hasSowed: Bool;
    @State private var hasTransplanted: Bool
    init(model: GardenModel, planting: GardenPlanting) {
        self.model = model; self.planting = planting
        _ingredientID = State(initialValue: planting.ingredient.id);
        _productID = State(initialValue: planting.product?.id ?? "");
        _intendedID = State(initialValue: planting.intendedLocation?.id ?? "")
        _variety = State(initialValue: planting.variety ?? "");
        _quantity = State(initialValue: planting.quantity ?? "");
        _notes = State(initialValue: planting.notes ?? "");
        _window = State(initialValue: planting.plannedWindow ?? "")
        _planned = State(initialValue: planting.plannedDate ?? .now);
        _sowed = State(initialValue: planting.sownAt ?? .now);
        _transplanted = State(initialValue: planting.transplantedAt ?? .now)
        _hasPlanned = State(initialValue: planting.plannedDate != nil);
        _hasSowed = State(initialValue: planting.sownAt != nil);
        _hasTransplanted = State(initialValue: planting.transplantedAt != nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                GardenOptionPicker(
                    GardenStrings.crop, selection: $ingredientID, options: model.options.ingredients,
                    required: true)
                GardenProductPicker(
                    GardenStrings.sourceProduct, selection: $productID, options: model.options.products)
                GardenOptionPicker(
                    "Intended location", selection: $intendedID, options: model.options.locations)
                TextField(GardenStrings.variety, text: $variety)
                TextField(
                    GardenStrings.quantity, text: $quantity,
                    prompt: Text(GardenStrings.approximateQuantityPrompt))
                TextField(GardenStrings.planningWindow, text: $window)
                TextField(
                    GardenStrings.notes, text: $notes, prompt: Text(GardenStrings.notesPlaceholder),
                    axis: .vertical)
                Toggle(GardenStrings.plannedDate, isOn: $hasPlanned)
                if hasPlanned {
                    DatePicker(GardenStrings.plannedDate, selection: $planned, displayedComponents: .date)
                }
                Toggle("Sowing date", isOn: $hasSowed)
                if hasSowed {
                    DatePicker(GardenStrings.sowedOn, selection: $sowed, displayedComponents: .date)
                }
                Toggle("Transplant date", isOn: $hasTransplanted)
                if hasTransplanted {
                    DatePicker(
                        GardenStrings.transplantedOn, selection: $transplanted, displayedComponents: .date)
                }
            }
            .porcelainForm()
            .navigationTitle(GardenStrings.editPlanting)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(GardenStrings.save) { Task { await save() } }.disabled(
                        ingredientID.isEmpty || model.isSaving)
                }
            }
        }
    }
    private func save() async {
        let input = EditGardenPlanting(
            id: planting.id, ingredientID: ingredientID, productID: productID.nilIfEmpty,
            intendedLocationID: intendedID.nilIfEmpty, variety: variety.nilIfEmpty,
            quantity: quantity.nilIfEmpty, notes: notes.nilIfEmpty, plannedWindow: window.nilIfEmpty,
            plannedDate: hasPlanned ? planned : nil, sownAt: hasSowed ? sowed : nil,
            transplantedAt: hasTransplanted ? transplanted : nil)
        if await model.updatePlanting(input) { dismiss() }
    }
}

#Preview("Edit planting") {
    GardenPlantingCorrectionSheet(
        model: GardenModel(service: PreviewGardenService()), planting: GardenPreviewFixtures.growingPlanting)
}

/// A photo-tile grid inside a `Form` can otherwise propose an unbounded width on macOS (the row
/// is not clipped to the sheet like an iOS `List` section is), pushing tiles past the sheet's own
/// edge. Capping the grid's width to the sheet's own `idealWidth` keeps it inside the sheet at
/// every size the sheet can actually be.
extension View {
    func gardenPhotoGridWidth() -> some View {
        frame(maxWidth: 600)
    }
}

private struct GardenOptionPicker: View {
    let title: String
    @Binding var selection: String
    let options: [GardenOption]
    var required = false
    var noneLabel = "None"

    init(
        _ title: String, selection: Binding<String>, options: [GardenOption], required: Bool = false,
        noneLabel: String = "None"
    ) {
        self.title = title
        _selection = selection
        self.options = options
        self.required = required
        self.noneLabel = noneLabel
    }

    var body: some View {
        Picker(title, selection: $selection) {
            Text(required ? "Choose…" : noneLabel).tag("")
            ForEach(options) { option in Text(option.name).tag(option.id) }
        }
    }
}

private struct GardenProductPicker: View {
    let title: String
    @Binding var selection: String
    let options: [GardenProductOption]

    init(_ title: String, selection: Binding<String>, options: [GardenProductOption]) {
        self.title = title
        _selection = selection
        self.options = options
    }

    var body: some View {
        Picker(title, selection: $selection) {
            Text("None").tag("")
            ForEach(options) { option in Text(option.name).tag(option.id) }
        }
    }
}

private struct GardenGuideSection: View {
    let guide: GardenGuide
    let source: (String) -> GardenGuideSource?

    var body: some View {
        Section(GardenStrings.plantingGuide) {
            ForEach(guide.windows) { window in
                VStack(alignment: .leading, spacing: 2) {
                    Text(source(window.sourceID)?.name ?? window.sourceID).font(
                        .porcelainBody.weight(.semibold))
                    Text(months(for: window)).font(.porcelainLabel).foregroundStyle(
                        PorcelainTokens.graphiteSecondary)
                    if let note = window.note { Text(note).font(.porcelainLabel) }
                }
            }
        }
    }

    private func months(for window: GardenGuideWindow) -> String {
        let names = window.months.compactMap { Calendar.current.monthSymbols[safe: $0 - 1] }
        return "\(window.method.capitalized): \(names.joined(separator: ", "))"
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Setup stays separate from daily logging so entering a harvest never turns into maintaining a
/// directory. These controls expose the three additive associations Garden v1 introduces. The
/// lists themselves are the garden-scoped set the server already returned; "Add…" is the escape
/// hatch to widen that scope by searching for anything else in the household.
struct GardenSetupSheet: View {
    let model: GardenModel
    @Environment(\.dismiss) private var dismiss
    @State private var addingProduct = false
    @State private var addingIngredient = false
    @State private var newProduct: GardenProductOption?
    @State private var newIngredient: GardenOption?

    var body: some View {
        NavigationStack {
            List {
                Section(GardenStrings.growingAreas) {
                    NavigationLink {
                        GardenLocationForm(model: model, location: nil)
                    } label: {
                        Label(GardenStrings.addBedOrTray, systemImage: "plus")
                    }
                    ForEach(model.overview.locations) { location in
                        NavigationLink {
                            GardenLocationForm(model: model, location: location)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(location.name)
                                if let kind = location.gardenKind { Text(kind.capitalized).font(.caption) }
                            }
                        }
                    }
                }
                Section(GardenStrings.seedPacketsAndPlants) {
                    ForEach(model.options.products) { product in
                        NavigationLink {
                            GardenProductForm(model: model, product: product)
                        } label: {
                            LabeledContent(
                                product.name,
                                value: ingredientName(product.growsIngredientID) ?? GardenStrings.notSet)
                        }
                    }
                    Button {
                        addingProduct = true
                    } label: {
                        Label(GardenStrings.addEllipsis, systemImage: "plus")
                    }
                }
                Section(GardenStrings.cropGuides) {
                    ForEach(model.options.ingredients) { ingredient in
                        NavigationLink {
                            GardenIngredientForm(model: model, ingredient: ingredient)
                        } label: {
                            LabeledContent(
                                ingredient.name, value: ingredient.gardenGuideKey ?? GardenStrings.notSet)
                        }
                    }
                    Button {
                        addingIngredient = true
                    } label: {
                        Label(GardenStrings.addEllipsis, systemImage: "plus")
                    }
                }
            }
            .porcelainForm()
            .navigationTitle(GardenStrings.gardenSetup)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.done) { dismiss() } }
            }
            .sheet(isPresented: $addingProduct) {
                GardenAddProductSheet(model: model) { newProduct = $0 }
            }
            .sheet(isPresented: $addingIngredient) {
                GardenAddIngredientSheet(model: model) { newIngredient = $0 }
            }
            .navigationDestination(item: $newProduct) { GardenProductForm(model: model, product: $0) }
            .navigationDestination(item: $newIngredient) {
                GardenIngredientForm(model: model, ingredient: $0)
            }
        }
    }

    private func ingredientName(_ id: String?) -> String? {
        guard let id else { return nil }
        return model.options.ingredients.first(where: { $0.id == id })?.name
    }
}

#Preview("Garden setup") {
    GardenSetupSheet(model: GardenModel(service: PreviewGardenService()))
}

/// A minimal search picker over the household's full set, for a crop or product the garden-scoped
/// list does not carry yet. `GardenModel.searchOptions` widens the scoped `options` on the fly;
/// results already in the scoped set are filtered out since picking them again would do nothing.
private struct GardenAddProductSheet: View {
    let model: GardenModel
    let onSelect: (GardenProductOption) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [GardenProductOption] = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { product in
                    Button(product.name) {
                        onSelect(product)
                        dismiss()
                    }
                }
                if query.count >= 2, results.isEmpty {
                    Text(GardenStrings.noMatches).foregroundStyle(.secondary)
                }
            }
            .searchable(text: $query, prompt: GardenStrings.search)
            .task(id: query) {
                guard query.count >= 2 else { results = []; return }
                let existingIDs = Set(model.options.products.map(\.id))
                let widened = await model.searchOptions(query)
                results = widened.products.filter { !existingIDs.contains($0.id) }
            }
            .navigationTitle(GardenStrings.seedPacketsAndPlants)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
            }
        }
    }
}

private struct GardenAddIngredientSheet: View {
    let model: GardenModel
    let onSelect: (GardenOption) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [GardenOption] = []

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { ingredient in
                    Button(ingredient.name) {
                        onSelect(ingredient)
                        dismiss()
                    }
                }
                if query.count >= 2, results.isEmpty {
                    Text(GardenStrings.noMatches).foregroundStyle(.secondary)
                }
            }
            .searchable(text: $query, prompt: GardenStrings.search)
            .task(id: query) {
                guard query.count >= 2 else { results = []; return }
                let existingIDs = Set(model.options.ingredients.map(\.id))
                let widened = await model.searchOptions(query)
                results = widened.ingredients.filter { !existingIDs.contains($0.id) }
            }
            .navigationTitle(GardenStrings.cropGuides)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
            }
        }
    }
}

#Preview("Add product") {
    GardenAddProductSheet(model: GardenModel(service: PreviewGardenService())) { _ in }
}

#Preview("Add crop guide") {
    GardenAddIngredientSheet(model: GardenModel(service: PreviewGardenService())) { _ in }
}

private struct GardenLocationForm: View {
    let model: GardenModel
    let location: GardenLocation?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var kind: GardenLocationKind
    @State private var conditions: String

    init(model: GardenModel, location: GardenLocation?) {
        self.model = model
        self.location = location
        _name = State(initialValue: location?.name ?? "")
        _kind = State(initialValue: GardenLocationKind(rawValue: location?.gardenKind ?? "") ?? .bed)
        _conditions = State(initialValue: location?.conditions ?? "")
    }

    var body: some View {
        Form {
            TextField(GardenStrings.growingAreaName, text: $name)
            Picker("Kind", selection: $kind) {
                Text(GardenStrings.raisedBed).tag(GardenLocationKind.bed)
                Text(GardenStrings.seedTray).tag(GardenLocationKind.tray)
                Text(GardenStrings.other).tag(GardenLocationKind.other)
            }
            TextField(GardenStrings.growingConditions, text: $conditions, axis: .vertical)
        }
        .porcelainForm()
        .navigationTitle(location == nil ? GardenStrings.addGrowingArea : GardenStrings.editGrowingArea)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(GardenStrings.save) { Task { await save() } }.disabled(name.isEmpty || model.isSaving)
            }
        }
    }

    private func save() async {
        let saved: Bool
        if let location {
            saved = await model.updateLocation(
                id: location.id, name: name, kind: kind, conditions: conditions.nilIfEmpty)
        } else {
            saved = await model.createLocation(name: name, kind: kind, conditions: conditions.nilIfEmpty)
        }
        if saved { dismiss() }
    }
}

#Preview("Add growing area") {
    NavigationStack { GardenLocationForm(model: GardenModel(service: PreviewGardenService()), location: nil) }
}

private struct GardenProductForm: View {
    let model: GardenModel
    let product: GardenProductOption
    @Environment(\.dismiss) private var dismiss
    @State private var ingredientID: String

    init(model: GardenModel, product: GardenProductOption) {
        self.model = model
        self.product = product
        _ingredientID = State(initialValue: product.growsIngredientID ?? "")
    }

    var body: some View {
        Form {
            GardenOptionPicker(
                GardenStrings.grows, selection: $ingredientID, options: model.options.ingredients)
            Text(GardenStrings.productWriteBackExplanation)
                .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
        .porcelainForm()
        .navigationTitle(product.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(GardenStrings.save) {
                    Task {
                        if await model.setProduct(id: product.id, growsIngredientID: ingredientID.nilIfEmpty)
                        {
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}

private struct GardenIngredientForm: View {
    let model: GardenModel
    let ingredient: GardenOption
    @Environment(\.dismiss) private var dismiss
    @State private var guideKey: String

    init(model: GardenModel, ingredient: GardenOption) {
        self.model = model
        self.ingredient = ingredient
        _guideKey = State(initialValue: ingredient.gardenGuideKey ?? "")
    }

    var body: some View {
        Form {
            Picker(GardenStrings.plantingGuide, selection: $guideKey) {
                Text("None").tag("")
                ForEach(model.guides.guides, id: \.key) { guide in Text(guide.name).tag(guide.key) }
            }
        }
        .porcelainForm()
        .navigationTitle(ingredient.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(GardenStrings.save) {
                    Task {
                        if await model.setIngredient(id: ingredient.id, guideKey: guideKey.nilIfEmpty) {
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}

#Preview("Product write-back") {
    NavigationStack {
        GardenProductForm(
            model: GardenModel(service: PreviewGardenService()), product: GardenPreviewFixtures.seedProduct)
    }
}

#Preview("Crop guide") {
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    NavigationStack {
        GardenIngredientForm(model: model, ingredient: GardenPreviewFixtures.tomatoIngredient)
    }
    .task { await model.load() }
}

struct GardenHistoryView: View {
    let model: GardenModel
    let uploader: GardenImageUploader
    var body: some View { GardenBedJournalView(locationID: nil) }
}

#Preview("Garden history") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    @Previewable @State var model = GardenModel(service: PreviewGardenService())
    NavigationStack {
        GardenHistoryView(model: model, uploader: GardenImageUploader(service: appModel.client))
    }
    .environment(appModel)
    .task { await model.load() }
}

struct GardenEntryCorrectionSheet: View {
    let model: GardenModel; let entry: GardenEntry; let uploader: GardenImageUploader
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date; @State private var note: String; @State private var amount: String
    @State private var locationID: String; @State private var plantingID: String
    @State private var selections: [PhotoSelectionItem] = []; @State private var removed: Set<String> = []
    @State private var uploadedIDs: [ImageCode] = []
    @State private var uploadError: String?; @State private var isUploading = false
    @State private var saveTask: Task<Void, Never>?
    init(model: GardenModel, entry: GardenEntry, uploader: GardenImageUploader) {
        self.model = model; self.entry = entry; self.uploader = uploader
        _date = State(initialValue: entry.observedAt); _note = State(initialValue: entry.note ?? "");
        _amount = State(initialValue: entry.harvestAmount ?? "")
        _locationID = State(initialValue: entry.locationID)
        _plantingID = State(initialValue: entry.plantingID ?? "")
    }

    /// A `move` entry, and the anchor entry `startPlanting` writes when a planting first enters a
    /// location, are structural (`docs/terminology.md` § Garden): location, planting, date, and
    /// kind are corrected only through location history, never through this form.
    private var isLocked: Bool { entry.kind == .move || entry.anchorsPeriod }

    var body: some View {
        NavigationStack {
            Form {
                GardenObservationDatePicker(
                    label: entry.kind == .harvest ? GardenStrings.harvestDate : GardenStrings.date,
                    selection: $date
                )
                .disabled(isLocked)
                if isLocked {
                    LabeledContent(
                        GardenStrings.location,
                        value: model.options.locations.first(where: { $0.id == locationID })?.name
                            ?? locationID)
                    LabeledContent(
                        GardenStrings.about,
                        value: model.allPlantingOptions.first(where: { $0.id == plantingID })?.name
                            ?? GardenStrings.wholeArea)
                    Text(GardenStrings.correctDatesInLocationHistoryHint)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                } else {
                    GardenOptionPicker(
                        GardenStrings.location, selection: $locationID, options: model.options.locations,
                        required: true)
                    GardenOptionPicker(
                        GardenStrings.about, selection: $plantingID, options: model.allPlantingOptions,
                        noneLabel: GardenStrings.wholeArea)
                }
                TextField(GardenStrings.note, text: $note, axis: .vertical)
                if entry.kind == .harvest { TextField(GardenStrings.harvestAmount, text: $amount) }
                if let error = model.saveError { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                Section("Photos") {
                    PhotoBatch(
                        photos: entry.images.filter { !removed.contains($0.id) }.map {
                            PhotoAttachment(
                                id: $0.id, filename: $0.filename, source: .remote($0.url), imageID: $0.id)
                        },
                        onRemove: isUploading ? nil : { removed.insert($0) }
                    )
                    .gardenPhotoGridWidth()
                    PhotoBatch(
                        photos: selections.map {
                            PhotoAttachment(
                                id: $0.id, filename: gardenPhotoLabel($0), source: .local($0.preview),
                                imageID: $0.existingImageID?.rawValue,
                                status: $0.existingImageID == nil ? nil : "Uploaded")
                        },
                        onRemove: isUploading
                            ? nil
                            : { id in selections.removeAll { $0.id == id } }
                    )
                    .gardenPhotoGridWidth()
                    GardenPhotoSourceButtons(maxSelectionCount: remainingPhotoCapacity) {
                        selections.append(contentsOf: $0)
                    }
                    if let uploadError { Text(uploadError).foregroundStyle(PorcelainTokens.destructive) }
                    if let photoSelectionError {
                        Text(photoSelectionError).foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .porcelainForm()
            .disabled(isUploading || model.isSaving)
            .navigationTitle(entry.anchorsPeriod ? GardenStrings.editNote : GardenStrings.editEntry)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(GardenStrings.cancel) { dismiss() }.disabled(model.isSaving || isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(GardenStrings.save) { startSave() }.disabled(
                        (!isLocked && locationID.isEmpty) || model.isSaving || isUploading
                            || photoSelectionError != nil)
                }
            }
        }
        .interactiveDismissDisabled(isUploading || model.isSaving)
        .onDisappear { saveTask?.cancel() }
    }

    private func startSave() {
        guard saveTask == nil else { return }
        saveTask = Task {
            await save()
            saveTask = nil
        }
    }

    private func save() async {
        guard !isUploading, photoSelectionError == nil else { return }
        isUploading = true
        uploadError = nil
        defer { isUploading = false }
        do {
            try Task.checkCancellation()
            try await uploadNewSelections()
            try Task.checkCancellation()
        } catch is CancellationError {
            return
        } catch {
            uploadError = error.localizedDescription
            Diagnostics.report(error, context: "garden.entry.edit.upload")
            return
        }
        if await model.updateEntry(
            EditGardenEntry(
                id: entry.id, locationID: locationID, plantingID: plantingID.nilIfEmpty, kind: entry.kind,
                observedAt: date, note: note.nilIfEmpty, harvestAmount: amount.nilIfEmpty,
                pendingImageIDs: uploadedIDs, removeImageIDs: Array(removed)))
        {
            guard !Task.isCancelled else { return }
            if !uploadedIDs.isEmpty, let client = model.service as? CubbyClient,
                appModel.client === client
            {
                await appModel.photoMatches.refresh(client: client)
            }
            guard !Task.isCancelled else { return }
            dismiss()
        }
    }

    private func uploadNewSelections() async throws {
        let resolver = GardenPhotoSelectionResolver(sourceItems: selections) { file in
            try Task.checkCancellation()
            guard let imageID = try await uploader.upload([file]).first else {
                throw GardenPhotoSelectionResolver.Failure.emptyUpload
            }
            return imageID
        }
        defer {
            for index in selections.indices {
                if let imageID = resolver.resolvedBySelectionID[selections[index].id] {
                    selections[index].existingImageID = imageID
                }
            }
            uploadedIDs = uniqueImageIDs(selections.compactMap(\.existingImageID))
        }
        let resolution = try await resolver.resolve(selections)
        uploadedIDs = resolution.imageIDs
    }

    private var photoSelectionError: String? {
        if retainedExistingPhotoCount + selections.count > 20 {
            return "A garden entry can contain at most 20 photos."
        }
        return GardenPhotoSelectionResolver.validationError(for: selections)
    }

    private var retainedExistingPhotoCount: Int {
        entry.images.lazy.filter { !removed.contains($0.id) }.count
    }

    private var remainingPhotoCapacity: Int {
        max(0, 20 - retainedExistingPhotoCount - selections.count)
    }
}

#Preview("Edit entry") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    GardenEntryCorrectionSheet(
        model: GardenModel(service: PreviewGardenService()), entry: GardenPreviewFixtures.harvestEntry,
        uploader: GardenImageUploader(service: appModel.client)
    )
    .environment(appModel)
}

#Preview("Edit note (locked)") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    GardenEntryCorrectionSheet(
        model: GardenModel(service: PreviewGardenService()), entry: GardenPreviewFixtures.anchorEntry,
        uploader: GardenImageUploader(service: appModel.client)
    )
    .environment(appModel)
}

struct GardenObservationDatePicker: View {
    var label: String = GardenStrings.date
    @Binding var selection: Date

    var body: some View {
        DatePicker(label, selection: $selection, displayedComponents: .date)
    }
}

#Preview("Observation date") {
    @Previewable @State var date = Date.now
    Form { GardenObservationDatePicker(selection: $date) }
}

private struct GardenPlantingJournal: View {
    let model: GardenModel
    let planting: GardenPlanting
    let uploader: GardenImageUploader
    @State private var journal: GardenJournalModel
    @State private var editing: GardenEntry?

    init(model: GardenModel, planting: GardenPlanting, uploader: GardenImageUploader) {
        self.model = model; self.planting = planting; self.uploader = uploader
        // Whole-bed context is always included — inclusion is a rule of the journal, not a
        // per-viewing preference (G-85).
        _journal = State(
            initialValue: GardenJournalModel(service: model.service, planting: planting))
    }

    var body: some View {
        Section(GardenStrings.journal) {
            if journal.entries.isEmpty && journal.isLoading { LoadingIndicator() }
            if let error = journal.error, journal.entries.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load journal", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(GardenStrings.retry) { Task { await journal.retry() } }
                }
            }
            if let error = journal.error, !journal.entries.isEmpty {
                Button("Couldn't load more: \(error). Retry") { Task { await journal.retry() } }
                    .foregroundStyle(PorcelainTokens.destructive)
            }
            ForEach(journal.entries) { item in
                GardenEntrySummary(entry: item.entry)
                    .swipeActions(edge: .trailing) {
                        Button(item.entry.anchorsPeriod ? GardenStrings.editNote : GardenStrings.editEntry) {
                            editing = item.entry
                        }
                        .tint(PorcelainTokens.cobalt)
                    }
            }
            if journal.hasMore {
                Button(journal.isLoading ? GardenStrings.loading : GardenStrings.loadMore) {
                    Task { await journal.loadMore() }
                }
                .disabled(journal.isLoading)
            }
        }
        .task(id: model.journalRevision) { await journal.refresh() }
        .refreshable { await journal.refresh() }
        .sheet(item: $editing) {
            GardenEntryCorrectionSheet(model: model, entry: $0, uploader: uploader)
        }
    }
}

struct GardenImageStrip: View {
    let images: [GardenImage]
    var body: some View {
        PhotoBatch(
            photos: images.map {
                PhotoAttachment(id: $0.id, filename: $0.filename, source: .remote($0.url), imageID: $0.id)
            })
    }
}

#Preview("Image strip") {
    GardenImageStrip(images: [])
}

private struct GardenLocationHistoryView: View {
    let service: any GardenService
    let planting: GardenPlanting
    @State private var history: GardenLocationHistoryModel
    @State private var revised: [GardenLocationPeriod] = []
    @State private var initialLocationDate = Date.now
    @State private var initialLastDay = Date.now
    /// Set once from the *first* load, so the title never flips from "Confirm" to "Correct" the
    /// moment a not-yet-saved period is added locally (`docs/terminology.md` § Garden).
    @State private var hadExistingPeriods = false
    @Environment(\.dismiss) private var dismiss

    init(service: any GardenService, planting: GardenPlanting) {
        self.service = service; self.planting = planting
        _history = State(initialValue: GardenLocationHistoryModel(service: service, planting: planting))
        _initialLastDay = State(initialValue: planting.finishedAt ?? .now)
    }

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
                            await history.load(); revised = history.periods
                        }
                    }
                }
            }
            ForEach($revised) { $period in
                Section(period.location.name) {
                    DatePicker(
                        GardenStrings.inThisLocationSince,
                        selection: Binding(
                            get: { period.inLocationSince },
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
                    if let ended = period.endedOn {
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
            if revised.isEmpty, !history.isLoading, history.error == nil, planting.status != .planned,
                let location = planting.location
            {
                Section("Add location history") {
                    Text(
                        "No location date has been recorded for this planting. This does not create a sowing or transplant date."
                    )
                    .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    LabeledContent(GardenStrings.location, value: location.name)
                    DatePicker(
                        GardenStrings.inThisLocationSince, selection: $initialLocationDate,
                        displayedComponents: .date)
                    if planting.status == .finished {
                        DatePicker(
                            "Last day in this location", selection: $initialLastDay,
                            displayedComponents: .date)
                    }
                    Button("Record this date") { Task { await saveInitialPeriod(location: location) } }
                        .disabled(history.isSaving)
                }
            }
        }
        .porcelainForm()
        .navigationTitle(title)
        .task {
            await history.load()
            revised = history.periods
            hadExistingPeriods = !history.periods.isEmpty
        }
        .refreshable {
            await history.load(); revised = history.periods
        }
        .disabled(history.isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(GardenStrings.cancel) { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
                Button(GardenStrings.save) {
                    Task { if await history.save(revised) { revised = history.periods; dismiss() } }
                }
                .disabled(history.isSaving || revised.isEmpty)
            }
        }
    }

    private func saveInitialPeriod(location: GardenOption) async {
        let first = GardenLocationPeriod(
            sequence: 0, location: location, inLocationSince: initialLocationDate,
            endedOn: planting.status == .finished ? initialLastDay : nil, startKind: .actual)
        if await history.save([first]) { revised = history.periods; dismiss() }
    }

    private func reviseBoundary(sequence: Int, date: Date, start: Bool) {
        guard let index = revised.firstIndex(where: { $0.sequence == sequence }) else { return }
        if start {
            revised[index].inLocationSince = date
            if index > 0 { revised[index - 1].endedOn = date }
        } else {
            revised[index].endedOn = date
            if index + 1 < revised.count { revised[index + 1].inLocationSince = date }
        }
    }
}

#Preview("Location history") {
    NavigationStack {
        GardenLocationHistoryView(
            service: PreviewGardenService(), planting: GardenPreviewFixtures.growingPlanting)
    }
}
