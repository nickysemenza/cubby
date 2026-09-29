import Foundation

extension CubbyClient {
    /// Standard native lists opt into core rows; `list` remains the complete CLI/specialist path.
    public func progressiveList(
        _ descriptor: EntityDescriptor,
        page: Int = 1, pageSize: Int = 50, sort: String? = nil,
        filters: EntityFilterState = EntityFilterState()
    ) async throws -> ListPage<EntityRow> {
        guard descriptor.key.nativeReadKind == .resource else {
            return try await list(descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
        }
        let input = try descriptor.progressiveListInput(
            page: page, pageSize: pageSize, sort: sort, filters: filters)
        let response = try JSONValue(encoding: try await entityListBase(input))
        guard let wireMeta = response["meta"] else {
            throw EntityOperationError.unsupported(descriptor.key, .list)
        }
        var meta: ListPageMeta = try wireMeta.decoded()
        // Resource native models use 1-based pages; structured operations are 0-based.
        meta.pageIndex += 1
        let groups = (response["groups"]?.arrayValue ?? []).compactMap { group -> EntityListDeferred.Group? in
            guard let id = group["id"]?.stringValue else { return nil }
            let fields = group["fields"]?.arrayValue?.compactMap(\.stringValue) ?? []
            return .init(id: id, fields: fields)
        }
        let visible = Self.visibleListFields(descriptor)
        let requested = groups.filter { !visible.isDisjoint(with: $0.fields) }
        let deferred = EntityListDeferred(
            groups: requested,
            enrich: { [self] ids, groups in
                let request: JSONValue = [
                    "entity": .string(descriptor.key.rawValue),
                    "ids": .array(ids.map(JSONValue.string)),
                    "groups": .array(groups.map(JSONValue.string)),
                ]
                let response = try JSONValue(
                    encoding: try await entityListEnrichment(try request.decoded()))
                return (response["groups"]?.arrayValue ?? []).compactMap { group in
                    guard let id = group["id"]?.stringValue else { return nil }
                    if group["state"]?.stringValue == "ready" {
                        return .ready(id: id, rows: group["data"]?.arrayValue ?? [])
                    }
                    let code = group["error"]?["code"]?.stringValue ?? "ENRICHMENT_FAILED"
                    let message = group["error"]?["message"]?.stringValue ?? "Missing enrichment error"
                    let diagnostics = group["error"]?["diagnostics"].flatMap { value -> String? in
                        guard let data = try? JSONEncoder.cubby().encode(value) else { return nil }
                        return String(data: data, encoding: .utf8)
                    }
                    return .failed(
                        id: id,
                        message: "\(code): \(message)" + (diagnostics.map { "\n\($0)" } ?? ""))
                }
            },
            summary: { [self] in
                guard !descriptor.presentation.listTotals.isEmpty else { return nil }
                let response = try JSONValue(
                    encoding: try await entityListSummary(try JSONValue(encoding: input).decoded()))
                return response["sums"]?.objectValue?.compactMapValues(\.doubleValue)
            })
        return ListPage(
            items: response["data"]?.arrayValue?.compactMap(descriptor.row(from:)) ?? [],
            meta: meta,
            deferred: deferred)
    }

    private nonisolated static func visibleListFields(_ descriptor: EntityDescriptor) -> Set<String> {
        var fields = Set(descriptor.presentation.shelfSubtitle + [descriptor.titleField, "displayImages"])
        for field in descriptor.fields
        where (field.showInList && !field.listHidden) || field.mobileSlot != nil {
            fields.insert(field.key)
            if field.reference != nil, field.key.hasSuffix("Id") {
                let stem = String(field.key.dropLast(2))
                fields.insert(stem)
                fields.insert("\(stem)Name")
            }
        }
        return fields
    }
}
