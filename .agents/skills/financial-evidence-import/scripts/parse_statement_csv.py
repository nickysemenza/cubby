#!/usr/bin/env python3
"""Parse legacy exports locally into finance.record request batches."""

import argparse
import csv
import hashlib
import io
import json
import math
import re
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path


HEADERS = {
    "monarch": {"Date", "Merchant", "Account", "Original Statement", "Amount"},
    "mint": {
        "Date", "Description", "Original Description", "Amount",
        "Transaction Type", "Account Name",
    },
    "copilot": {"date", "name", "amount", "status", "type", "account"},
    "apple-card": {
        "Transaction Date", "Description", "Merchant", "Type", "Amount (USD)",
    },
}


def plain_date(value):
    value = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return date.fromisoformat(value).isoformat()
    if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{4}", value):
        month, day, year = map(int, value.split("/"))
        return date(year, month, day).isoformat()
    raise ValueError("unsupported date format")


def amount(value):
    value = value.strip()
    normalized = re.sub(r"[$,()\s]", "", value)
    if not value or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", normalized):
        raise ValueError("invalid amount")
    parsed = Decimal(normalized)
    if value.startswith("(") and value.endswith(")"):
        parsed = -abs(parsed)
    if not parsed.is_finite() or not math.isfinite(float(parsed)):
        raise ValueError("non-finite amount")
    return parsed


def optional(record, key):
    return record.get(key, "").strip() or None


def normalize(source, record, position, fingerprint, args):
    if source == "monarch":
        day, signed, account = record["Date"], amount(record["Amount"]), record["Account"]
        merchant = optional(record, "Merchant")
        description = optional(record, "Original Statement") or merchant or ""
        category, notes = optional(record, "Category"), optional(record, "Notes")
        amount_column, convention = "Amount", "charges-negative"
    elif source == "mint":
        direction = record["Transaction Type"].strip().lower()
        if direction not in ("debit", "credit"):
            raise ValueError("unknown Mint direction")
        signed = abs(amount(record["Amount"])) * (-1 if direction == "debit" else 1)
        day, account = record["Date"], record["Account Name"]
        merchant = optional(record, "Description")
        description = optional(record, "Original Description") or merchant or ""
        category, notes = optional(record, "Category"), optional(record, "Notes")
        amount_column, convention = "Amount", "direction-column"
    elif source == "copilot":
        day, signed = record["date"], -amount(record["amount"])
        account = record["account"].strip()
        digits = re.sub(r"\D", "", record.get("account mask", ""))
        if digits and digits not in account:
            account += f" (...{digits})"
        merchant = optional(record, "name")
        description = merchant or ""
        category, notes = optional(record, "category"), optional(record, "note")
        amount_column, convention = "amount", "charges-positive"
    else:
        day, signed = record["Transaction Date"], -amount(record["Amount (USD)"])
        account = "Apple Card"
        merchant = optional(record, "Merchant")
        description = optional(record, "Description") or merchant or ""
        category, notes = optional(record, "Category"), optional(record, "Type")
        amount_column, convention = "Amount (USD)", "charges-positive"

    if not account.strip() or (not description and signed != 0):
        raise ValueError("missing account or nonzero description")
    status_column = args.status_column or ("status" if source == "copilot" else "Status")
    status = (optional(record, status_column) or "").lower()
    provider_status = status if status in ("pending", "posted") else None
    id_column = args.id_column or ("Id" if source == "monarch" else "")
    row = {
        "rowPosition": position,
        "providerTransactionId": optional(record, id_column),
        "providerAccountId": optional(record, args.account_id_column or ""),
        "accountDescriptor": account.strip(),
        "statementDate": plain_date(day),
        "providerAmount": float(signed),
        "merchant": merchant,
        "rawDescription": description,
        "sourceCategory": category,
        "providerStatus": provider_status,
        "providerNotes": notes,
        "providerData": {
            "fields": record,
            "csv": {
                "fileSha256": fingerprint,
                "sourceAmount": record[amount_column],
                "sourceSignConvention": convention,
            },
        },
    }
    return row, signed


def parse_file(path, args):
    raw = path.read_bytes()
    fingerprint = hashlib.sha256(raw).hexdigest()
    reader = csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    headers = next((values for values in reader if values), None)
    if not headers or len(headers) != len(set(headers)):
        raise ValueError("missing or duplicate headers")
    sources = [source for source, required in HEADERS.items() if required <= set(headers)]
    if len(sources) != 1:
        raise ValueError("unsupported or ambiguous CSV schema")
    source = sources[0]
    for column in (args.id_column, args.account_id_column, args.status_column):
        if column and column not in headers:
            raise ValueError("configured column missing")
    rows, counts, totals = [], Counter(), {}
    while True:
        # csv.line_num counts physical lines, including quoted multiline cells.
        position = reader.line_num + 1
        try:
            values = next(reader)
        except StopIteration:
            break
        if not values:
            continue
        if len(values) != len(headers):
            raise ValueError(f"row {position}: column count mismatch")
        try:
            row, signed = normalize(source, dict(zip(headers, values)), position, fingerprint, args)
        except (ValueError, InvalidOperation) as error:
            raise ValueError(f"row {position}: invalid date, amount, direction or required field") from error
        rows.append(row)
        key = (row["accountDescriptor"], row["statementDate"])
        counts[key] += 1
        totals[key] = totals.get(key, Decimal(0)) + signed

    metadata = {
        "source": source,
        "label": args.label or path.name,
        "fingerprint": fingerprint,
        "dateKind": "transaction" if source == "apple-card" else "unknown",
        "rowCountDeclared": len(rows),
        "notes": None,
    }
    if args.observed_at:
        metadata["observedAt"] = args.observed_at
    batches = [
        {
            "import": metadata,
            "rows": rows[offset:offset + 500],
            "dryRun": True,
            "complete": False,
            "confirmedWithdrawals": [],
        }
        for offset in range(0, max(1, len(rows)), 500)
    ]
    return {
        "summary": {
            "source": source,
            "fingerprint": fingerprint,
            "rowCount": len(rows),
            "zeroValueRows": sum(row["providerAmount"] == 0 for row in rows),
            "pendingRows": sum(row["providerStatus"] == "pending" for row in rows),
            "unknownStatusRows": sum(row["providerStatus"] is None for row in rows),
            "partitions": [
                {"account": account, "date": day, "count": count,
                 "providerAmountTotal": str(totals[(account, day)])}
                for (account, day), count in sorted(counts.items())
            ],
        },
        "batches": batches,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--label")
    parser.add_argument("--observed-at", help="ISO UTC observation timestamp")
    parser.add_argument("--id-column", help="Attested provider transaction ID column")
    parser.add_argument("--account-id-column", help="Attested provider account ID column")
    parser.add_argument("--status-column", help="Only literal pending/posted is classified")
    args = parser.parse_args()
    if args.file.resolve() == args.output.resolve():
        parser.error("output must differ from input")
    try:
        parsed = parse_file(args.file, args)
        # Exclusive creation avoids overwriting source material or prior evidence.
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(parsed, output, ensure_ascii=False, allow_nan=False, indent=2)
            output.write("\n")
    except (OSError, UnicodeError, csv.Error, ValueError) as error:
        parser.exit(1, f"Parse failed ({type(error).__name__}); no source rows printed.\n")


if __name__ == "__main__":
    main()
