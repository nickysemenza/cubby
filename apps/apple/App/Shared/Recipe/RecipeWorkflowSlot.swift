import CubbyKit
import SwiftUI

#if os(iOS)
    import UIKit
#endif

/// `recipe.workflow`: scale a recipe and cook it step by step. Scaling is Rust through CubbyKit's
/// `RecipeScaling` (the same code web runs as WASM); the scale and the cook-mode position are
/// local view state, never written back, as on web where they live only in the URL. What the
/// pantry covers, why the totals are incomplete, the unscaled weight a weight target measures
/// against, and the AI walkthrough are the server's reports (`recipe.availability`,
/// `recipe.costing-coverage`, `recipe.walkthrough`): this loads and draws them.
struct RecipeWorkflowDetailSlot: View {
    let row: EntityRow

    var body: some View {
        if let plan = RecipeCookPlan(recipe: row.raw), !plan.sections.isEmpty {
            RecipeWorkflowView(plan: plan, recipeID: row.id)
        } else {
            Text("This recipe has no ingredients or method yet.").foregroundStyle(.secondary)
        }
    }
}

struct RecipeWorkflowView: View {
    let plan: RecipeCookPlan
    /// The recipe's code, for the server's reports; nil in a preview.
    var recipeID: String?
    @State private var factor = 1.0
    @State private var customText = ""
    @State private var weightText = ""
    @State private var weightOpen = false
    @Environment(AppModel.self) private var appModel
    /// The unscaled total weight in grams, from the server's costing report; nil until it loads
    /// or when no ingredient line reaches grams.
    @State private var baseWeight: Double?
    @State private var coverageLoaded = false

    private static let presets: [(label: String, factor: Double)] = [
        ("½×", 0.5), ("1×", 1), ("2×", 2), ("3×", 3),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            if let recipeID {
                ReportDetailSlot(slot: .recipeAvailability, id: recipeID)
                    .transformPreference(DetailSectionEmpty.self) { $0 = false }
            }
            scaleControls
            if let makes = plan.yieldLabel(factor: factor) {
                Text("Makes \(makes)").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(plan.sections) { section in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    if let name = section.name {
                        Text(name).font(.headline)
                    }
                    ForEach(section.ingredients) { line in
                        Text(plan.line(line, factor: factor))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            Button {
                appModel.recipeCooking.open(recipeID: recipeID, plan: plan, factor: factor)
            } label: {
                Label("Start cooking", systemImage: "frying.pan")
                    .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget)
            }
            .buttonStyle(.borderedProminent)
            .disabled(plan.steps.isEmpty)
            .accessibilityIdentifier("recipe.workflow.cook")
            if plan.steps.isEmpty {
                Text("This recipe has no method steps to cook through.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let recipeID {
                RecipeCoverageSection(
                    recipeID: recipeID, baseWeight: $baseWeight,
                    loaded: $coverageLoaded)
                OpenDetailGroup(title: "AI walkthrough") {
                    ReportDetailSlot(slot: .recipeWalkthrough, id: recipeID)
                        .transformPreference(DetailSectionEmpty.self) { $0 = false }
                }
                .accessibilityIdentifier("recipe.walkthrough")
            }
        }
    }

    private var scaleControls: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Picker("Scale", selection: presetSelection) {
                ForEach(Self.presets, id: \.factor) { preset in
                    Text(preset.label).tag(Optional(preset.factor))
                }
                if !Self.presets.contains(where: { $0.factor == factor }) {
                    Text(ValueFormat.number(factor) + "×").tag(Optional(factor))
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("recipe.workflow.scale")
            HStack {
                TextField("Custom multiplier", text: $customText)
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
                    .onSubmit(applyCustom)
                    .accessibilityIdentifier("recipe.workflow.custom")
                Button("Apply", action: applyCustom)
                    .disabled(Double(customText) == nil)
            }
            if recipeID != nil { weightAnchor }
        }
    }

    /// "Make this much": the target weight is measured against the unscaled weight the server
    /// reported, by the same Rust rule web runs, so it never compounds on the current scale.
    @ViewBuilder private var weightAnchor: some View {
        if !weightOpen {
            Button("Scale to a total weight…") { weightOpen = true }
                .accessibilityIdentifier("recipe.workflow.weightOpen")
        } else if let baseWeight {
            HStack {
                TextField(
                    "Target total weight (g) — now \(Int((baseWeight * factor).rounded()))",
                    text: $weightText
                )
                #if os(iOS)
                    .keyboardType(.decimalPad)
                #endif
                .onSubmit(applyWeight)
                .accessibilityIdentifier("recipe.workflow.weight")
                Button("Apply", action: applyWeight)
                    .disabled(Double(weightText) == nil)
            }
        } else if coverageLoaded {
            Text("No weight conversion yet — add a unit mapping to scale by weight.")
                .font(.caption).foregroundStyle(.secondary)
        } else {
            LoadingIndicator(label: "Loading weights")
        }
    }

    private func applyWeight() {
        guard let target = Double(weightText), let baseWeight else { return }
        factor = RecipeScaling.factor(
            forTotalWeight: target, scaledWeight: baseWeight * factor, currentFactor: factor)
        weightText = ""
    }

    private var presetSelection: Binding<Double?> {
        Binding(
            get: { factor },
            set: { if let value = $0 { factor = value } })
    }

    private func applyCustom() {
        guard let value = Double(customText) else { return }
        // The clamp (finite, positive, floored) is Rust's, not a Swift rule.
        factor = RecipeScaling.clamp(value)
        customText = ""
    }
}

/// Why a recipe's totals are incomplete, from the server's `recipe.costing-coverage` report. It
/// stays open in the continuous detail and hands the unscaled weight to the scale control.
private struct RecipeCoverageSection: View {
    let recipeID: String
    @Binding var baseWeight: Double?
    @Binding var loaded: Bool
    @Environment(AppModel.self) private var appModel
    @State private var model: ReportSlotModel?

    var body: some View {
        OpenDetailGroup(title: "Totals coverage") {
            if let presentation = model?.presentation {
                ReportBlocksView(report: presentation, host: nil, model: model)
                    .transformPreference(DetailSectionEmpty.self) { $0 = false }
            } else if let failure = model?.failure {
                Text(failure).foregroundStyle(.secondary)
            } else {
                LoadingIndicator(label: "Loading")
            }
        }
        .accessibilityIdentifier("recipe.costingCoverage")
        .task(id: recipeID) {
            let next =
                model
                ?? ReportSlotModel(slot: .recipeCostingCoverage, id: recipeID, service: appModel.client)
            model = next
            await next.refresh()
            baseWeight = next.presentation?.figureValue("weightGrams")
            loaded = true
        }
    }
}

/// One method step per page, with its section's scaled quantities visible without disclosure.
struct RecipeCookModeView: View {
    @Bindable var session: RecipeCookingState.Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    #if os(iOS)
        @State private var previousIdleTimerDisabled: Bool?
    #endif

    private var position: RecipeCookHandoff? {
        session.recipeID.map { RecipeCookHandoff(recipeID: $0, step: session.index) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: FieldGuideTokens.Space.md) {
                if session.plan.steps.isEmpty {
                    Text("This recipe has no method steps.").foregroundStyle(.secondary)
                } else {
                    Text("Step \(session.index + 1) of \(session.plan.steps.count)")
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("recipe.cook.progress")
                    pager
                    controls
                }
            }
            .padding(FieldGuideTokens.Space.md)
            .navigationTitle(session.plan.title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("recipe.cook.done")
                }
            }
        }
        .interactiveDismissDisabled()
        .userActivity(RecipeCookHandoff.activityType, element: position) { position, activity in
            position.update(activity, title: session.plan.title)
        }
        #if os(iOS)
            .onAppear {
                guard previousIdleTimerDisabled == nil else { return }
                previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
                UIApplication.shared.isIdleTimerDisabled = true
            }
            .onDisappear {
                if let previousIdleTimerDisabled {
                    UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
                }
                previousIdleTimerDisabled = nil
            }
        #endif
    }

    @ViewBuilder private var pager: some View {
        #if os(iOS)
            TabView(selection: $session.index) {
                ForEach(session.plan.steps) { step in
                    page(step).tag(step.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        #else
            page(session.plan.steps[session.index])
        #endif
    }

    private func page(_ step: RecipeCookPlan.Step) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                if let name = step.sectionName {
                    Text("\(name) · step \(step.numberInSection)")
                        .font(.headline).foregroundStyle(.secondary)
                }
                Text(.init(step.text))
                    .font(.title)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("recipe.cook.step.\(step.id)")
                let section = session.plan.sections[step.sectionIndex]
                if !section.ingredients.isEmpty {
                    Text("Ingredients for this part").font(.headline)
                    ForEach(section.ingredients) { line in
                        Text(session.plan.line(line, factor: session.factor))
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, FieldGuideTokens.Space.sm)
        }
    }

    private var controls: some View {
        let layout =
            dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: FieldGuideTokens.Space.sm))
            : AnyLayout(HStackLayout(spacing: FieldGuideTokens.Space.md))
        return layout {
            Button {
                session.index -= 1
            } label: {
                Text("Previous")
                    .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget)
            }
            .buttonStyle(.bordered)
            .disabled(session.index == 0)
            .accessibilityIdentifier("recipe.cook.previous")
            if session.index == session.plan.steps.count - 1 {
                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("recipe.cook.finish")
            } else {
                Button {
                    session.index += 1
                } label: {
                    Text("Next")
                        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("recipe.cook.next")
            }
        }
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
    }
}

#Preview("Recipe workflow", traits: .modifier(SignedInPreview())) {
    ScrollView { RecipeWorkflowView(plan: RecipeSlotPreviews.plan).padding() }
}

#Preview("Cook mode") {
    RecipeCookModeView(session: .init(recipeID: nil, plan: RecipeSlotPreviews.plan, factor: 2))
}

#Preview("Cook mode AX3") {
    RecipeCookModeView(session: .init(recipeID: nil, plan: RecipeSlotPreviews.plan, factor: 2, index: 1))
        .environment(\.dynamicTypeSize, .accessibility3)
}

enum RecipeSlotPreviews {
    static let plan = RecipeCookPlan(
        recipe: .object([
            "name": .string("Synthetic Tart"),
            "yield": .object(["value": .number(4), "unit": .string("serving")]),
            "sections": .array([
                .object([
                    "name": .string("Crust"),
                    "ingredients": .array([
                        .object([
                            "amounts": .array([
                                .object(["value": .number(2), "unit": .string("cup")])
                            ]),
                            "ingredient": .object(["name": .string("flour")]),
                        ]),
                        .object([
                            "amounts": .array([
                                .object(["value": .number(9), "unit": .string("inch")])
                            ]),
                            "ingredient": .object(["name": .string("pan")]),
                        ]),
                    ]),
                    "instructions": .array([
                        .object(["instruction": .string("Mix the dough.")]),
                        .object(["instruction": .string("Chill it for **30 minutes**.")]),
                    ]),
                ])
            ]),
        ]))!
}
