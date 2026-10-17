/// Preserve citation order while consolidating repeated citations of one document. A document
/// is a record, an external page, or a record cited with a page; each page of one record is its
/// own group so every URL renders (the web Sources section keys groups the same way). A citation
/// with neither stands alone.
public func groupedSources<Source>(
    _ sources: [Source], record: (Source) -> String?, url: (Source) -> String?
) -> [[Source]] {
    var indices: [String: Int] = [:]
    var groups: [[Source]] = []
    for source in sources {
        let record = record(source)
        let url = url(source)
        let key: String? =
            switch (record, url) {
            case (let record?, let url?): "\(record)|\(url)"
            case (let record?, nil): record
            case (nil, let url?): url
            case (nil, nil): nil
            }
        guard let key else {
            groups.append([source])
            continue
        }
        if let index = indices[key] {
            groups[index].append(source)
        } else {
            indices[key] = groups.count
            groups.append([source])
        }
    }
    return groups
}
