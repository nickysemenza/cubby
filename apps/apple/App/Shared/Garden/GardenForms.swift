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

    var body: some View {
        NavigationStack {
            Form {
                Section("What") {
                    GardenOptionPicker(
                        "Crop", selection: $ingredientID, options: model.options.ingredients, required: true)
                    GardenProductPicker(
                        "Source product", selection: $productID, options: model.options.products)
                    TextField("Variety", text: $variety)
                    TextField("Approximate quantity", text: $quantity)
                }
                if let guide = model.guide(for: ingredientID) {
                    GardenGuideSection(guide: guide, source: model.guideSource)
                }
                Section("Where and when") {
                    Picker("Status", selection: $status) {
                        ForEach(GardenPlantingStatus.allCases, id: \.self) {
                            Text($0.rawValue.capitalized).tag($0)
                        }
                    }
                    .pickerStyle(.segmented)
                    GardenOptionPicker(
                        status == .planned ? "Planned for" : "Current location",
                        selection: status == .planned ? $intendedLocationID : $locationID,
                        options: model.options.locations,
                        required: status == .growing
                    )
                    if status == .planned {
                        TextField("Planning window (optional)", text: $plannedWindow)
                        Toggle("Record planned date", isOn: $usePlannedDate)
                        if usePlannedDate {
                            DatePicker("Planned", selection: $plannedDate, displayedComponents: .date)
                        }
                    } else {
                        Toggle("Record sowing date", isOn: $useSowingDate)
                        if useSowingDate {
                            DatePicker("Sown", selection: $sownAt, displayedComponents: .date)
                        }
                        Toggle("Record transplant date", isOn: $useTransplantDate)
                        if useTransplantDate {
                            DatePicker("Transplanted", selection: $transplantedAt, displayedComponents: .date)
                        }
                        Toggle("In this location since", isOn: $useInLocationSince)
                        if useInLocationSince {
                            DatePicker("Since", selection: $inLocationSince, displayedComponents: .date)
                        }
                    }
                }
                Section("Notes") { TextField("Anything useful to remember", text: $notes, axis: .vertical) }
            }
            .navigationTitle("Add planting")
            .onChange(of: productID) { _, id in
                guard let ingredient = model.options.products.first(where: { $0.id == id })?.growsIngredientID
                else { return }
                ingredientID = ingredient
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(
                            ingredientID.isEmpty || (status == .growing && locationID.isEmpty)
                                || model.isSaving)
                }
            }
        }
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
            )
        )
        if saved { dismiss() }
    }
}

struct GardenEntrySheet: View {
    let model: GardenModel
    let target: GardenEntryTarget
    let uploader: GardenImageUploader
    @Environment(\.dismiss) private var dismiss
    @State private var kind: GardenEntryKind = .observation
    @State private var observedAt = Date.now
    @State private var note = ""
    @State private var harvestAmount = ""
    @State private var images: [CGImage] = []
    @State private var uploadStatus: String?
    @State private var uploadError: String?
    @State private var uploadedIDs: [ImageCode] = []
    @State private var uploadedImageCount = 0
    @State private var isUploading = false
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
                    Picker("Kind", selection: $kind) {
                        Text("Note").tag(GardenEntryKind.observation)
                        Text("Harvest").tag(GardenEntryKind.harvest)
                    }
                    .pickerStyle(.segmented)
                    DatePicker("Date", selection: $observedAt, displayedComponents: .date)
                    GardenOptionPicker(
                        "Location", selection: $locationID, options: model.options.locations, required: true)
                    GardenOptionPicker(
                        "About", selection: $plantingID, options: model.allPlantingOptions,
                        noneLabel: "Whole bed")
                    if kind == .harvest { TextField("Harvest amount", text: $harvestAmount) }
                    TextField("Note", text: $note, axis: .vertical)
                }
                if let error = model.saveError { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                Section("Photos") {
                    PhotoBatch(
                        photos: images.enumerated().map {
                            PhotoAttachment(
                                id: "local-\($0.offset)", filename: "Garden photo \($0.offset + 1)",
                                source: .local($0.element),
                                status: $0.offset < uploadedImageCount ? "Uploaded" : nil)
                        },
                        onRemove: isUploading
                            ? nil
                            : { id in
                                guard let index = Int(id.replacingOccurrences(of: "local-", with: "")) else {
                                    return
                                }
                                if index < uploadedImageCount {
                                    uploadedIDs.remove(at: index)
                                    uploadedImageCount -= 1
                                }
                                images.remove(at: index)
                            })
                    GardenPhotoSourceButtons { images.append(contentsOf: $0) }
                    if let uploadStatus { Text(uploadStatus).font(.porcelainLabel) }
                    if let uploadError {
                        Text(uploadError).font(.porcelainLabel).foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .disabled(isUploading || model.isSaving)
            .navigationTitle(kind == .harvest ? "Log harvest" : "Garden entry")
            #if os(macOS)
                .frame(minWidth: 520, idealWidth: 620, minHeight: 560, idealHeight: 720)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSaving || isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(locationID.isEmpty || model.isSaving || isUploading)
                }
            }
        }.interactiveDismissDisabled(isUploading || model.isSaving)
    }

    private func save() async {
        guard !locationID.isEmpty, !isUploading else { return }
        uploadError = nil
        isUploading = true
        defer { isUploading = false }
        do {
            let remaining = Array(images.dropFirst(uploadedImageCount))
            let ids = try await uploader.upload(remaining) { step in
                Task { @MainActor in
                    uploadStatus =
                        switch step {
                        case .encoding(let index, let count): "Preparing photo \(index) of \(count)…"
                        case .uploading(let index, let count): "Uploading photo \(index) of \(count)…"
                        case .done: nil
                        }
                }
            }
            uploadedIDs += ids
            uploadedImageCount = images.count
        } catch let failure as GardenImageUploader.PartialFailure {
            uploadedIDs += failure.completedIDs
            uploadedImageCount += failure.completedCount
            uploadError = failure.underlying.localizedDescription
            return
        } catch { uploadError = error.localizedDescription; return }
        let saved = await model.record(
            RecordGardenEntry(
                locationID: locationID, plantingID: plantingID.nilIfEmpty, kind: kind,
                observedAt: observedAt,
                note: note.nilIfEmpty, harvestAmount: kind == .harvest ? harvestAmount.nilIfEmpty : nil,
                pendingImageIDs: uploadedIDs))
        if saved { dismiss() }
    }
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
        case .entry: "Garden entry"
        case .start: "Start planting"
        case .move: "Move planting"
        case .split: "Move some seedlings"
        case .finish: "Finish planting"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section { Text(planting.ingredient.name).font(.porcelainTitle) }
                if needsLocation {
                    Section("Destination") {
                        GardenOptionPicker(
                            "Location", selection: $locationID, options: model.options.locations,
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
                if isSplit { Section("Amount") { TextField("Approximate quantity", text: $quantity) } }
                Section("When") { DatePicker("Date", selection: $date, displayedComponents: .date) }
                if needsNote { Section("Note") { TextField("Optional note", text: $note, axis: .vertical) } }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
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
    private var needsNote: Bool { if case .finish = action { false } else { true } }

    private func save() async {
        let saved: Bool
        switch action {
        case .entry(let planting):
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
            saved = await model.finish(id: planting.id, on: date)
        }
        if saved { dismiss() }
    }
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
                    VStack(alignment: .leading) {
                        Text(planting.ingredient.name).font(.porcelainBody.weight(.semibold))
                        if let date = planting.finishedAt {
                            Text(date.formatted(date: .abbreviated, time: .omitted)).font(.porcelainLabel)
                        }
                    }
                }
            }
            .navigationTitle("Finished plantings")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct GardenPlantingDetailView: View {
    let model: GardenModel
    let planting: GardenPlanting
    let guide: GardenGuide?
    let source: (String) -> GardenGuideSource?
    let uploader: GardenImageUploader
    @State private var editing = false
    @State private var loggingEntry = false
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
            Section {
                LabeledContent("Status", value: planting.status.rawValue.capitalized)
                if let location = planting.location {
                    NavigationLink(value: Route.gardenBedJournal(id: location.id)) {
                        LabeledContent("Location", value: location.name)
                    }
                }
                if let variety = planting.variety { LabeledContent("Variety", value: variety) }
            }
            if section == .journal {
                GardenPlantingJournal(model: model, planting: planting, uploader: uploader)
            } else {
                Section("Planting") {
                    LabeledContent("Crop", value: planting.ingredient.name)
                    LabeledContent("Status", value: planting.status.rawValue.capitalized)
                    if let variety = planting.variety { LabeledContent("Variety", value: variety) }
                    if let quantity = planting.quantity { LabeledContent("Quantity", value: quantity) }
                    if let location = planting.location {
                        NavigationLink(value: Route.gardenBedJournal(id: location.id)) {
                            LabeledContent("Whole bed", value: location.name)
                        }
                    }
                    NavigationLink("Location history") {
                        GardenLocationHistoryView(service: model.service, planting: planting)
                    }
                    if let planned = planting.plannedWindow { LabeledContent("Plan", value: planned) }
                    if let date = planting.plannedDate {
                        LabeledContent(
                            "Planned date", value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let date = planting.sownAt {
                        LabeledContent("Sowed", value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let date = planting.transplantedAt {
                        LabeledContent(
                            "Transplanted", value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                    if let sourceProduct = planting.product {
                        NavigationLink(value: Route.entityDetail(.product, id: sourceProduct.id)) {
                            LabeledContent("Source", value: sourceProduct.name)
                        }
                    }
                    if let date = planting.finishedAt {
                        LabeledContent("Finished", value: date.formatted(date: .abbreviated, time: .omitted))
                    }
                }
                if let notes = planting.notes { Section("Notes") { Text(notes) } }
                if let guide {
                    Section("Planting guide") {
                        DisclosureGroup("Show guide") {
                            ForEach(guide.windows) { window in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(source(window.sourceID)?.name ?? window.sourceID)
                                        .font(.porcelainBody.weight(.semibold))
                                    Text(guideWindowSummary(window))
                                        .font(.porcelainLabel)
                                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                    if let note = window.note { Text(note).font(.porcelainLabel) }
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(planting.ingredient.name)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button("Add photos / Log entry") { loggingEntry = true }
                Button("Edit") { editing = true }
            }
        }
        .sheet(isPresented: $editing) {
            GardenPlantingCorrectionSheet(model: model, planting: planting).gardenEditorSize()
        }
        .sheet(isPresented: $loggingEntry) {
            GardenEntrySheet(model: model, target: .planting(planting), uploader: uploader)
        }
    }

    private func guideWindowSummary(_ window: GardenGuideWindow) -> String {
        let monthNames = window.months.compactMap { Calendar.current.monthSymbols[safe: $0 - 1] }
        let scope = [window.microclimate, window.monthPart].compactMap { $0 }.joined(separator: " · ")
        return [window.method, monthNames.joined(separator: ", "), scope].filter { !$0.isEmpty }.joined(
            separator: " · ")
    }
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
                    "Crop", selection: $ingredientID, options: model.options.ingredients, required: true)
                GardenProductPicker("Source product", selection: $productID, options: model.options.products)
                GardenOptionPicker(
                    "Intended location", selection: $intendedID, options: model.options.locations)
                TextField("Variety", text: $variety); TextField("Approximate quantity", text: $quantity);
                TextField("Planning window", text: $window); TextField("Notes", text: $notes, axis: .vertical)
                Toggle("Planned date", isOn: $hasPlanned);
                if hasPlanned { DatePicker("Planned", selection: $planned, displayedComponents: .date) }
                Toggle("Sowing date", isOn: $hasSowed);
                if hasSowed { DatePicker("Sown", selection: $sowed, displayedComponents: .date) }
                Toggle("Transplant date", isOn: $hasTransplanted);
                if hasTransplanted {
                    DatePicker("Transplanted", selection: $transplanted, displayedComponents: .date)
                }
            }.navigationTitle("Edit planting").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } };
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(ingredientID.isEmpty || model.isSaving)
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

extension View {
    @ViewBuilder
    func gardenEditorSize() -> some View {
        #if os(macOS)
            self.frame(minWidth: 520, idealWidth: 620, minHeight: 560, idealHeight: 720)
        #else
            self
        #endif
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
        Section("Planting guide") {
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
/// directory. These controls expose the three additive associations Garden v1 introduces.
struct GardenSetupSheet: View {
    let model: GardenModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Growing areas") {
                    NavigationLink {
                        GardenLocationForm(model: model, location: nil)
                    } label: {
                        Label("Add bed or tray", systemImage: "plus")
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
                Section("Seed packets and plants") {
                    ForEach(model.options.products) { product in
                        NavigationLink {
                            GardenProductForm(model: model, product: product)
                        } label: {
                            LabeledContent(
                                product.name, value: ingredientName(product.growsIngredientID) ?? "Not set")
                        }
                    }
                }
                Section("Crop guides") {
                    ForEach(model.options.ingredients) { ingredient in
                        NavigationLink {
                            GardenIngredientForm(model: model, ingredient: ingredient)
                        } label: {
                            LabeledContent(ingredient.name, value: ingredient.gardenGuideKey ?? "Not set")
                        }
                    }
                }
            }
            .navigationTitle("Garden setup")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func ingredientName(_ id: String?) -> String? {
        guard let id else { return nil }
        return model.options.ingredients.first(where: { $0.id == id })?.name
    }
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
            TextField("Name", text: $name)
            Picker("Kind", selection: $kind) {
                ForEach(GardenLocationKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            TextField("Growing conditions", text: $conditions, axis: .vertical)
        }
        .navigationTitle(location == nil ? "Add growing area" : "Edit growing area")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(name.isEmpty || model.isSaving)
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
            GardenOptionPicker("Grows", selection: $ingredientID, options: model.options.ingredients)
            Text(
                "This only records what the seed packet or purchased plant grows. It does not add edible inventory."
            )
            .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
        .navigationTitle(product.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
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
            Picker("Planting guide", selection: $guideKey) {
                Text("None").tag("")
                ForEach(model.guides.guides, id: \.key) { guide in Text(guide.name).tag(guide.key) }
            }
        }
        .navigationTitle(ingredient.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
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

struct GardenHistoryView: View {
    let model: GardenModel
    let uploader: GardenImageUploader
    var body: some View { GardenBedJournalView(locationID: nil) }
}

struct GardenEntryCorrectionSheet: View {
    let model: GardenModel; let entry: GardenEntry; let uploader: GardenImageUploader
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date; @State private var note: String; @State private var amount: String
    @State private var locationID: String; @State private var plantingID: String
    @State private var images: [CGImage] = []; @State private var removed: Set<String> = []
    @State private var uploadedIDs: [ImageCode] = []; @State private var uploadedImageCount = 0
    @State private var uploadError: String?; @State private var isUploading = false
    init(model: GardenModel, entry: GardenEntry, uploader: GardenImageUploader) {
        self.model = model; self.entry = entry; self.uploader = uploader
        _date = State(initialValue: entry.observedAt); _note = State(initialValue: entry.note ?? "");
        _amount = State(initialValue: entry.harvestAmount ?? "")
        _locationID = State(initialValue: entry.locationID)
        _plantingID = State(initialValue: entry.plantingID ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Date", selection: $date, displayedComponents: .date)
                    .disabled(entry.kind == .move)
                if entry.kind == .move {
                    LabeledContent(
                        "Location",
                        value: model.options.locations.first(where: { $0.id == locationID })?.name
                            ?? locationID)
                    LabeledContent(
                        "Planting",
                        value: model.allPlantingOptions.first(where: { $0.id == plantingID })?.name
                            ?? "Bed observation")
                } else {
                    GardenOptionPicker(
                        "Location", selection: $locationID, options: model.options.locations, required: true)
                    GardenOptionPicker(
                        "About", selection: $plantingID, options: model.allPlantingOptions,
                        noneLabel: "Whole bed")
                }
                TextField("Note", text: $note, axis: .vertical)
                if entry.kind == .harvest { TextField("Harvest amount", text: $amount) }
                if let error = model.saveError { Text(error).foregroundStyle(PorcelainTokens.destructive) }
                Section("Photos") {
                    PhotoBatch(
                        photos: entry.images.filter { !removed.contains($0.id) }.map {
                            PhotoAttachment(
                                id: $0.id, filename: $0.filename, source: .remote($0.url), imageID: $0.id)
                        },
                        onRemove: isUploading ? nil : { removed.insert($0) })
                    PhotoBatch(
                        photos: images.enumerated().map {
                            PhotoAttachment(
                                id: "local-\($0.offset)", filename: "Garden photo \($0.offset + 1)",
                                source: .local($0.element),
                                status: $0.offset < uploadedImageCount ? "Uploaded" : nil)
                        },
                        onRemove: isUploading
                            ? nil
                            : { id in
                                guard let index = Int(id.replacingOccurrences(of: "local-", with: "")) else {
                                    return
                                }
                                if index < uploadedImageCount {
                                    uploadedIDs.remove(at: index); uploadedImageCount -= 1
                                }
                                images.remove(at: index)
                            })
                    GardenPhotoSourceButtons { images.append(contentsOf: $0) }
                    if let uploadError { Text(uploadError).foregroundStyle(PorcelainTokens.destructive) }
                }
            }
            .disabled(isUploading || model.isSaving)
            .navigationTitle("Edit entry")
            #if os(macOS)
                .frame(minWidth: 520, idealWidth: 620, minHeight: 560, idealHeight: 720)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSaving || isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(
                        locationID.isEmpty || model.isSaving || isUploading)
                }
            }
        }.interactiveDismissDisabled(isUploading || model.isSaving)
    }
    private func save() async {
        guard !isUploading else { return }
        isUploading = true
        uploadError = nil
        defer { isUploading = false }
        do {
            let ids = try await uploader.upload(Array(images.dropFirst(uploadedImageCount)))
            uploadedIDs += ids
            uploadedImageCount = images.count
        } catch let failure as GardenImageUploader.PartialFailure {
            uploadedIDs += failure.completedIDs
            uploadedImageCount += failure.completedCount
            uploadError = failure.underlying.localizedDescription
            return
        } catch { uploadError = error.localizedDescription; return }
        if await model.updateEntry(
            EditGardenEntry(
                id: entry.id, locationID: locationID, plantingID: plantingID.nilIfEmpty, kind: entry.kind,
                observedAt: date, note: note.nilIfEmpty, harvestAmount: amount.nilIfEmpty,
                pendingImageIDs: uploadedIDs, removeImageIDs: Array(removed)))
        {
            dismiss()
        }
    }
}

private struct GardenPlantingJournal: View {
    let model: GardenModel
    let planting: GardenPlanting
    let uploader: GardenImageUploader
    @State private var journal: GardenJournalModel
    @State private var editing: GardenEntry?

    init(model: GardenModel, planting: GardenPlanting, uploader: GardenImageUploader) {
        self.model = model; self.planting = planting; self.uploader = uploader
        _journal = State(initialValue: GardenJournalModel(service: model.service, planting: planting))
    }

    var body: some View {
        Section {
            Toggle("Include whole-bed context", isOn: $journal.includeBedContext)
        } footer: {
            Text("Bed observations appear alongside entries recorded directly for this planting.")
        }
        Section("Journal") {
            if journal.entries.isEmpty && journal.isLoading { ProgressView() }
            if let error = journal.error, journal.entries.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load journal", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await journal.retry() } }
                }
            }
            if let error = journal.error, !journal.entries.isEmpty {
                Button("Couldn't load more: \(error). Retry") { Task { await journal.retry() } }
                    .foregroundStyle(PorcelainTokens.destructive)
            }
            ForEach(journal.entries) { item in
                GardenEntrySummary(entry: item.entry)
                    .contextMenu { Button("Edit entry") { editing = item.entry } }
            }
            if journal.hasMore {
                Button(journal.isLoading ? "Loading…" : "Load more") { Task { await journal.loadMore() } }
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

private struct GardenLocationHistoryView: View {
    let service: any GardenService
    let planting: GardenPlanting
    @State private var history: GardenLocationHistoryModel
    @State private var revised: [GardenLocationPeriod] = []
    @State private var initialLocationDate = Date.now
    @State private var initialLastDay = Date.now
    @Environment(\.dismiss) private var dismiss

    init(service: any GardenService, planting: GardenPlanting) {
        self.service = service; self.planting = planting
        _history = State(initialValue: GardenLocationHistoryModel(service: service, planting: planting))
        _initialLastDay = State(initialValue: planting.finishedAt ?? .now)
    }

    var body: some View {
        Form {
            if let error = history.error {
                VStack(spacing: PorcelainTokens.Space.sm) {
                    ContentUnavailableView(
                        "Couldn't load location history", systemImage: "exclamationmark.triangle",
                        description: Text(error))
                    Button("Retry") {
                        Task {
                            await history.load(); revised = history.periods
                        }
                    }
                }
            }
            ForEach($revised) { $period in
                Section(period.location.name) {
                    DatePicker(
                        "In this location since",
                        selection: Binding(
                            get: { period.inLocationSince },
                            set: { reviseBoundary(sequence: period.sequence, date: $0, start: true) }),
                        displayedComponents: .date)
                    LabeledContent(
                        "Recorded as", value: period.startKind == .actual ? "Actual date" : "Recorded later")
                    if period.startKind == .recorded {
                        Text("Earlier presence is unknown. Add a date you know to include older bed photos.")
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
            if history.isLoading && revised.isEmpty { ProgressView() }
            if revised.isEmpty, !history.isLoading, history.error == nil, planting.status != .planned,
                let location = planting.location
            {
                Section("Add location history") {
                    Text(
                        "No location date has been recorded for this planting. This does not create a sowing or transplant date."
                    )
                    .font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphiteSecondary)
                    LabeledContent("Location", value: location.name)
                    DatePicker(
                        "In this location since", selection: $initialLocationDate, displayedComponents: .date)
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
        .navigationTitle("Location history")
        .task {
            await history.load()
            revised = history.periods
        }
        .refreshable {
            await history.load(); revised = history.periods
        }
        .disabled(history.isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
                Button("Save") {
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
