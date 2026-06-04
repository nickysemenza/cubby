import { createFileRoute } from "@tanstack/react-router";
import { useTableDensity } from "~/app/_components/data-table/useTableDensity";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import {
  FLAG_KEYS,
  FLAGS,
  type FlagGroup,
  type FlagKey,
  useFlags,
} from "~/lib/flags";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings | cubby" }] }),
});

const GROUPS: { group: FlagGroup; blurb: string }[] = [
  {
    group: "Developer",
    blurb: "Diagnostics and debug tooling. Safe to leave on; off by default.",
  },
  {
    group: "Experimental",
    blurb: "Unfinished features — may change or break.",
  },
];

function SettingsPage() {
  const { flags, setFlag, resetFlags } = useFlags();
  return (
    <EntityLayout title="Settings">
      <div className="mx-auto max-w-2xl space-y-6 pb-16">
        {GROUPS.map(({ group, blurb }) => {
          const keys = FLAG_KEYS.filter((k) => FLAGS[k].group === group);
          if (keys.length === 0) return null;
          return (
            <Card key={group} emphasis="chunky">
              <CardHeader>
                <CardTitle>{group}</CardTitle>
                <CardDescription>{blurb}</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border/60">
                {keys.map((key) => (
                  <FlagRow
                    key={key}
                    flagKey={key}
                    value={flags[key]}
                    onChange={(v) => setFlag(key, v)}
                  />
                ))}
              </CardContent>
            </Card>
          );
        })}

        <AppearanceCard />

        <Button variant="outline" size="sm" onClick={resetFlags}>
          Reset developer flags
        </Button>
      </div>
    </EntityLayout>
  );
}

function FlagRow({
  flagKey,
  value,
  onChange,
}: {
  flagKey: FlagKey;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const def = FLAGS[flagKey];
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{def.label}</span>
          <code className="font-mono text-[10px] text-muted-foreground">
            {flagKey}
          </code>
        </div>
        <p className="text-muted-foreground text-xs">{def.description}</p>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

const DENSITIES = ["comfortable", "compact", "dense"] as const;

function AppearanceCard() {
  const { density, setDensity } = useTableDensity();
  return (
    <Card emphasis="chunky">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 py-1">
          <div className="space-y-0.5">
            <span className="font-medium text-sm">Table density</span>
            <p className="text-muted-foreground text-xs">
              Row height in data tables.
            </p>
          </div>
          <div className="flex gap-1">
            {DENSITIES.map((d) => (
              <Button
                key={d}
                size="xs"
                variant={density === d ? "default" : "outline"}
                onClick={() => setDensity(d)}
                className="capitalize"
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
