import CubbyKit
import SwiftUI

/// Where to start a walk: every location worth auditing, indented by depth, plus a code field for
/// scanning or typing a location shortcode straight to its scope. Rendered inline as the whole
/// screen while `RecountSession.phase == .choosingScope` — despite the filename shared with the
/// rest of the audit screens, this is never presented as a sheet.
struct ScopePickerSheet: View {
    let session: RecountSession
    @State private var code = ""
    @State private var codeError: String?

    private var candidates: [(node: LocationTreeNode, depth: Int)] {
        session.tree?.scopeCandidates() ?? []
    }

    var body: some View {
        List {
            codeRow
            ForEach(Array(candidates.enumerated()), id: \.element.node.id) { _, entry in
                scopeRow(entry.node, depth: entry.depth)
            }
        }
        .listStyle(.plain)
        .fieldGuideScreen()
        .refreshControl { await session.loadTree() }
        .overlay {
            if candidates.isEmpty {
                ContentUnavailableView(
                    "Nothing stocked",
                    systemImage: "shippingbox",
                    description: Text("Locations with stock somewhere beneath them show up here.")
                )
            }
        }
    }

    private var codeRow: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("Scan or type a location code")
            HStack(spacing: FieldGuideTokens.Space.sm) {
                TextField("LOC-….", text: $code)
                    .keyboardDismissBar()
                    .font(.fieldGuideCode)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.characters)
                    #endif
                    .onSubmit(submitCode)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
                    .frame(height: FieldGuideTokens.touchTarget)
                    .background(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                            .fill(FieldGuideTokens.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                            .strokeBorder(
                                FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                    )
                Button("Go", action: submitCode)
                    .font(.fieldGuideTitle)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: FieldGuideTokens.radiusControl))
                    .tint(FieldGuideTokens.interaction)
                    .frame(height: FieldGuideTokens.touchTarget)
                    .disabled(code.isEmpty)
            }
            if let codeError {
                Text(codeError)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.destructive)
            }
        }
        .listRowBackground(FieldGuideTokens.canvas)
        .listRowSeparator(.hidden)
    }

    private func scopeRow(_ node: LocationTreeNode, depth: Int) -> some View {
        Button {
            Task { await session.start(scope: node.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.md) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(node.name)
                        .font(.fieldGuideBody)
                        .foregroundStyle(FieldGuideTokens.graphite)
                        .lineLimit(1)
                    Eyebrow(node._type.rawValue)
                }
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Text("\(node.totalItems)")
                    .font(.fieldGuideData)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            }
            .padding(.leading, CGFloat(depth) * 14)
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func submitCode() {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let label = CubbyLabel(trimmed), label.key == .location else {
            codeError = "That's not a location code."
            return
        }
        codeError = nil
        code = ""
        Task { await session.start(scope: LocationCode(label.code)) }
    }
}

#Preview("Scope picker") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    NavigationStack {
        ScopePickerSheet(session: RecountSession(service: appModel.client))
    }
    .environment(appModel)
}
