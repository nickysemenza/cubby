import CubbyKit
import SwiftUI

struct EntityRelationshipsSection: View {
    enum Presentation: String, CaseIterable, Identifiable {
        case list, graph
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    let model: EntityRelationshipsModel
    let onAccepted: (RelationshipAcceptance) -> Void
    @State private var presentation: Presentation = .list
    @State private var inspectedNode: EntityGraphNode?

    var body: some View {
        Group {
            if model.activity == .loadingInitial, model.graph == nil,
                model.recommendationDocument == nil
            {
                LoadingIndicator(label: "Loading relationships")
            } else {
                recommendations
                if model.graph != nil {
                    Picker("Relationship view", selection: $presentation) {
                        ForEach(Presentation.allCases) { mode in Text(mode.title).tag(mode) }
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: PorcelainTokens.touchTarget)
                    RelationshipDepthPicker(model: model)
                    if model.hasEmptyBranches {
                        Toggle(
                            "Show empty relationships",
                            isOn: Binding(
                                get: { model.showsEmptyBranches },
                                set: model.setShowsEmptyBranches
                            )
                        )
                        .frame(minHeight: PorcelainTokens.touchTarget)
                    }

                    switch presentation {
                    case .list:
                        RelationshipBranchList(model: model, onInspect: inspect)
                    case .graph:
                        if let graph = model.graph { EmbeddedGraphExplorer(graph: graph).id(graph.root) }
                    }
                    completion
                }
            }

            if let error = model.graphError {
                InlineRelationshipError(message: error) { model.requestRefresh() }
            }
            if let error = model.recommendationError {
                InlineRelationshipError(message: error) { model.requestRefresh() }
            }
        }
        .onChange(of: model.graphError) { _, error in
            if let error {
                Diagnostics.report(RelationshipDisplayError(error), context: "relationships.graph")
            }
        }
        .onChange(of: model.recommendationError) { _, error in
            if let error {
                Diagnostics.report(RelationshipDisplayError(error), context: "relationships.recommendations")
            }
        }
        .onChange(of: model.acceptError) { _, error in
            if let error {
                Diagnostics.report(RelationshipDisplayError(error), context: "relationships.accept")
            }
        }
        .sheet(item: $inspectedNode) { node in
            #if os(iOS)
                RelationshipNodeDetailsSheet(node: node, model: model)
                    .presentationDetents([.medium, .large])
            #else
                RelationshipNodeDetailsSheet(node: node, model: model)
                    .frame(minWidth: 440, minHeight: 420)
            #endif
        }
    }

    private func inspect(_ node: EntityGraphNode) {
        model.select(node.reference)
        inspectedNode = node
    }

    @ViewBuilder
    private var recommendations: some View {
        if let document = model.recommendationDocument {
            ForEach(document.groups) { group in
                RelationshipRecommendationGroupView(
                    group: group,
                    basisKey: document.basisKey,
                    model: model,
                    onAccepted: onAccepted
                )
            }
            if let error = model.acceptError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(PorcelainTokens.warning)
            }
        }
    }

    @ViewBuilder
    private var completion: some View {
        if let graph = model.graph {
            let status = graph.completion.status
            HStack(spacing: PorcelainTokens.Space.sm) {
                Image(systemName: status == .exhausted ? "checkmark.circle" : "info.circle")
                    .accessibilityHidden(true)
                Text(completionText(graph.completion))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func completionText(_ completion: EntityGraphExploreCompletion) -> String {
        switch completion.status {
        case .exhausted:
            "All relationships within depth \(completion.reachedDepth) are shown."
        case .depthLimit:
            "Reached the selected depth of \(completion.requestedDepth)."
        case .paginationLimit:
            "Some branches have more records available."
        case .budgetLimit:
            "The graph stopped at depth \(completion.reachedDepth) to stay responsive."
        }
    }
}

private struct RelationshipRecommendationGroupView: View {
    let group: EntityRecommendationGroup
    let basisKey: String
    let model: EntityRelationshipsModel
    let onAccepted: (RelationshipAcceptance) -> Void

    var body: some View {
        switch group {
        case .expenseProject(let group):
            recommendationHeader("Project", status: group.status, current: group.currentTarget?.name)
            ForEach(group.proposals) { proposal in
                ExpenseProjectProposalView(
                    proposal: proposal,
                    isAccepting: model.acceptingRecommendationID == proposal.id,
                    isDisabled: model.acceptingRecommendationID != nil || model.activity != .idle,
                    accept: { accept(.expenseProject(proposal)) }
                )
            }
        case .inventoryPlacement(let group):
            recommendationHeader("Location", status: group.status, current: group.currentTarget?.name)
            ForEach(group.proposals) { proposal in
                InventoryPlacementProposalView(
                    proposal: proposal,
                    isAccepting: model.acceptingRecommendationID == proposal.id,
                    isDisabled: model.acceptingRecommendationID != nil || model.activity != .idle,
                    accept: { accept(.inventoryPlacement(proposal)) }
                )
            }
        case .productRelated(let group):
            recommendationHeader("Related products", status: group.status, current: nil)
            ForEach(group.proposals) { proposal in
                ProductRelationshipProposalView(proposal: proposal)
            }
        }
    }

    private func recommendationHeader(
        _ title: String,
        status: EmbeddingReadiness,
        current: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                RelationshipReadinessLabel(status: status)
            }
            if let current {
                LabeledContent("Current", value: current)
                    .font(.callout)
            }
        }
    }

    private func accept(_ proposal: ActionableRelationshipRecommendation) {
        requestRelationshipAcceptance(
            model: model,
            proposal: proposal,
            basisKey: basisKey,
            onAccepted: onAccepted
        )
    }
}

struct RelationshipRecommendationReview: Identifiable {
    let proposal: ActionableRelationshipRecommendation
    let basisKey: String
    let source: EntityRef
    /// The name of the target the record has now, if any.
    let currentTarget: String?

    var id: String { "\(basisKey):\(proposal.id)" }
}

struct RelationshipRecommendationReviewSheet: View {
    let review: RelationshipRecommendationReview
    let model: EntityRelationshipsModel
    let onAccepted: (RelationshipAcceptance) -> Void
    @Environment(\.dismiss) private var dismiss

    private var canAccept: Bool {
        model.recommendationDocument?.basisKey == review.basisKey
            && model.acceptingRecommendationID == nil
            && model.activity == .idle
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Change") {
                    comparison
                }
                Section("Suggested change") {
                    switch review.proposal {
                    case .expenseProject(let proposal):
                        ExpenseProjectProposalView(
                            proposal: proposal,
                            isAccepting: model.acceptingRecommendationID == proposal.id,
                            isDisabled: !canAccept,
                            accept: accept
                        )
                    case .inventoryPlacement(let proposal):
                        InventoryPlacementProposalView(
                            proposal: proposal,
                            isAccepting: model.acceptingRecommendationID == proposal.id,
                            isDisabled: !canAccept,
                            accept: accept
                        )
                    }
                }
                if !canAccept, model.recommendationDocument?.basisKey != review.basisKey {
                    Section {
                        Label(
                            "This suggestion has changed. Review the latest alternative.",
                            systemImage: "arrow.clockwise"
                        )
                        .foregroundStyle(.secondary)
                    }
                }
                if let error = model.acceptError {
                    Section("Couldn't save") {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(PorcelainTokens.warning)
                        Button("Retry", action: accept)
                            .frame(minHeight: PorcelainTokens.touchTarget)
                            .disabled(!canAccept)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Review suggestion")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: model.source) { _, source in
                if source != review.source { dismiss() }
            }
            .onChange(of: model.recommendationDocument?.basisKey) { _, basisKey in
                if let basisKey, basisKey != review.basisKey { dismiss() }
            }
        }
    }

    @ViewBuilder
    private var comparison: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: PorcelainTokens.Space.md) {
                comparisonValue("Current", value: review.currentTarget ?? "Unassigned")
                Image(systemName: "arrow.right")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                comparisonValue("Proposed", value: proposedTarget)
            }
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                comparisonValue("Current", value: review.currentTarget ?? "Unassigned")
                comparisonValue("Proposed", value: proposedTarget)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func comparisonValue(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.porcelainLabel)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var proposedTarget: String {
        switch review.proposal {
        case .expenseProject(let proposal): proposal.target.name
        case .inventoryPlacement(let proposal): proposal.target.name
        }
    }

    private func accept() {
        requestRelationshipAcceptance(
            model: model,
            proposal: review.proposal,
            basisKey: review.basisKey
        ) { acceptance in
            onAccepted(acceptance)
            dismiss()
        }
    }
}

private struct ExpenseProjectProposalView: View {
    let proposal: ExpenseProjectProposal
    let isAccepting: Bool
    let isDisabled: Bool
    let accept: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Label(proposal.target.name, systemImage: "folder")
                .font(.porcelainTitle)
            proposalReasons(proposal.reasons)
            if proposal.sameTradeCount > 0 || proposal.exactProductCount > 0 {
                Text(
                    "\(proposal.sameTradeCount) same-trade · \(proposal.exactProductCount) exact-product"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if !proposal.supportingExpenses.isEmpty {
                Text("Supporting expenses")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(proposal.supportingExpenses) { expense in
                    RelationshipRecordButton(
                        node: .init(
                            reference: .init(entity: .expense, id: expense.id),
                            label: expense.name
                        )
                    )
                }
            }
            if proposal.effectiveStart != nil || proposal.effectiveEnd != nil {
                LabeledContent("Project period", value: projectPeriod)
                    .font(.caption)
            }
            RelationshipAcceptButton(
                title: "Assign to \(proposal.target.name)",
                isAccepting: isAccepting,
                isDisabled: isDisabled,
                action: accept
            )
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
    }

    private var projectPeriod: String {
        switch (proposal.effectiveStart, proposal.effectiveEnd) {
        case (.some(let start), .some(let end)): "\(start) – \(end)"
        case (.some(let start), nil): "From \(start)"
        case (nil, .some(let end)): "Through \(end)"
        case (nil, nil): "Open"
        }
    }
}

private struct InventoryPlacementProposalView: View {
    let proposal: InventoryPlacementProposal
    let isAccepting: Bool
    let isDisabled: Bool
    let accept: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Label(proposal.target.name, systemImage: "location")
                .font(.porcelainTitle)
            proposalReasons(proposal.reasons)
            RelationshipAcceptButton(
                title: "Move to \(proposal.target.name)",
                isAccepting: isAccepting,
                isDisabled: isDisabled,
                action: accept
            )
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
    }
}

private struct ProductRelationshipProposalView: View {
    let proposal: ProductRelatedProposal
    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            open(EntityRef(entity: .product, id: proposal.target.id.rawValue))
        } label: {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                HStack {
                    DomainMark(.product)
                    Text(proposal.target.name)
                        .font(.porcelainTitle)
                    Spacer()
                    Text(proposal.score, format: .number.precision(.fractionLength(2)))
                        .font(.porcelainData)
                        .foregroundStyle(.secondary)
                }
                ForEach(proposal.evidence, id: \.self) { evidence in
                    Text(evidence.detail ?? evidence.signal)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: PorcelainTokens.touchTarget)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the related product")
    }

    private func open(_ reference: EntityRef) {
        if reference.entity.httpActions.contains(.get) {
            appModel.navigator.openRecord(.init(key: reference.entity, id: reference.id))
        } else {
            openURL(appModel.webURL(for: reference.id))
        }
    }
}

private struct RelationshipAcceptButton: View {
    let title: String
    let isAccepting: Bool
    let isDisabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: PorcelainTokens.Space.sm) {
                if isAccepting { ProgressView().accessibilityHidden(true) }
                Text(isAccepting ? "Saving…" : title)
            }
            .frame(minHeight: PorcelainTokens.touchTarget)
        }
        .disabled(isDisabled)
    }
}

private struct RelationshipReadinessLabel: View {
    let status: EmbeddingReadiness

    var body: some View {
        Label(label, systemImage: symbol)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var label: String {
        switch status {
        case .ready: "Ready"
        case .stale: "Refreshing"
        case .uncomputed: "Not analyzed"
        case .unavailable: "Unavailable"
        }
    }

    private var symbol: String {
        switch status {
        case .ready: "checkmark.circle"
        case .stale: "arrow.clockwise.circle"
        case .uncomputed: "clock"
        case .unavailable: "minus.circle"
        }
    }
}

@ViewBuilder
private func proposalReasons(_ reasons: [String]) -> some View {
    ForEach(reasons, id: \.self) { reason in
        Label(reason, systemImage: "sparkle")
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RelationshipBranchList: View {
    let model: EntityRelationshipsModel
    let onInspect: (EntityGraphNode) -> Void
    private var nodesByID: [String: EntityGraphNode] {
        Dictionary(
            (model.graph?.nodes ?? []).map { ($0.reference.stableKey, $0) },
            uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        if model.graph != nil, model.displayedBranches.isEmpty {
            Text("No related records")
                .foregroundStyle(.secondary)
        } else if let graph = model.graph {
            ForEach(model.displayedBranches) { branch in
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { !model.collapsedBranchIDs.contains(branch.id) },
                        set: { expanded in
                            if expanded == model.collapsedBranchIDs.contains(branch.id) {
                                model.toggle(branch)
                            }
                        }
                    )
                ) {
                    ForEach(branch.items) { reference in
                        let node =
                            nodesByID[reference.stableKey]
                            ?? EntityGraphNode(reference: reference, label: reference.id)
                        HStack(spacing: PorcelainTokens.Space.sm) {
                            RelationshipRecordButton(node: node)
                            Button {
                                onInspect(node)
                            } label: {
                                Label("Show connection", systemImage: "info.circle")
                                    .frame(
                                        minWidth: PorcelainTokens.touchTarget,
                                        minHeight: PorcelainTokens.touchTarget
                                    )
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                            .accessibilityHint("Shows paths and graph focus actions")
                        }
                    }
                    if let nextOffset = branch.nextOffset {
                        Button {
                            model.requestNextPage(for: branch)
                        } label: {
                            if model.pagingBranchIDs.contains(branch.id) {
                                LoadingIndicator(label: "Loading more \(branch.label.lowercased())")
                            } else {
                                Label(
                                    "Show more (\(max(0, branch.totalCount - nextOffset)) remaining)",
                                    systemImage: "ellipsis"
                                )
                            }
                        }
                        .disabled(model.pagingBranchIDs.contains(branch.id))
                        .frame(minHeight: PorcelainTokens.touchTarget)
                    }
                    if let error = model.pageErrors[branch.id] {
                        InlineRelationshipError(message: error) {
                            model.requestNextPage(for: branch)
                        }
                    }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                            Text(branch.label)
                            if branch.root != graph.root {
                                Text("From \(nodesByID[branch.root.stableKey]?.label ?? branch.root.id)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Text(branch.totalCount, format: .number)
                            .font(.porcelainData)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

private struct RelationshipRecordButton: View {
    let node: EntityGraphNode
    var onOpen: () -> Void = {}
    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
                DomainMark(node.reference.entity)
                    .padding(.top, PorcelainTokens.Space.xs)
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text(node.label)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(EntityCatalog[node.reference.entity].singular) · \(node.reference.id)")
                        .font(.porcelainCode)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: PorcelainTokens.Space.sm)
                Image(systemName: nativeDestination ? "chevron.right" : "safari")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: PorcelainTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.label), \(EntityCatalog[node.reference.entity].singular)")
        .accessibilityHint(nativeDestination ? "Opens this record" : "Opens this record on the web")
    }

    private var nativeDestination: Bool { node.reference.entity.httpActions.contains(.get) }

    private func open() {
        onOpen()
        if nativeDestination {
            appModel.navigator.openRecord(.init(key: node.reference.entity, id: node.reference.id))
        } else {
            openURL(appModel.webURL(for: node.reference.id))
        }
    }
}

private struct InlineRelationshipError: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(PorcelainTokens.warning)
            Button("Retry", action: retry)
                .frame(minHeight: PorcelainTokens.touchTarget)
        }
    }
}

private struct RelationshipDisplayError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

private struct RelationshipNodeDetailsSheet: View {
    let node: EntityGraphNode
    let model: EntityRelationshipsModel
    @Environment(\.dismiss) private var dismiss

    private var graph: EntityGraph? { model.visibleGraph ?? model.graph }
    private var paths: [EntityGraphPath] { model.paths(to: node.reference) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    RelationshipRecordButton(node: node, onOpen: { dismiss() })
                }
                if paths.count > 1 {
                    Section("Connection") {
                        Picker(
                            "Path",
                            selection: Binding(
                                get: { model.selectedPathIndex },
                                set: model.selectPath
                            )
                        ) {
                            ForEach(paths.indices, id: \.self) { index in
                                Text("Path \(index + 1)").tag(index)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                Section("Path evidence") {
                    if let path = model.selectedPath, let graph {
                        Text(pathDescription(path, graph: graph))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        RelationshipPathSteps(path: path, graph: graph)
                    } else if graph?.root == node.reference {
                        Text("This is the starting record for the current graph.")
                            .foregroundStyle(.secondary)
                    } else {
                        Text("No explanatory path is available in the loaded graph.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button {
                        requestRelationshipFocus(model: model, on: node.reference) { dismiss() }
                    } label: {
                        Label("Focus graph here", systemImage: "scope")
                            .frame(maxWidth: .infinity, minHeight: PorcelainTokens.touchTarget)
                    }
                    .disabled(model.graph?.root == node.reference || model.activity != .idle)
                } footer: {
                    Text("Uses this record as the starting point for the selected depth.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Relationship")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func pathDescription(_ path: EntityGraphPath, graph: EntityGraph) -> String {
        let labels = Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.reference, $0.label) })
        return path.nodeRefs.map { labels[$0] ?? $0.id }.joined(separator: " → ")
    }
}

private struct RelationshipPathSteps: View {
    let path: EntityGraphPath
    let graph: EntityGraph

    var body: some View {
        let labels = Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.reference, $0.label) })
        let edges = Dictionary(uniqueKeysWithValues: graph.edges.map { ($0.id, $0) })
        ForEach(path.edgeIds.indices, id: \.self) { index in
            if let edge = edges[path.edgeIds[index]] {
                let source =
                    path.nodeRefs.indices.contains(index)
                    ? path.nodeRefs[index] : edge.source
                let target =
                    path.nodeRefs.indices.contains(index + 1)
                    ? path.nodeRefs[index + 1] : edge.target
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Label(edge.label, systemImage: "arrow.right")
                        .font(.porcelainLabel)
                    Text("\(labels[source] ?? source.id) → \(labels[target] ?? target.id)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !edge.provenance.isEmpty {
                        Text("Evidence: \(edge.provenance.joined(separator: ", "))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

struct RelationshipGraphNode: View {
    let node: EntityGraphNode
    let isRoot: Bool
    let isSelected: Bool
    let isOnPath: Bool
    var cardWidth: CGFloat = 196
    var cardHeight: CGFloat = 112
    let select: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                HStack {
                    DomainMark(node.reference.entity)
                    Text(EntityCatalog[node.reference.entity].singular)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if isRoot || isSelected {
                        Image(systemName: isRoot ? "record.circle" : "scope")
                            .foregroundStyle(PorcelainTokens.cobalt)
                            .accessibilityHidden(true)
                    }
                }
                Text(node.label)
                    .font(.porcelainTitle)
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(node.reference.id)
                    .font(.porcelainCode)
                    .foregroundStyle(.secondary)
            }
            .padding(PorcelainTokens.Space.md)
            .frame(width: cardWidth, height: cardHeight, alignment: .leading)
            .background(PorcelainTokens.surface)
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                    .strokeBorder(
                        isSelected || isOnPath ? PorcelainTokens.cobalt : PorcelainTokens.hairline,
                        lineWidth: isSelected ? 3 : PorcelainTokens.hairlineWidth
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.label), \(EntityCatalog[node.reference.entity].singular)")
        .accessibilityValue(isRoot ? "Starting record" : isOnPath ? "On selected path" : "")
        .accessibilityHint("Selects this record and highlights its path")
    }
}

#Preview("Relationships") {
    let root = EntityRef(entity: .product, id: "PRD-2345")
    let expense = EntityRef(entity: .expense, id: "EXP-2345")
    let project = EntityRef(entity: .project, id: "PRJ-2345")
    let graph = EntityGraph(
        root: root,
        nodes: [
            EntityGraphNode(reference: root, label: "Cordless drill"),
            EntityGraphNode(reference: expense, label: "Hardware store receipt"),
            EntityGraphNode(reference: project, label: "Workshop shelves"),
        ],
        edges: [
            EntityGraphEdge(
                id: "product-expense", source: root, target: expense, relationshipKey: "expenses",
                label: "Purchased on", sourceKey: "product.expenses", provenance: ["expense.productId"]),
            EntityGraphEdge(
                id: "expense-project", source: expense, target: project, relationshipKey: "project",
                label: "Assigned to", sourceKey: "expense.project", provenance: ["expense.projectId"]),
        ],
        branches: [
            EntityGraphBranch(
                root: root, relationshipKey: "expenses", label: "Expenses", target: .expense,
                totalCount: 1, nextOffset: nil, items: [expense], edgeIds: ["product-expense"])
        ],
        paths: [
            EntityGraphPath(
                nodeRefs: [root, expense, project],
                edgeIds: ["product-expense", "expense-project"])
        ],
        completion: .init(status: .exhausted, requestedDepth: 2, reachedDepth: 2),
        truncated: false
    )
    let recommendations = EntityRecommendationsOut(
        source: .init(root),
        basisKey: "preview",
        groups: [
            .productRelated(
                .init(
                    kind: .productRelated,
                    status: .ready,
                    proposals: [
                        .init(
                            kind: .productRelated,
                            target: .init(id: ProductCode("PRD-3456"), name: "Impact driver"),
                            score: 0.87,
                            evidence: [
                                .init(
                                    signal: "co-occurrence", detail: "Stored and purchased together",
                                    weight: 1)
                            ])
                    ]))
        ]
    )
    let model = EntityRelationshipsModel(
        client: PreviewEntityRelationshipsClient(),
        initialGraph: graph,
        initialRecommendations: recommendations
    )
    return NavigationStack {
        Form { Section("Relationships") { EntityRelationshipsSection(model: model, onAccepted: { _ in }) } }
    }
    .environment(PreviewFixtures.signedInModel())
}

private struct RelationshipPreviewHost: View {
    let model: EntityRelationshipsModel
    var sourceToLoad: EntityRef?

    var body: some View {
        NavigationStack {
            Form {
                Section("Relationships") {
                    EntityRelationshipsSection(model: model, onAccepted: { _ in })
                }
            }
        }
        .environment(PreviewFixtures.signedInModel())
        .task {
            if let sourceToLoad { await model.loadInitial(source: sourceToLoad) }
        }
    }
}

#Preview("Relationships — Loading") {
    let source = EntityRef(entity: .expense, id: "EXP-2345")
    return RelationshipPreviewHost(
        model: EntityRelationshipsModel(client: PreviewEntityRelationshipsClient(mode: .loading)),
        sourceToLoad: source
    )
}

#Preview("Relationships — Empty") {
    let source = EntityRef(entity: .recipe, id: "RCP-2345")
    let graph = EntityGraph(
        root: source,
        nodes: [.init(reference: source, label: "Weeknight soup")],
        edges: [],
        branches: [],
        paths: [],
        completion: .init(status: .exhausted, requestedDepth: 1, reachedDepth: 0),
        truncated: false
    )
    return RelationshipPreviewHost(
        model: EntityRelationshipsModel(
            client: PreviewEntityRelationshipsClient(),
            initialGraph: graph,
            initialRecommendations: .init(source: .init(source), basisKey: "empty-preview", groups: [])
        )
    )
}

#Preview("Relationships — Partial") {
    let source = EntityRef(entity: .product, id: "PRD-2345")
    let related = EntityRef(entity: .product, id: "PRD-3456")
    let graph = EntityGraph(
        root: source,
        nodes: [
            .init(reference: source, label: "Cordless drill"),
            .init(reference: related, label: "Impact driver"),
        ],
        edges: [
            .init(
                id: "related-product",
                source: source,
                target: related,
                relationshipKey: "relatedProducts",
                label: "Often used with",
                sourceKey: "product.relatedProducts",
                provenance: ["shared tags"]
            )
        ],
        branches: [
            .init(
                root: source,
                relationshipKey: "relatedProducts",
                label: "Related products",
                target: .product,
                totalCount: 8,
                nextOffset: 1,
                items: [related],
                edgeIds: ["related-product"]
            )
        ],
        paths: [
            .init(nodeRefs: [source, related], edgeIds: ["related-product"])
        ],
        completion: .init(status: .paginationLimit, requestedDepth: 2, reachedDepth: 1),
        truncated: true
    )
    let recommendations = EntityRecommendationsOut(
        source: .init(source),
        basisKey: "partial-preview",
        groups: [
            .productRelated(
                .init(
                    kind: .productRelated,
                    status: .unavailable,
                    proposals: [
                        .init(
                            kind: .productRelated,
                            target: .init(id: ProductCode(related.id), name: "Impact driver"),
                            score: 0.82,
                            evidence: [
                                .init(signal: "shared tags", detail: "Workshop tools", weight: 0.7)
                            ]
                        )
                    ]
                )
            )
        ]
    )
    return RelationshipPreviewHost(
        model: EntityRelationshipsModel(
            client: PreviewEntityRelationshipsClient(),
            initialGraph: graph,
            initialRecommendations: recommendations
        )
    )
}

#Preview("Relationships — Error") {
    let source = EntityRef(entity: .inventory, id: "INV-2345")
    return RelationshipPreviewHost(
        model: EntityRelationshipsModel(client: PreviewEntityRelationshipsClient()),
        sourceToLoad: source
    )
}

private actor PreviewEntityRelationshipsClient: EntityRelationshipsClient {
    enum Mode: Sendable, Equatable { case error, loading }
    let mode: Mode

    init(mode: Mode = .error) { self.mode = mode }

    func exploreRelationships(root: EntityRef, depth: Int) async throws -> EntityGraph {
        try await waitOrThrow()
    }
    func relationshipPage(
        root: EntityRef, relationshipKey: String, offset: Int, limit: Int
    ) throws -> EntityGraphOutput { throw URLError(.resourceUnavailable) }
    func recommendations(for source: EntityRef) async throws -> EntityRecommendationsOut {
        try await waitOrThrow()
    }
    func assignExpense(_ expenseID: String, toProject projectID: String) throws {}
    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityRef {
        EntityRef(entity: .inventory, id: inventoryID)
    }

    private func waitOrThrow<T>() async throws -> T {
        if mode == .loading {
            try await Task.sleep(for: .seconds(3_600))
        }
        throw URLError(.resourceUnavailable)
    }
}
