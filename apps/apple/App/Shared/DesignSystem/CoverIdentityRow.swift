import SwiftUI

/// A cover, a wrapping name, and an optional shortcode. The code stays one token and moves
/// under the name at accessibility sizes. The subtitle and anything after the code (a checkmark,
/// a chevron, a count) stay with the caller.
struct CoverIdentityRow<Subtitle: View, Trailing: View>: View {
    let title: String
    var titleFont: Font = .fieldGuideBody
    var titleColor: Color = FieldGuideTokens.graphite
    /// `nil` lets the name grow at every text size. A number caps it until accessibility sizes.
    var titleLineLimit: Int? = 2
    var imageURL: URL?
    var symbol: String
    var thumbnailSize: CGFloat = 40
    var code: String?
    var minHeight: CGFloat = FieldGuideTokens.touchTarget
    private let subtitle: Subtitle
    private let trailing: Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        title: String,
        titleFont: Font = .fieldGuideBody,
        titleColor: Color = FieldGuideTokens.graphite,
        titleLineLimit: Int? = 2,
        imageURL: URL?,
        symbol: String,
        thumbnailSize: CGFloat = 40,
        code: String? = nil,
        minHeight: CGFloat = FieldGuideTokens.touchTarget,
        @ViewBuilder subtitle: () -> Subtitle,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.titleFont = titleFont
        self.titleColor = titleColor
        self.titleLineLimit = titleLineLimit
        self.imageURL = imageURL
        self.symbol = symbol
        self.thumbnailSize = thumbnailSize
        self.code = code
        self.minHeight = minHeight
        self.subtitle = subtitle()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.md) {
            Thumb(url: imageURL, size: thumbnailSize, symbol: symbol)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(titleFont)
                    .foregroundStyle(titleColor)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : titleLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                subtitle
                if dynamicTypeSize.isAccessibilitySize, let code {
                    codeText(code)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: FieldGuideTokens.Space.sm)
            if !dynamicTypeSize.isAccessibilitySize, let code {
                codeText(code)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            trailing
        }
        .frame(minHeight: minHeight)
        .contentShape(Rectangle())
    }

    private func codeText(_ code: String) -> some View {
        Text(code)
            .font(.fieldGuideCode)
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
    }
}

extension CoverIdentityRow where Subtitle == EmptyView, Trailing == EmptyView {
    init(
        title: String,
        titleFont: Font = .fieldGuideBody,
        titleColor: Color = FieldGuideTokens.graphite,
        titleLineLimit: Int? = 2,
        imageURL: URL?,
        symbol: String,
        thumbnailSize: CGFloat = 40,
        code: String? = nil,
        minHeight: CGFloat = FieldGuideTokens.touchTarget
    ) {
        self.init(
            title: title, titleFont: titleFont, titleColor: titleColor, titleLineLimit: titleLineLimit,
            imageURL: imageURL, symbol: symbol, thumbnailSize: thumbnailSize, code: code,
            minHeight: minHeight
        ) {
            EmptyView()
        } trailing: {
            EmptyView()
        }
    }
}

#Preview("Cover identity") {
    List {
        CoverIdentityRow(
            title: "1/4\" hex bits", imageURL: nil, symbol: "mappin",
            code: "LOC-2Q4Q"
        ) {
            Text("PACKOUT stack")
                .font(.fieldGuideLabel)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
        } trailing: {
            Image(systemName: "checkmark")
                .font(.caption.weight(.semibold))
                .foregroundStyle(FieldGuideTokens.interaction)
        }
    }
    .listStyle(.plain)
}
