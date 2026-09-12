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
        .porcelainScreen()
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Scan or type a location code")
            HStack(spacing: PorcelainTokens.Space.sm) {
                TextField("LOC-….", text: $code)
                    .keyboardDismissBar()
                    .font(.porcelainCode)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.characters)
                    #endif
                    .onSubmit(submitCode)
                    .padding(.horizontal, PorcelainTokens.Space.md)
                    .frame(height: PorcelainTokens.touchTarget)
                    .background(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                            .fill(PorcelainTokens.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                            .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                    )
                Button("Go", action: submitCode)
                    .font(.porcelainTitle)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: PorcelainTokens.radiusControl))
                    .tint(PorcelainTokens.cobalt)
                    .frame(height: PorcelainTokens.touchTarget)
                    .disabled(code.isEmpty)
            }
            if let codeError {
                Text(codeError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
            }
        }
        .listRowBackground(PorcelainTokens.canvas)
        .listRowSeparator(.hidden)
    }

    private func scopeRow(_ node: LocationTreeNode, depth: Int) -> some View {
        Button {
            Task { await session.start(scope: node.id) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: PorcelainTokens.Space.md) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(node.name)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .lineLimit(1)
                    if let type = node.type {
                        Eyebrow(type)
                    }
                }
                Spacer(minLength: PorcelainTokens.Space.sm)
                Text("\(node.totalItemCount)")
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
            .padding(.leading, CGFloat(depth) * 14)
            .frame(minHeight: PorcelainTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .porcelainListRow()
    }

    private func submitCode() {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let parsed = Shortcode.parse(trimmed), parsed.key == .location else {
            codeError = "That's not a location code."
            return
        }
        codeError = nil
        code = ""
        Task { await session.start(scope: LocationCode(parsed.code)) }
    }
}

#Preview("Scope picker") {
    NavigationStack {
        ScopePickerSheet(session: RecountSession(service: PreviewFixtures.signedInModel().client))
    }
    .environment(PreviewFixtures.signedInModel())
}
