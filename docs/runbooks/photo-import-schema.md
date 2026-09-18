# Photo import schema rollout

Photo imports do not require a receipt table or a schema migration. The
database lifecycle is represented directly by `Image.status`: newly staged
rows are `PENDING`, and a successful commit performs one final bulk transition
to `UPLOADED` after all destination writes and projections succeed.

Deployments must therefore work against databases both with and without any
legacy receipt table that may have been created by an earlier experiment. The
application no longer reads, writes, or declares that table. This rollout ships
no `DROP TABLE`; if a later interactive `db:push` proposes dropping the legacy
table, cancel that statement rather than treating it as part of photo import.

The 24-hour pending-image culler claims rows transactionally with row locks and
skips rows held by an in-flight import. Any pending image with an association
is protected from pruning.

After a lost commit response, clients use the reconciliation operation rather
than repeating the commit. Reconciliation takes the same image-row locks and
then reads every status and direct association in one transaction, so its
answer cannot straddle an in-flight commit.
