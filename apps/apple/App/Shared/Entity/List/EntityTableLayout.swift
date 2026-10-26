import CubbyKit
import SwiftUI

/// Mac `Table` column geometry for a field's declared `display.width` bucket, the same buckets
/// web sizes its table columns from. The title column takes `lg`; an undeclared or unknown bucket
/// takes `md`, as on web.
struct EntityTableColumnWidth: Equatable {
    let min: CGFloat
    let ideal: CGFloat
    let max: CGFloat

    init(bucket: String?) {
        switch bucket {
        case "xs": (min, ideal, max) = (48, 64, 88)
        case "sm": (min, ideal, max) = (80, 104, 140)
        case "lg": (min, ideal, max) = (180, 240, 400)
        case "xl": (min, ideal, max) = (240, 320, 600)
        default: (min, ideal, max) = (120, 160, 240)
        }
    }

    init(_ field: FieldDescriptor) {
        self.init(bucket: field.width)
    }

    static let title = Self(bucket: "lg")
}

extension TableColumn {
    func width(_ width: EntityTableColumnWidth) -> TableColumn {
        self.width(min: width.min, ideal: width.ideal, max: width.max)
    }
}

/// Mac table rows are single-line and about 20 points, like Finder's list view. The system cell
/// adds 4 points above and below its content and holds rows to `rowHeight` at least, so a
/// 12-point content frame lands every row at 20 points; a 16-point thumbnail or a chip overflows
/// into that padding instead of growing the row.
enum EntityTableLayout {
    static let rowHeight: CGFloat = 20
    static let cellContentHeight: CGFloat = 12
    static let thumbnailSize: CGFloat = 16
}

extension View {
    /// One Mac table cell: one line, leading, inside the 20-point row.
    func entityTableCell() -> some View {
        lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: EntityTableLayout.cellContentHeight, alignment: .leading)
    }
}

/// The Mac table's title cell: the record image (else its emoji or glyph) at 16 points, then
/// the title and the declared `titleSubtitle` on one line in the body type scale every cell uses.
struct EntityTableTitleCell: View {
    let title: String
    let subtitle: String?
    let imageURL: URL?
    let symbol: String
    let emoji: String?

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            Thumb(url: imageURL, size: EntityTableLayout.thumbnailSize, symbol: symbol, emoji: emoji)
            Text(title)
                .fontWeight(.medium)
                .layoutPriority(1)
            if let subtitle {
                Text(subtitle).foregroundStyle(.secondary)
            }
        }
        .font(.body)
        .lineLimit(1)
        .truncationMode(.tail)
    }
}
