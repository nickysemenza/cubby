import CubbyKit
import SwiftUI

/// Developer utilities: the Rust parser over FFI, a one-tap API check, and the app's own
/// coordinates. This is where a new capability gets its first visible proof before it has a real
/// screen — so it shows raw values, in the data voice, and formats nothing away.
struct DevView: View {
    @Environment(AppModel.self) private var model
    @State private var line = "2 cups flour"
    @State private var apiResult: String?
    @State private var checking = false

    private var parsed: IngredientParser.Parsed { IngredientParser.parse(line) }

    private var amountsLabel: String {
        let amounts = parsed.amounts.map { amount in
            "\(amount.value)\(amount.upperValue.map { "-\($0)" } ?? "") \(amount.unit)"
        }
        return amounts.isEmpty ? "none" : amounts.joined(separator: ", ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("Rust ingredient parser (UniFFI)")
                    TextField("Ingredient line", text: $line)
                        .keyboardDismissBar()
                        .font(.porcelainCode)
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        .padding(.horizontal, PorcelainTokens.Space.md)
                        .frame(height: PorcelainTokens.touchTarget)
                        .background(
                            RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                                .fill(PorcelainTokens.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                                .strokeBorder(
                                    PorcelainTokens.hairline,
                                    lineWidth: PorcelainTokens.hairlineWidth
                                )
                        )
                    Panel(padding: 0, spacing: 0) {
                        LabeledRow(label: "Name", value: parsed.name)
                        PanelDivider()
                        LabeledRow(label: "Amounts", value: amountsLabel, data: true)
                        if let modifier = parsed.modifier {
                            PanelDivider()
                            LabeledRow(label: "Modifier", value: modifier)
                        }
                        PanelDivider()
                        LabeledRow(label: "Optional", value: parsed.optional ? "Yes" : "No")
                        PanelDivider()
                        LabeledRow(
                            label: "Unit aliases",
                            value: IngredientParser.sizeUnitAliases.count.formatted(),
                            data: true
                        )
                    }
                }

                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("API")
                    Button {
                        Task { await check() }
                    } label: {
                        HStack(spacing: PorcelainTokens.Space.sm) {
                            if checking { ProgressView().controlSize(.small) }
                            Text(checking ? "Checking…" : "Fetch first product")
                                .font(.porcelainTitle)
                        }
                        .frame(maxWidth: .infinity, minHeight: PorcelainTokens.touchTarget)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: PorcelainTokens.radiusControl))
                    .tint(PorcelainTokens.cobalt)
                    .disabled(checking)
                    if let apiResult {
                        Panel {
                            Text(apiResult)
                                .font(.porcelainCode)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("App")
                    Panel(padding: 0, spacing: 0) {
                        NavigationLink {
                            SettingsView()
                        } label: {
                            HStack(spacing: PorcelainTokens.Space.md) {
                                Text("Settings").font(.porcelainBody)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            }
                            .padding(.horizontal, PorcelainTokens.Space.md)
                            .frame(minHeight: PorcelainTokens.touchTarget)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        PanelDivider()
                        LabeledRow(label: "CubbyKit", value: CubbyKitInfo.version, mono: true)
                        PanelDivider()
                        LabeledRow(label: "Host", value: model.host, mono: true)
                    }
                }
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        .navigationTitle("Dev")
    }

    private func check() async {
        checking = true
        defer { checking = false }
        do {
            let page = try await model.client.list(EntityCatalog[.product], page: 1, pageSize: 1)
            apiResult =
                "\(page.meta.totalCount.formatted()) products · first: \(page.items.first?.title ?? "none")"
        } catch {
            apiResult = String(describing: error)
            model.handle(error)
        }
    }
}

#Preview {
    NavigationStack { DevView() }.environment(PreviewFixtures.signedInModel())
}
