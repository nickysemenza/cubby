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
                transplantedAt: useTransplantDate ? transplantedAt : nil
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
                    if kind == .harvest { TextField("Harvest amount", text: $harvestAmount) }
                    TextField("Note", text: $note, axis: .vertical)
                }
                Section("Photos") {
                    if !images.isEmpty {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                                    Image(decorative: image, scale: 1)
                                        .resizable().scaledToFill().frame(width: 92, height: 92).clipped()
                                        .clipShape(
                                            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                                        )
                                        .overlay(alignment: .topTrailing) {
                                            Button {
                                                images.remove(at: index)
                                            } label: {
                                                Image(systemName: "xmark.circle.fill")
                                            }
                                            .buttonStyle(.borderless)
                                        }
                                }
                            }
                        }
                        .frame(height: 104)
                    }
                    GardenPhotoSourceButtons { images.append(contentsOf: $0) }
                    if let uploadStatus { Text(uploadStatus).font(.porcelainLabel) }
                    if let uploadError {
                        Text(uploadError).font(.porcelainLabel).foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .navigationTitle(kind == .harvest ? "Log harvest" : "Garden entry")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(target.locationID == nil || model.isSaving)
                }
            }
        }
    }

    private func save() async {
        guard let locationID = target.locationID else { return }
        uploadError = nil
        do {
            let ids = try await uploader.upload(images) { step in
                Task { @MainActor in
                    uploadStatus =
                        switch step {
                        case .encoding(let index, let count): "Preparing photo \(index) of \(count)…"
                        case .uploading(let index, let count): "Uploading photo \(index) of \(count)…"
                        case .done: nil
                        }
                }
            }
            let saved = await model.record(
                RecordGardenEntry(
                    locationID: locationID,
                    plantingID: target.planting?.id,
                    kind: kind,
                    observedAt: observedAt,
                    note: note.nilIfEmpty,
                    harvestAmount: kind == .harvest ? harvestAmount.nilIfEmpty : nil,
                    pendingImageIDs: ids
                )
            )
            if saved { dismiss() }
        } catch {
            uploadError = String(describing: error)
        }
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
                VStack(alignment: .leading) {
                    Text(planting.ingredient.name).font(.porcelainBody.weight(.semibold))
                    if let date = planting.finishedAt {
                        Text(date.formatted(date: .abbreviated, time: .omitted)).font(.porcelainLabel)
                    }
                }
            }
            .navigationTitle("Finished plantings")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct GardenPlantingDetailSheet: View {
    let model: GardenModel
    let planting: GardenPlanting
    let guide: GardenGuide?
    let source: (String) -> GardenGuideSource?
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false

    var body: some View {
        NavigationStack {
            List {
                Section("Planting") {
                    LabeledContent("Crop", value: planting.ingredient.name)
                    LabeledContent("Status", value: planting.status.rawValue.capitalized)
                    if let variety = planting.variety { LabeledContent("Variety", value: variety) }
                    if let quantity = planting.quantity { LabeledContent("Quantity", value: quantity) }
                    if let location = planting.location { LabeledContent("Location", value: location.name) }
                    if let planned = planting.plannedWindow { LabeledContent("Plan", value: planned) }
                }
                if let notes = planting.notes { Section("Notes") { Text(notes) } }
                if let guide {
                    Section("Planting guide") {
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
            .navigationTitle(planting.ingredient.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Edit") { editing = true } }
            }
            .sheet(isPresented: $editing) { GardenPlantingCorrectionSheet(model: model, planting: planting) }
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

private struct GardenOptionPicker: View {
    let title: String
    @Binding var selection: String
    let options: [GardenOption]
    var required = false

    init(_ title: String, selection: Binding<String>, options: [GardenOption], required: Bool = false) {
        self.title = title
        _selection = selection
        self.options = options
        self.required = required
    }

    var body: some View {
        Picker(title, selection: $selection) {
            Text(required ? "Choose…" : "None").tag("")
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

struct GardenHistorySheet: View {
    let model: GardenModel
    let uploader: GardenImageUploader
    @Environment(\.dismiss) private var dismiss
    @State private var editing: GardenEntry?
    var body: some View {
        NavigationStack {
            List(model.entries) { entry in
                Button {
                    editing = entry
                } label: {
                    VStack(alignment: .leading) {
                        Text(entry.kind.rawValue.capitalized)
                        Text(
                            entry.note ?? entry.harvestAmount
                                ?? entry.observedAt.formatted(date: .abbreviated, time: .omitted)
                        ).font(.caption)
                    }
                }
            }
            .navigationTitle("Garden history")
            .task { await model.loadEntries() }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $editing) { GardenEntryCorrectionSheet(model: model, entry: $0, uploader: uploader) }
        }
    }
}

private struct GardenEntryCorrectionSheet: View {
    let model: GardenModel; let entry: GardenEntry; let uploader: GardenImageUploader
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date; @State private var note: String; @State private var amount: String
    @State private var images: [CGImage] = []; @State private var removed: Set<String> = []
    init(model: GardenModel, entry: GardenEntry, uploader: GardenImageUploader) {
        self.model = model; self.entry = entry; self.uploader = uploader
        _date = State(initialValue: entry.observedAt); _note = State(initialValue: entry.note ?? "");
        _amount = State(initialValue: entry.harvestAmount ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Date", selection: $date, displayedComponents: .date)
                TextField("Note", text: $note, axis: .vertical)
                if entry.kind == .harvest { TextField("Harvest amount", text: $amount) }
                Section("Photos") {
                    ForEach(entry.imageIDs, id: \.self) { id in
                        Toggle(
                            id,
                            isOn: Binding(
                                get: { !removed.contains(id) },
                                set: { if !$0 { removed.insert(id) } else { removed.remove(id) } }))
                    }
                    GardenPhotoSourceButtons { images.append(contentsOf: $0) }
                }
            }.navigationTitle("Edit entry").toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(model.isSaving)
                }
            }
        }
    }
    private func save() async {
        guard let pending = try? await uploader.upload(images) else { return }
        if await model.updateEntry(
            EditGardenEntry(
                id: entry.id, locationID: entry.locationID, plantingID: entry.plantingID, kind: entry.kind,
                observedAt: date, note: note.nilIfEmpty, harvestAmount: amount.nilIfEmpty,
                pendingImageIDs: pending, removeImageIDs: Array(removed)))
        {
            dismiss()
        }
    }
}
