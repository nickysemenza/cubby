import type { StatementSuggestionOut } from "@cubby/schemas/statement-suggestion";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { useEntityMetadata } from "~/entity/metadata";
import { cn } from "~/lib/utils";

import { RecordLink } from "./suggestion-values";

type Create = NonNullable<StatementSuggestionOut["create"]>;
type Vote = Create["votes"][keyof Create["votes"]];

const kindLabel = (queryClient: QueryClient, kind: string) =>
  fieldEnumOptions(queryClient, "financialTransaction", "kind").find(
    (option) => option.value === kind,
  )?.label ?? kind;

const SOURCES = [
  { source: "rule", label: "Rule", hint: "provider category" },
  { source: "label", label: "Label", hint: "decision model" },
  { source: "history", label: "History", hint: "merchant history" },
] as const;

type Stance = "agree" | "disagree" | "abstain";
type KindVote = {
  source: (typeof SOURCES)[number]["source"];
  label: string;
  hint: string;
  vote: Vote;
  stance: Stance;
};

const voteText = (queryClient: QueryClient, vote: Vote) =>
  vote === null
    ? "no vote"
    : vote === "mixed"
      ? "mixed"
      : kindLabel(queryClient, vote);

/**
 * Each source's vote against the proposed kind, and the clean rule's reading
 * in words: at least two agree and none disagrees. A judgment published before
 * votes were recorded has none, so it falls back to the source of the kind.
 */
export function kindAgreement(
  queryClient: QueryClient,
  create: Pick<Create, "kind" | "kindSource" | "votes">,
) {
  const votes: KindVote[] = SOURCES.map(({ source, label, hint }) => {
    const vote = create.votes[source];
    return {
      source,
      label,
      hint,
      vote,
      stance:
        vote === null ? "abstain" : vote === create.kind ? "agree" : "disagree",
    };
  });
  const agree = votes.filter((vote) => vote.stance === "agree");
  const disagree = votes.filter((vote) => vote.stance === "disagree");
  if (!agree.length && !disagree.length)
    return {
      votes,
      recorded: false,
      reason: `From the ${create.kindSource === "sign" ? "amount sign" : create.kindSource}`,
    };
  const agreeing = agree.length
    ? `: ${agree.map((vote) => vote.source).join(" + ")}`
    : "";
  const dissent = disagree.length
    ? `; ${disagree.map((vote) => `${vote.source} says ${voteText(queryClient, vote.vote)}`).join(", ")}`
    : "";
  return {
    votes,
    recorded: true,
    reason: `${agree.length} of ${SOURCES.length} agree${agreeing}${dissent}`,
  };
}

const STANCE = {
  agree: { Icon: CheckIcon, className: "text-positive", word: "agrees" },
  disagree: { Icon: XIcon, className: "text-warning-ink", word: "disagrees" },
  abstain: {
    Icon: MinusIcon,
    className: "text-muted-foreground",
    word: "abstains",
  },
} satisfies Record<
  Stance,
  { Icon: typeof CheckIcon; className: string; word: string }
>;

/** The three kind votes, each source → its kind, marked by agreement. */
export function KindVotes({ create }: { create: Create }) {
  const queryClient = useQueryClient();
  useEntityMetadata("financialTransaction");
  const { votes, reason } = kindAgreement(queryClient, create);
  return (
    <div className="flex flex-col gap-0.5">
      <p>
        Kind {kindLabel(queryClient, create.kind)}{" "}
        <span className="text-muted-foreground">· {reason}</span>
      </p>
      <ul aria-label="Kind votes" className="flex flex-col gap-0.5">
        {votes.map((vote) => {
          const stance = STANCE[vote.stance];
          return (
            <li
              key={vote.source}
              data-stance={vote.stance}
              className="flex min-w-0 items-center gap-1.5"
            >
              <stance.Icon
                aria-label={stance.word}
                className={cn("size-3 shrink-0", stance.className)}
              />
              <span className="font-medium">{vote.label}</span>
              <span className="text-muted-foreground">({vote.hint})</span>
              <span aria-hidden className="text-muted-foreground">
                →
              </span>
              <span
                className={cn(
                  vote.stance === "disagree" && "text-warning-ink",
                  vote.stance === "abstain" && "text-muted-foreground",
                )}
              >
                {voteText(queryClient, vote.vote)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Who is on the other side, by each source that said; a person is never clean. */
export function CounterpartyLine({
  counterparty,
}: {
  counterparty: Create["counterparty"];
}) {
  const { label, history } = counterparty;
  if (!label && !history) return null;
  const said =
    label === history
      ? `${label === "person" ? "Person" : "Business"} (label + history)`
      : [
          label
            ? `${label === "person" ? "Person" : "Business"} (label)`
            : null,
          history
            ? `${history === "person" ? "person" : "business"} (history)`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const person = label === "person" || history === "person";
  return (
    <p className={person ? "text-warning-ink" : undefined}>
      <span className="text-muted-foreground">Counterparty</span> {said}
      {person ? " · a person is never accepted in bulk" : null}
    </p>
  );
}

/** A move between the member's own accounts, naming the other account. */
export function TransferLine({
  transfer,
}: {
  transfer: NonNullable<StatementSuggestionOut["transfer"]>;
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="text-muted-foreground">Own-account move</span>
      {transfer.accountId ? (
        <>
          <span className="text-muted-foreground">with</span>
          <RecordLink
            record={{ entity: "financialAccount", id: transfer.accountId }}
          />
        </>
      ) : (
        <span>· several of your accounts fit the descriptor</span>
      )}
      {transfer.ledgerTransfer ? (
        <span className="text-warning-ink">
          · different owners, so a LedgerTransfer is also owed
        </span>
      ) : null}
    </p>
  );
}
