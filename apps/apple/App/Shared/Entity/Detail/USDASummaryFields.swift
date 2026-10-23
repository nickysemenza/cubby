import CubbyKit
import SwiftUI

/// External USDA JSON has no scalar detail projection. Preserve its supplied names, units and
/// values; never reconstruct nutrition from nutrient codes or convert serving amounts here.
struct USDASummaryFields: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    let keys: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ForEach(keys, id: \.self) { key in
                if let field = descriptor.field(key), let value = row.raw[key], value != .null {
                    switch key {
                    case "foodInfo":
                        text("Description", value["description"])
                        text("Data type", value["data_type"])
                    case "nutritionInfo":
                        let nutrients = value["nutrientSummary"]?.arrayValue ?? []
                        ForEach(Array(nutrients.prefix(4).enumerated()), id: \.offset) { _, nutrient in
                            if let name = nutrient["name"]?.stringValue,
                                let amount = nutrient["amount"]?.doubleValue,
                                let unit = nutrient["unit"]?.stringValue
                            {
                                LabeledContent(name, value: ValueFormat.amount(unit: unit, value: amount))
                            } else {
                                Text("Unsupported USDA nutrient value").font(.caption)
                            }
                        }
                        if nutrients.isEmpty {
                            Text("Nutrient summary unavailable").foregroundStyle(.secondary)
                        }
                        if nutrients.count > 4 {
                            DisclosureGroup("All \(nutrients.count) nutrients") {
                                RawRecordDisclosure(raw: value)
                            }
                        }
                    case "portionInfoRaw":
                        let portions = value.arrayValue ?? []
                        ForEach(Array(portions.prefix(3).enumerated()), id: \.offset) { _, portion in
                            if let grams = portion["gram_weight"]?.doubleValue,
                                let amount = portion["amount"]?.doubleValue
                            {
                                LabeledContent(
                                    "\(ValueFormat.number(amount)) \(portion["modifier"]?.stringValue ?? "portion")",
                                    value: ValueFormat.amount(unit: "g", value: grams))
                            } else {
                                Text("Unsupported USDA portion value").font(.caption)
                            }
                        }
                        if portions.count > 3 {
                            DisclosureGroup("All \(portions.count) portions") {
                                RawRecordDisclosure(raw: value)
                            }
                        }
                    case "brandedFoodInfo":
                        text("Brand", value["brand_name"])
                        text("Brand owner", value["brand_owner"])
                        text("Barcode", value["gtin_upc"])
                        DisclosureGroup("Brand information") { RawRecordDisclosure(raw: value) }
                    case "legacyFoodInfo":
                        text("NDB number", value["ndb_number"])
                    default:
                        FieldsSectionView(descriptor: descriptor, row: row, keys: [field.key], summary: true)
                    }
                }
            }
        }
        .font(.caption)
    }

    @ViewBuilder private func text(_ label: String, _ value: JSONValue?) -> some View {
        if let text = value?.stringValue, !text.isEmpty {
            LabeledContent(label, value: text)
        } else if let number = value?.doubleValue {
            LabeledContent(label, value: ValueFormat.number(number))
        }
    }
}

#Preview("USDA summary") {
    USDASummaryFields(
        descriptor: EntityCatalog[.usdaFood],
        row: EntityRow(
            id: "123456", title: "Example food", subtitle: nil, imageURL: nil,
            raw: .object([
                "foodInfo": .object([
                    "description": .string("Example food"), "data_type": .string("foundation_food"),
                ])
            ])),
        keys: ["foodInfo"]
    )
    .padding(FieldGuideTokens.Space.md)
    .environment(PreviewFixtures.signedInModel())
}
