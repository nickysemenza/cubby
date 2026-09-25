import CubbyKit
import SwiftUI
import UniformTypeIdentifiers

struct StatementCsvImportView: View {
    @Environment(AppModel.self) private var appModel
    @State private var choosingFile = false
    @State private var fileName = ""
    @State private var fileText = ""
    @State private var preview: StatementCsvPreviewOut?
    @State private var reviewRows: [FinancialStatementImportPreviewRow] = []
    @State private var result: StatementCsvCommitOut?
    @State private var error: String?
    @State private var busy = false
    @State private var selected = Set<String>()
    @State private var kinds: [String: FinancialTransactionKind] = [:]
    @State private var usesMapping = false

    @State private var source = "bank-csv"
    @State private var account = ""
    @State private var accountColumn = ""
    @State private var dateColumn = ""
    @State private var amountColumn = ""
    @State private var descriptionColumn = ""
    @State private var merchantColumn = ""
    @State private var categoryColumn = ""
    @State private var notesColumn = ""
    @State private var directionColumn = ""
    @State private var statusColumn = ""
    @State private var chargeValue = "debit"
    @State private var creditValue = "credit"
    @State private var pendingValue = "pending"
    @State private var sign = StatementCsvColumnMapping.SignPayload.chargesNegative

    var body: some View {
        Form {
            Section {
                Button("Choose CSV file", systemImage: "doc.badge.plus") { choosingFile = true }
                    .disabled(busy)
                if !fileName.isEmpty {
                    LabeledContent("File", value: fileName)
                }
                if busy { ProgressView("Checking statement…") }
            } footer: {
                Text(
                    "Preview the source rows, then choose which charges to record as transactions. Nothing is created until you confirm."
                )
            }

            if let preview {
                if preview.needsMapping { mappingSection(preview.headers) } else { reviewSection(preview) }
            }
            if let result {
                Section("Saved") {
                    Label(
                        "\(result.evidence) source rows · \(result.transactions) transactions",
                        systemImage: "checkmark.circle.fill"
                    )
                    .foregroundStyle(PorcelainTokens.positive)
                    if result.alreadyPresent > 0 {
                        Text("\(result.alreadyPresent) source rows were already present.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if let error {
                Section("Needs attention") {
                    Text(error).foregroundStyle(PorcelainTokens.destructive)
                }
            }
        }
        .navigationTitle("Import statement")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .fileImporter(
            isPresented: $choosingFile,
            allowedContentTypes: [.commaSeparatedText, .plainText],
            allowsMultipleSelection: false
        ) { outcome in
            switch outcome {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task { await open(url) }
            case .failure(let cause):
                Diagnostics.report(cause, context: "Choose statement CSV")
                error = cause.localizedDescription
            }
        }
    }

    private func mappingSection(_ headers: [String]) -> some View {
        Section("Map CSV columns") {
            Text("These columns are unfamiliar. Check the amount direction and account before saving.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Source key", text: $source)
                .autocorrectionDisabled()
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                #endif
            TextField("Account name when file has no account column", text: $account)
            columnPicker("Account column", selection: $accountColumn, headers: headers)
            columnPicker("Date", selection: $dateColumn, headers: headers)
            columnPicker("Amount", selection: $amountColumn, headers: headers)
            columnPicker("Description", selection: $descriptionColumn, headers: headers)
            columnPicker("Merchant", selection: $merchantColumn, headers: headers)
            columnPicker("Category", selection: $categoryColumn, headers: headers)
            columnPicker("Notes", selection: $notesColumn, headers: headers)
            columnPicker("Direction", selection: $directionColumn, headers: headers)
            columnPicker("Status", selection: $statusColumn, headers: headers)
            Picker("Amount signs", selection: $sign) {
                Text("Charges are negative").tag(StatementCsvColumnMapping.SignPayload.chargesNegative)
                Text("Charges are positive").tag(StatementCsvColumnMapping.SignPayload.chargesPositive)
                Text("Use direction column").tag(StatementCsvColumnMapping.SignPayload.directionColumn)
            }
            if sign == .directionColumn {
                TextField("Charge value", text: $chargeValue)
                TextField("Credit value", text: $creditValue)
            }
            if !statusColumn.isEmpty { TextField("Pending value", text: $pendingValue) }
            Button("Preview mapped rows") { Task { await prepare() } }
                .disabled(
                    busy || dateColumn.isEmpty || amountColumn.isEmpty || descriptionColumn.isEmpty
                        || (account.isEmpty && accountColumn.isEmpty))
        }
    }

    private func columnPicker(_ title: String, selection: Binding<String>, headers: [String]) -> some View {
        Picker(title, selection: selection) {
            Text("None").tag("")
            ForEach(headers, id: \.self) { header in Text(header).tag(header) }
        }
    }

    private func reviewSection(_ value: StatementCsvPreviewOut) -> some View {
        Section {
            LabeledContent("Source", value: value.source ?? "CSV")
            LabeledContent("Rows", value: "\(value.totalRows)")
            if value.pendingRows > 0 {
                LabeledContent("Pending rows", value: "\(value.pendingRows)")
            }
            if value.zeroValueRows > 0 {
                LabeledContent("Zero-value rows", value: "\(value.zeroValueRows)")
            }
            ForEach(reviewRows, id: \.key) { row in
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(row.proposed.merchant ?? row.proposed.rawDescription ?? "Statement row")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                        Text(row.proposed.amount, format: .currency(code: "USD"))
                            .font(.subheadline.monospacedDigit())
                    }
                    Text("\(row.proposed.postedDate.rawValue) · \(row.accountName ?? "Account unresolved")")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(row.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption)
                        .foregroundStyle(
                            row.status == .readyToCreate ? PorcelainTokens.positive : PorcelainTokens.warning)
                    if row.status == .readyToCreate {
                        Toggle(
                            "Record transaction",
                            isOn: Binding(
                                get: { selected.contains(row.key) },
                                set: { enabled in
                                    if enabled {
                                        selected.insert(row.key)
                                        kinds[row.key] = row.proposed.kind
                                    } else {
                                        selected.remove(row.key)
                                    }
                                }
                            ))
                        if selected.contains(row.key) {
                            Picker(
                                "Kind",
                                selection: Binding(
                                    get: { kinds[row.key] ?? row.proposed.kind },
                                    set: { kinds[row.key] = $0 }
                                )
                            ) {
                                ForEach(FinancialTransactionKind.allCases, id: \.self) { kind in
                                    Text(kind.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .tag(kind)
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, PorcelainTokens.Space.xs)
            }
            if value.hasMore {
                Button("Review next rows") { Task { await loadMore() } }
                    .disabled(busy)
            }
            Button("Confirm \(selected.count) transactions and save source rows") {
                Task { await commit() }
            }
            .disabled(busy)
        } header: {
            Text("Review statement")
        } footer: {
            Text(
                "\(reviewRows.count) transaction candidates reviewed. Unselected rows remain as source evidence; all source rows are saved in bounded batches."
            )
        }
    }

    private func fileInput() -> StatementCsvFileInput {
        var input = StatementCsvFileInput(fileName: fileName, text: fileText)
        if usesMapping {
            input.mapping = .init(
                source: source, account: account, accountColumn: accountColumn,
                date: dateColumn, amount: amountColumn, description: descriptionColumn,
                merchant: merchantColumn, category: categoryColumn, notes: notesColumn,
                direction: directionColumn, status: statusColumn, pendingValue: pendingValue,
                chargeValue: chargeValue, creditValue: creditValue, sign: sign)
        }
        return input
    }

    private func open(_ url: URL) async {
        busy = true
        defer { busy = false }
        error = nil
        result = nil
        preview = nil
        reviewRows = []
        usesMapping = false
        selected = []
        kinds = [:]
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 5_000_000, let text = String(data: data, encoding: .utf8) else {
                throw StatementFileError.invalidFile
            }
            fileName = url.lastPathComponent
            fileText = text
            let value = try await appModel.client.previewStatementCsv(
                .init(fileName: fileName, text: fileText))
            preview = value
            reviewRows = value.preview?.rows ?? []
            if value.needsMapping {
                usesMapping = true
                dateColumn = value.headers.first(where: { $0.localizedCaseInsensitiveContains("date") }) ?? ""
                amountColumn =
                    value.headers.first(where: { $0.localizedCaseInsensitiveContains("amount") }) ?? ""
                descriptionColumn =
                    value.headers.first(where: {
                        $0.localizedCaseInsensitiveContains("description")
                            || $0.localizedCaseInsensitiveContains("merchant")
                    }) ?? ""
                accountColumn =
                    value.headers.first(where: { $0.localizedCaseInsensitiveContains("account") }) ?? ""
            }
        } catch {
            Diagnostics.report(error, context: "Preview statement CSV")
            self.error = error.localizedDescription
        }
    }

    private func prepare() async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            let value = try await appModel.client.previewStatementCsv(fileInput())
            preview = value
            reviewRows = value.preview?.rows ?? []
        } catch {
            Diagnostics.report(error, context: "Map statement CSV")
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let preview, preview.hasMore else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            var input = fileInput()
            input.previewOffset = preview.previewOffset + (preview.preview?.rows.count ?? 0)
            let next = try await appModel.client.previewStatementCsv(input)
            reviewRows.append(contentsOf: next.preview?.rows ?? [])
            self.preview = next
        } catch {
            Diagnostics.report(error, context: "Review more statement rows")
            self.error = error.localizedDescription
        }
    }

    private func commit() async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            let file = fileInput()
            let choices: StatementCsvCommitInput.SelectedPayload = selected.sorted().compactMap { key in
                guard let kind = kinds[key] else { return nil }
                return .init(key: key, kind: kind)
            }
            var input = StatementCsvCommitInput(fileName: file.fileName, text: file.text, selected: choices)
            input.mapping = file.mapping
            result = try await appModel.client.commitStatementCsv(input)
            selected = []
            let value = try await appModel.client.previewStatementCsv(file)
            preview = value
            reviewRows = value.preview?.rows ?? []
        } catch {
            Diagnostics.report(error, context: "Save statement CSV")
            self.error = error.localizedDescription
        }
    }
}

private enum StatementFileError: LocalizedError {
    case invalidFile
    var errorDescription: String? { "Choose a UTF-8 CSV smaller than 5 MB." }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { StatementCsvImportView() }
}
