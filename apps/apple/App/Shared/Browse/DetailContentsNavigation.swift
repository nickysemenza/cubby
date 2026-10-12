import SwiftUI

struct DetailContentsEntry: Identifiable {
    let id: String
    let title: String
    let group: String
}

// Outline row identities must not match content targets in the shared scroll reader.
private struct DetailContentsAnchorID: Hashable {
    let id: String
}

private struct DetailContentsPositions: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct DetailContentsEmptyStates: PreferenceKey {
    static let defaultValue: [String: Bool] = [:]
    static func reduce(value: inout [String: Bool], nextValue: () -> [String: Bool]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct DetailContentsJump: Equatable {
    let id: String
    let revision = UUID()
}

private struct DetailContentsCompletionKey: EnvironmentKey {
    static let defaultValue: @MainActor @Sendable (UUID) -> Void = { _ in }
}

private struct DetailContentsDestinationKey: EnvironmentKey {
    static let defaultValue: DetailContentsJump? = nil
}

private extension EnvironmentValues {
    var completeDetailContentsJump: @MainActor @Sendable (UUID) -> Void {
        get { self[DetailContentsCompletionKey.self] }
        set { self[DetailContentsCompletionKey.self] = newValue }
    }
    var detailContentsDestination: DetailContentsJump? {
        get { self[DetailContentsDestinationKey.self] }
        set { self[DetailContentsDestinationKey.self] = newValue }
    }
}

private struct DetailContentsSectionIDKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

private extension EnvironmentValues {
    var detailContentsSectionID: String? {
        get { self[DetailContentsSectionIDKey.self] }
        set { self[DetailContentsSectionIDKey.self] = newValue }
    }
}

/// Only a single header owns scroll identity and focus. Section modifiers otherwise propagate
/// to each List child, producing duplicate destinations and last-row scroll positions.
private struct DetailContentsHeader: ViewModifier {
    var empty: Bool
    @Environment(\.detailContentsSectionID) private var id
    @Environment(\.detailContentsDestination) private var destination
    @Environment(\.completeDetailContentsJump) private var completeJump
    @AccessibilityFocusState private var accessibilityFocused: Bool
    @FocusState private var keyboardFocused: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if let id {
            content.id(DetailContentsAnchorID(id: id))
                .accessibilityElement(children: .contain)
                .accessibilityFocused($accessibilityFocused)
                .focusable()
                .focused($keyboardFocused)
                .onChange(of: destination, initial: true) { _, destination in
                    guard let destination, destination.id == id else { return }
                    accessibilityFocused = true
                    keyboardFocused = true
                    completeJump(destination.revision)
                }
                .preference(key: DetailContentsEmptyStates.self, value: [id: empty])
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(
                            key: DetailContentsPositions.self,
                            value: [id: geometry.frame(in: .named("detail.contents")).minY])
                    }
                }
        } else {
            content
        }
    }
}

extension View {
    func detailContentsAnchor(_ id: String) -> some View {
        environment(\.detailContentsSectionID, id)
    }

    func detailContentsHeader(empty: Bool = false) -> some View {
        modifier(DetailContentsHeader(empty: empty))
    }
}

/// The outline navigates the same mounted detail; selecting an entry never changes its content.
struct DetailContentsNavigation: ViewModifier {
    let entries: [DetailContentsEntry]
    @State private var presented = false
    @State private var current: String?
    @State private var destination: DetailContentsJump?
    @State private var emptyStates: [String: Bool] = [:]

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    #if os(macOS)
                        if presented && geometry.size.width >= 700 {
                            outline(proxy: proxy, dismissOnSelection: false).frame(width: 220)
                            Divider()
                        }
                    #endif
                    content
                        .environment(\.detailContentsDestination, destination)
                        .environment(\.completeDetailContentsJump) { revision in
                            guard destination?.revision == revision else { return }
                            destination = nil
                        }
                        .onPreferenceChange(DetailContentsEmptyStates.self) { emptyStates = $0 }
                        .coordinateSpace(name: "detail.contents")
                        .onPreferenceChange(DetailContentsPositions.self) { positions in
                            current =
                                positions.filter { $0.value <= 100 }
                                .max(by: { $0.value < $1.value })?.key
                                ?? positions.min(by: { $0.value < $1.value })?.key
                        }
                }
                .toolbar {
                    ToolbarItem {
                        Button {
                            presented.toggle()
                        } label: {
                            Label("Contents", systemImage: "list.bullet.indent")
                        }
                        .accessibilityIdentifier("detail.contents")
                        .popover(isPresented: popoverBinding(width: geometry.size.width)) {
                            NavigationStack {
                                outline(proxy: proxy)
                                    .navigationTitle("Contents")
                                    .toolbar {
                                        ToolbarItem(placement: .cancellationAction) {
                                            Button("Close") { presented = false }
                                        }
                                    }
                            }
                            .frame(idealWidth: 320, idealHeight: 480)
                            #if os(iOS)
                                .presentationCompactAdaptation(.sheet)
                                .presentationDetents([.medium, .large])
                            #endif
                        }
                    }
                }
            }
        }
    }

    private func popoverBinding(width: CGFloat) -> Binding<Bool> {
        Binding {
            #if os(macOS)
                presented && width < 700
            #else
                presented
            #endif
        } set: {
            presented = $0
        }
    }

    private func outline(proxy: ScrollViewProxy, dismissOnSelection: Bool = true) -> some View {
        List {
            ForEach(groups, id: \.self) { group in
                Section(group) {
                    ForEach(entries.filter { $0.group == group }) { entry in
                        Button {
                            proxy.scrollTo(DetailContentsAnchorID(id: entry.id), anchor: .top)
                            destination = DetailContentsJump(id: entry.id)
                            if dismissOnSelection { presented = false }
                            current = entry.id
                        } label: {
                            HStack {
                                Text(entry.title).padding(.leading, 12)
                                    .foregroundStyle(emptyStates[entry.id] == true ? .secondary : .primary)
                                if emptyStates[entry.id] == true {
                                    Text("Empty").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if current == entry.id {
                                    Image(systemName: "checkmark").accessibilityHidden(true)
                                }
                            }
                        }
                        .accessibilityIdentifier("detail.contents.\(entry.id)")
                        .accessibilityAddTraits(current == entry.id ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var groups: [String] {
        entries.reduce(into: []) { groups, entry in
            if !groups.contains(entry.group) { groups.append(entry.group) }
        }
    }
}

#Preview {
    List {
        ContinuousDetailSection(title: "Details") { Text("Example") }
            .detailContentsAnchor("example")
    }
    .modifier(
        DetailContentsNavigation(entries: [
            .init(id: "example", title: "Details", group: "Overview")
        ]))
}

struct DetailSectionEmpty: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

struct ContinuousDetailSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @State private var empty = false

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text(title).foregroundStyle(empty ? .secondary : .primary)
                if empty { Text("Empty").font(.caption).foregroundStyle(.secondary) }
            }.detailContentsHeader(empty: empty)
        }
        .onPreferenceChange(DetailSectionEmpty.self) { empty = $0 }
    }
}

#Preview("Empty section") {
    List {
        ContinuousDetailSection(title: "Items") {
            Text("No items").preference(key: DetailSectionEmpty.self, value: true)
        }
    }
}

struct OpenDetailGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(title).font(.subheadline.weight(.medium))
            content
        }
    }
}

#Preview("Open detail group") {
    OpenDetailGroup(title: "Evidence") { Text("Example") }.padding()
}

/// The explanation button retains its normal control contrast beside empty title metadata.
struct ExplainedDetailSection<Content: View, Header: View>: View {
    @ViewBuilder let content: Content
    @ViewBuilder let header: (Bool) -> Header
    @State private var empty = false

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                header(empty)
                if empty { Text("Empty").font(.caption).foregroundStyle(.secondary) }
            }.detailContentsHeader(empty: empty)
        }
        .onPreferenceChange(DetailSectionEmpty.self) { empty = $0 }
    }
}

#Preview("Explained section") {
    List {
        ExplainedDetailSection {
            Text("No items")
        } header: { _ in
            Text("Evidence")
        }
    }
}
