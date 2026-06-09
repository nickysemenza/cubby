import { useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { EntityListScreen } from "@/components/entity-list-screen";
import { useTRPC } from "@/lib/trpc";

export default function TasksScreen() {
  const trpc = useTRPC();
  // Notion-backed: the dashboard query returns { projects, tasks, purchases },
  // or null when no Notion integration is configured.
  const q = useQuery(trpc.notion.dashboard.queryOptions());
  const notConfigured = q.data === null;
  const tasks = q.data?.tasks ?? [];

  return (
    <EntityListScreen
      embedded
      title="Tasks"
      items={tasks}
      count={notConfigured ? undefined : tasks.length}
      isLoading={q.isLoading}
      isRefetching={q.isRefetching}
      error={q.error}
      onRefresh={() => void q.refetch()}
      keyExtractor={(t) => t.id}
      primaryText={(t) => t.name}
      secondaryText={(t) =>
        [t.status, t.projectName, t.due].filter(Boolean).join(" · ") || null
      }
      onPressItem={(t) => void WebBrowser.openBrowserAsync(t.notionUrl)}
      emptyText={notConfigured ? "Notion isn't connected." : "No tasks."}
    />
  );
}
