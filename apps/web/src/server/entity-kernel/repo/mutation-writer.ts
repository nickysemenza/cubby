import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { selectListReadFields } from "~/server/generic/list/repo/list-read-schema";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

type ReaderDb = Database | DrizzleTransaction;

// Keep mutation construction independent of repository lifecycle imports: image writers
// are also reached while those lifecycle dependencies initialize during corpus startup.
/** A mutation's authoritative identity and non-response effects survive every output demand. */
export type MutationReceipt<E extends ShortcodeEntity> = {
  entityId: EntityId<E>;
  shortcode?: string;
  detachedImageKeys?: string[];
  warnings?: readonly string[];
};

/** One mutation body; only its final output reader varies between full and requested fields. */
export function defineMutationWriter<
  const E extends ShortcodeEntity,
  Args extends [ReaderDb, ...unknown[]],
  Full,
  Receipt extends MutationReceipt<E> = MutationReceipt<E>,
>(config: {
  entity: E;
  write: <Output>(
    readOutput: (
      receipt: NoInfer<Receipt>,
      readFull?: () => Promise<NoInfer<Full>>,
    ) => Promise<Output>,
    ...args: Args
  ) => Promise<Output>;
  read: (receipt: Receipt, ...args: Args) => Promise<Full>;
  item?: (full: NoInfer<Full>) => object;
}) {
  // Methods, not arrow constants: the dev SSR transform wraps named arrow
  // constants in `__name(...)`, which is undefined during Worker startup.
  const writer = {
    run(...args: Args): Promise<Full> {
      return config.write(
        (receipt, readFull) =>
          readFull ? readFull() : config.read(receipt, ...args),
        ...args,
      );
    },
    read(fields: readonly string[], ...args: Args) {
      return config.write(
        async (receipt, readFull) => {
          if (fields.every((field) => field === "id")) {
            const code =
              receipt.shortcode ??
              (
                await lookupEntityReferences(args[0], config.entity, [
                  receipt.entityId,
                ])
              ).get(receipt.entityId)?.id;
            if (!code)
              throw new Error(`Missing ${config.entity} mutation identity`);
            return { ...receipt, output: { id: code } };
          }
          const full = await (readFull
            ? readFull()
            : config.read(receipt, ...args));
          const envelope = z
            .object({ output: z.looseObject({}) })
            .safeParse(full);
          const item =
            config.item?.(full) ??
            (envelope.success
              ? envelope.data.output
              : z.looseObject({}).parse(full));
          return {
            ...receipt,
            output: selectListReadFields(
              z.looseObject({ id: z.string() }).parse(item),
              fields,
            ),
          };
        },
        ...args,
      );
    },
  };
  return Object.assign(writer.run, {
    read: writer.read,
    withOutput: config.write,
  });
}
