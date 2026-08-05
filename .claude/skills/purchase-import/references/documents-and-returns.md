# Documents and returns

## Purchase paperwork

Most Purchases have no primary document and are not expected to grow one.
Filed paperwork is concentrated in construction and trade material buys, and
only some of those produce anything attachable. Everything below applies when
the source in hand actually contains a document — an empty `paperwork` facet on
an ordinary purchase is the normal state and needs no action.

Attach original files to the Purchase with `attach_file`, using the Purchase
shortcode and an accurate `documentKind`. Use evidence in this order: final
invoice or receipt, credit memo, order acknowledgment, then quote or estimate.
Payment receipts, statements, returns, and other files remain useful evidence
but do not masquerade as a primary document. Pasted email text may support notes
and reconciliation, but is not a file attachment or primary document.

Use `reclassify_purchase_document` when an existing attachment was classified
incorrectly. Do not fabricate a PDF from an email body or structured text just
to clear a data-quality gap; retain source evidence instead. Record an exception
only where the absence is itself established knowledge — a return or a deposit
against an unnumbered contract that genuinely had no invoice issued. "There is
no document" is the default for most purchases and does not need to be written
down.

Reclassification is often cheaper than a rescan: a phone photo already filed as
`other` may in fact be the invoice, and retyping it closes `primary_document`
with no new file. Check existing attachments before scanning anything — and do
not initiate a scan of paper the user has not handed over.

## Attaching many files, and scans

`attach_file` takes `data` (base64) **or** `url`. **Always use `url`.** The
`data` path is not merely inefficient in bulk — it corrupts files silently, and
the threshold is per-file, not per-batch. Base64 has to be reproduced verbatim
through model output, and long opaque strings lose spans with no error: a single
25 KB receipt (~34 K base64 chars) truncated on 5 of 5 attempts, each time
returning success. Treat `data` as unusable above a few KB.

A corrupt attachment is **worse than no attachment**: the bytes land, the
Purchase's `paperwork` facet flips to `complete`, and `primary_document` clears,
so the purchase reads as documented while holding a file that will not open.
After every attach, fetch the returned URL back and compare to the source —
`md5 -q` on both, or at minimum check the byte count and a trailing `%%EOF`.
Only a byte-identical round trip counts as filed.

To stage the files in the project's R2 bucket and let the server fetch them:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>   # required; several accounts are visible
pnpm exec wrangler r2 object put foo/staging/<random-name>.pdf \
  --file=/absolute/path.pdf --content-type=application/pdf --remote
```

If `wrangler` is unavailable or the account id is ambiguous, the same PUT can be
signed with `aws4fetch` (already a repo dependency) against `R2_ENDPOINT` /
`R2_BUCKET_NAME` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` from
`apps/web/.env`. Either way the bytes are read from disk by the HTTP client and
never pass through model output, which is the whole point.

Then call `attach_file` with `url: "https://foobucket.nicky.fun/staging/..."`. The
server re-uploads the bytes to a canonical `cubby/documents/PUR-xxxx/` key, so the
staged object is not referenced afterwards — **delete it**. A deleted staged
object may still return 200 from CDN cache; re-check with a cache-busting query
before concluding the cleanup failed.

To remove a bad attachment, `update_purchase` takes `removeImageIds`. Verify the
`paperwork` gap reappears afterwards — that is the signal the bogus file is
really gone. Staged objects are
world-readable while they exist, so use unguessable names for anything carrying an
address or card digits, and clean up in the same session. Pass `--file` an
absolute path: `pnpm --dir <repo> exec wrangler` resolves relative paths against
that directory and will otherwise fail with ENOENT.

Multi-invoice scans: split with `pdfseparate in.pdf out-p%02d.pdf`, one Purchase
per page. Scans have **no text layer**, so `pdftotext` returns nothing and the
pages must be rendered (`pdftoppm -jpeg -r 130`) and read as images. Attach the
original split PDFs, not the rendered images. When a handwritten field resists
reading, crop and upscale that region rather than guessing — a stapled register
tape usually carries the authoritative amounts even when the body is illegible,
and unit ticks (`20'`, `5'`) distinguish feet from pieces.

## Returns

File refund Expenses and Financial Transactions on the original Purchase.

- Full return: a negative Expense can offset the original line on that Purchase.
- Partial refund on a multi-item order: preserve the actual kept-item cost;
  never change stated total merely to hide the difference.
- A return where neither charge nor refund is in the ledger needs no synthetic
  zero-net entry.

Use `split_expense` rather than hand-creating parts and deleting an aggregate.
Put invoice-level narrative on Purchase notes. Split parts inherit the original
Expense notes when `notes` is omitted; provide a specific note to replace them or
`null` to clear them for one part.

**Inheritance is not uniform — `projectId` is dropped.** `notes` and `url` carry
over from the parent, but every part needs `projectId`, `costType`, `trade`, and
`lineKind` passed explicitly; omit `projectId` and the parts land unassigned,
silently pulling the whole order out of its project rollup. `costType` and
`trade` are rejected outright if missing, so they fail loudly — `projectId` does
not. Re-read the parts after every split and compare them against the snapshot
before continuing.

The tool's own argument is `expenseId`, not `id`. Splitting an aggregate whose
amount disagrees with the receipt requires correcting the parent's `cost` to the
vendor figure *first* — parts must sum to the parent — and saying so in a note.

## Variances and credits

Seek the final invoice, receipt, or credit memo before classifying a mismatch.
Keep a retained-goods price correction on the retained Purchase; keep a returned
item and its refund on the original Purchase; keep a general account credit as
settlement evidence until its use is known. Record a typed productless Expense
only for a source-evidenced adjustment amount. Never derive one from an
unexplained reconciliation difference, spread the difference across lines, or
rewrite `statedTotal` merely to make reconciliation appear clean.
