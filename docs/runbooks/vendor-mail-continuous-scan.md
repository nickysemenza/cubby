# Vendor Gmail continuous scan

The continuous scan walks a vendor's mailbox one page at a time, so a
search resumes from its checkpoint instead of restarting. The checkpoint is
part of the search's `mail_search` Run: `Run.input.searchTerms` holds the exact
sender and domain terms saved at launch, and `Run.progress.pagesScanned`,
`pageToken`, and `nextPageToken` record where the walk stands. Field meanings
and an inspection query are in [vendor Gmail search runs](vendor-mail-search-jobs.md).

These values used to be columns on a `VendorMailSearchJob` table; the
2026-09 consolidation migration moved them onto the Run. A run created before
the terms were recorded has an empty `searchTerms`, so its historical query
criteria cannot be reconstructed.
