import CubbyKit
import SwiftUI
import UniformTypeIdentifiers

struct StatementCsvImportView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var choosingFile = false
    @State private var session = StatementCsvReviewSession()
    @State private var error: String?
    @State private var busy = false
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

    private var fileName: String { session.input?.fileName ?? "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xxl) {
                if let result = session.result {
                    completion(result)
                } else {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                        Text("Import statement").font(.fieldGuideHeadline)
                        Text("Review your CSV before recording transactions.")
                            .foregroundStyle(.secondary)
                    }
                    fileSummary
                    if let preview = session.preview {
                        if preview.needsMapping {
                            mappingSection(preview.headers)
                        } else {
                            reviewSection(preview)
                        }
                    } else {
                        Text("Nothing is created until you confirm your choices.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                if busy { ProgressView("Processing statement…") }
                if let error {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                        Label("Needs attention", systemImage: "exclamationmark.triangle")
                            .font(.fieldGuideTitle)
                        Text(error).textSelection(.enabled)
                    }
                    .foregroundStyle(FieldGuideTokens.destructive)
                }
            }
            .frame(maxWidth: FieldGuideTokens.readingWidth, alignment: .leading)
            .padding(FieldGuideTokens.Space.xxl)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(FieldGuideTokens.canvas)
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

    private var fileSummary: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            if !fileName.isEmpty {
                Label {
                    Text(fileName).font(.fieldGuideTitle).textSelection(.enabled)
                } icon: {
                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                }
            }
            Button(fileName.isEmpty ? "Choose CSV file" : "Choose another CSV", systemImage: "doc.badge.plus")
            {
                choosingFile = true
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            .accessibilityIdentifier("statement.csv.chooseFile")
        }
    }

    private func completion(_ value: StatementCsvCommitOut) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
            Label("Statement saved", systemImage: "checkmark.circle.fill")
                .font(.fieldGuideHeadline)
                .foregroundStyle(FieldGuideTokens.positive)
            Text(fileName).font(.fieldGuideTitle).textSelection(.enabled)
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                LabeledContent("Source rows saved", value: "\(value.evidence)")
                LabeledContent("Transactions recorded", value: "\(value.transactions)")
                if value.attached > 0 {
                    LabeledContent("Attached to existing transactions", value: "\(value.attached)")
                }
                if value.alreadyPresent > 0 {
                    LabeledContent("Source rows already present", value: "\(value.alreadyPresent)")
                }
            }
            .font(.callout.monospacedDigit())
            Text("Your source rows are available as evidence.")
                .foregroundStyle(.secondary)
            Button("Import another statement", systemImage: "doc.badge.plus") { choosingFile = true }
                .buttonStyle(.bordered)
                .disabled(busy)
                .accessibilityIdentifier("statement.csv.chooseFile")
        }
    }

    private func mappingSection(_ headers: [String]) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
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
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        busy || dateColumn.isEmpty || amountColumn.isEmpty || descriptionColumn.isEmpty
                            || (account.isEmpty && accountColumn.isEmpty))
            }
            .textFieldStyle(.roundedBorder)
            .padding(FieldGuideTokens.Space.sm)
        } label: {
            Text("Map CSV columns").font(.fieldGuideTitle)
        }
    }

    private func columnPicker(_ title: String, selection: Binding<String>, headers: [String]) -> some View {
        Picker(title, selection: selection) {
            Text("None").tag("")
            ForEach(headers, id: \.self) { header in Text(header).tag(header) }
        }
        .pickerStyle(.menu)
    }

    private func reviewSection(_ value: StatementCsvPreviewOut) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text("Review statement").font(.fieldGuideHeadline)
                Text("Choose transactions to record or attach. Unselected rows remain source evidence.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    LabeledContent("Source", value: value.source ?? "CSV")
                    LabeledContent("Source rows", value: "\(value.totalRows)")
                    if value.pendingRows > 0 {
                        LabeledContent("Pending rows", value: "\(value.pendingRows)")
                    }
                    if value.zeroValueRows > 0 {
                        LabeledContent("Zero-value rows", value: "\(value.zeroValueRows)")
                    }
                }
                .font(.callout.monospacedDigit())
                .padding(FieldGuideTokens.Space.sm)
            }
            LazyVStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                ForEach(session.reviewRows, id: \.key) { row in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                        transactionHeading {
                            Text(row.proposed.merchant ?? row.proposed.rawDescription ?? "Statement row")
                                .font(.fieldGuideTitle)
                                .fixedSize(horizontal: false, vertical: true)
                            if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                            Text(row.proposed.amount, format: .usd)
                                .font(.fieldGuideData)
                                .fixedSize()
                        }
                        Text(
                            "\(row.proposed.postedDate.rawValue) · \(row.accountName ?? "Account unresolved")"
                        )
                        .font(.caption).foregroundStyle(.secondary)
                        Text(row.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption)
                            .foregroundStyle(
                                row.status == .readyToCreate
                                    ? FieldGuideTokens.positive : FieldGuideTokens.warning)
                        if row.status == .possibleExisting {
                            Toggle(
                                "Attach source to existing transaction",
                                isOn: Binding(
                                    get: { session.selected.contains(row.key) },
                                    set: { enabled in
                                        if enabled {
                                            session.selected.insert(row.key)
                                        } else {
                                            session.selected.remove(row.key)
                                            session.attachments.removeValue(forKey: row.key)
                                        }
                                    }
                                )
                            )
                            .accessibilityIdentifier("statement.csv.attach.\(row.key)")
                            if session.selected.contains(row.key) {
                                Picker(
                                    "Existing transaction",
                                    selection: Binding(
                                        get: { session.attachments[row.key] ?? "" },
                                        set: { session.attachments[row.key] = $0 }
                                    )
                                ) {
                                    Text("Choose transaction").tag("")
                                    ForEach(row.existingTransactionIds, id: \.self) { id in
                                        Text(id).tag(id)
                                    }
                                }
                                Text(
                                    "Keeps the existing transaction's amount, date, and status. This source row remains available as evidence."
                                )
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if row.status == .readyToCreate {
                            Toggle(
                                "Record transaction",
                                isOn: Binding(
                                    get: { session.selected.contains(row.key) },
                                    set: { enabled in
                                        if enabled {
                                            session.selected.insert(row.key)
                                            session.kinds[row.key] = row.proposed.kind
                                        } else {
                                            session.selected.remove(row.key)
                                        }
                                    }
                                )
                            )
                            .accessibilityIdentifier("statement.csv.select.\(row.key)")
                            if session.selected.contains(row.key) {
                                Picker(
                                    "Kind",
                                    selection: Binding(
                                        get: { session.kinds[row.key] ?? row.proposed.kind },
                                        set: { session.kinds[row.key] = $0 }
                                    )
                                ) {
                                    ForEach(FinancialTransactionKind.allCases, id: \.self) { kind in
                                        Text(
                                            kind.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
                                        )
                                        .tag(kind)
                                    }
                                }
                            }
                        }
                    }
                    .padding(FieldGuideTokens.Space.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        FieldGuideTokens.surface,
                        in: RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                            .strokeBorder(
                                FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                    }
                }
            }
            if value.hasMore {
                Button("Review next rows") { Task { await loadMore() } }
                    .disabled(busy)
            }
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(
                    "\(session.selected.count) decisions selected · \(session.reviewRows.count) candidates reviewed"
                )
                .font(.fieldGuideTitle)
                Button("Confirm \(session.selected.count) decisions and save source rows") {
                    Task { await commit() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || session.hasUnresolvedAttachment)
                .accessibilityIdentifier("statement.csv.confirm")
                Text("All source rows are saved, including rows you leave unselected.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func transactionHeading<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        let layout =
            dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: FieldGuideTokens.Space.sm))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.md))
        return layout { content() }
    }

    private func fileInput() -> StatementCsvFileInput {
        var input = session.input ?? StatementCsvFileInput(fileName: "", text: "")
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
        session.replaceInput(nil)
        usesMapping = false
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let input = try StatementCsvReviewSession.fileInput(
                fileName: url.lastPathComponent, contents: data)
            session.replaceInput(input)
            let value = try await session.prepare(using: appModel.client)
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
            _ = try await session.prepare(fileInput(), using: appModel.client)
        } catch {
            Diagnostics.report(error, context: "Map statement CSV")
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            try await session.loadMore(using: appModel.client)
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
            try await session.commit(using: appModel.client)
        } catch {
            Diagnostics.report(error, context: "Save statement CSV")
            self.error = error.localizedDescription
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { StatementCsvImportView() }
}
