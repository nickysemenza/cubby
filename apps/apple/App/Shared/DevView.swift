import CubbyKit
import SwiftUI

/// Developer utilities: server settings, an FFI smoke test, and a one-tap API check. This is
/// where a new capability gets its first visible proof before it has a real screen.
struct DevView: View {
    @Environment(AppModel.self) private var model
    @State private var line = "2 cups flour"
    @State private var apiResult: String?
    @State private var checking = false

    private var parsed: IngredientParser.Parsed { IngredientParser.parse(line) }

    var body: some View {
        List {
            Section("Rust ingredient parser (UniFFI)") {
                TextField("Ingredient line", text: $line)
                    .autocorrectionDisabled()
                LabeledContent("Name", value: parsed.name)
                LabeledContent("Amounts", value: parsed.amounts.map { "\($0.value)\($0.upperValue.map { "-\($0)" } ?? "") \($0.unit)" }.joined(separator: ", "))
                if let modifier = parsed.modifier { LabeledContent("Modifier", value: modifier) }
                LabeledContent("Optional", value: parsed.optional ? "yes" : "no")
                LabeledContent("Unit aliases", value: "\(IngredientParser.sizeUnitAliases.count)")
            }
            Section("API") {
                Button(checking ? "Checking…" : "Fetch first product") { Task { await check() } }
                    .disabled(checking)
                if let apiResult { Text(apiResult).font(.footnote.monospaced()) }
            }
            Section("App") {
                NavigationLink("Settings") { SettingsView() }
                LabeledContent("CubbyKit", value: CubbyKitInfo.version)
                LabeledContent("Host", value: model.host)
            }
        }
        .navigationTitle("Dev")
    }

    private func check() async {
        checking = true
        defer { checking = false }
        do {
            let page = try await model.client.raw.list(basePath: "products", page: 1, pageSize: 1)
            let first = page.items.first.flatMap { EntityCatalog[.product].row(from: $0) }
            apiResult = "\(page.meta.totalCount) products · first: \(first?.title ?? "none")"
        } catch {
            apiResult = String(describing: error)
            model.handle(error)
        }
    }
}

#Preview {
    NavigationStack { DevView() }.environment(PreviewFixtures.signedInModel())
}
