import CubbyKit
import SwiftUI

/// `recipe.workflow`: scale a recipe and cook it step by step. Scaling is Rust through CubbyKit's
/// `RecipeScaling` (the same code web runs as WASM); the scale and the cook-mode position are
/// local view state, never written back, as on web where they live only in the URL.
struct RecipeWorkflowDetailSlot: View {
    let row: EntityRow

    var body: some View {
        if let plan = RecipeCookPlan(recipe: row.raw), !plan.sections.isEmpty {
            RecipeWorkflowView(plan: plan)
        } else {
            Text("This recipe has no ingredients or method yet.").foregroundStyle(.secondary)
        }
    }
}

struct RecipeWorkflowView: View {
    let plan: RecipeCookPlan
    @State private var factor = 1.0
    @State private var customText = ""
    @State private var cooking = false

    private static let presets: [(label: String, factor: Double)] = [
        ("½×", 0.5), ("1×", 1), ("2×", 2), ("3×", 3),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
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
                cooking = true
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
        }
        .sheet(isPresented: $cooking) {
            RecipeCookModeView(plan: plan, factor: factor)
                .nativeSheet(.preview)
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
        }
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

/// Step progression through a recipe's method with that section's scaled ingredients beside it.
/// The step index is local state; nothing about cooking is persisted.
struct RecipeCookModeView: View {
    let plan: RecipeCookPlan
    let factor: Double
    @State private var index = 0
    @Environment(\.dismiss) private var dismiss

    private var step: RecipeCookPlan.Step { plan.steps[min(index, plan.steps.count - 1)] }

    var body: some View {
        NavigationStack {
            if plan.steps.isEmpty {
                Text("This recipe has no method steps.").foregroundStyle(.secondary)
            } else {
                content
            }
        }
        #if os(iOS)
            // A phone on the counter must not lock mid-step.
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        #endif
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
            ProgressView(value: Double(index + 1), total: Double(plan.steps.count))
                .accessibilityLabel("Step \(index + 1) of \(plan.steps.count)")
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                    Text(
                        step.sectionName.map { "\($0) · step \(step.numberInSection)" }
                            ?? "Step \(step.numberInSection)"
                    )
                    .font(.subheadline).foregroundStyle(.secondary)
                    Text(.init(step.text))
                        .font(.title3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("recipe.cook.step")
                    if !section.ingredients.isEmpty {
                        DisclosureGroup("Ingredients for this part") {
                            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                                ForEach(section.ingredients) { line in
                                    Text(plan.line(line, factor: factor))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
            }
            HStack {
                Button {
                    index -= 1
                } label: {
                    Label("Previous", systemImage: "chevron.left")
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                }
                .disabled(index == 0)
                Spacer()
                Text("Step \(index + 1) of \(plan.steps.count)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if index == plan.steps.count - 1 {
                    Button("Done") { dismiss() }
                        .buttonStyle(.borderedProminent)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                } else {
                    Button {
                        index += 1
                    } label: {
                        Label("Next", systemImage: "chevron.right")
                            .labelStyle(.titleAndIcon)
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("recipe.cook.next")
                }
            }
        }
        .padding()
        .navigationTitle(plan.title)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        }
    }

    private var section: RecipeCookPlan.Section { plan.sections[step.sectionIndex] }
}

#Preview("Recipe workflow") {
    ScrollView { RecipeWorkflowView(plan: RecipeSlotPreviews.plan).padding() }
}

#Preview("Cook mode") {
    RecipeCookModeView(plan: RecipeSlotPreviews.plan, factor: 2)
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
