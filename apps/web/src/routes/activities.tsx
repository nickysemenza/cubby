import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle, Clock } from "lucide-react";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/activities")({
  ssr: false,
  errorComponent: RouteErrorComponent,
  component: ActivitiesDashboard,
});

function ActivitiesDashboard() {
  useDocumentTitle("Activities");
  const api = useTRPC();

  const { data: dueActivities, isLoading } = useQuery(
    api.activityType.listDue.queryOptions({ dueSoonDays: 30 }),
  );

  if (isLoading || !dueActivities) {
    return (
      <PageWrapper>
        <div className="space-y-6">
          <div>
            <h1 className="font-bold text-2xl">Activities</h1>
            <p className="text-muted-foreground">Loading...</p>
          </div>
        </div>
      </PageWrapper>
    );
  }

  const overdue = dueActivities.filter((a) => a.isOverdue);
  const dueSoon = dueActivities.filter((a) => a.isDueSoon && !a.isOverdue);

  return (
    <PageWrapper>
      <div className="space-y-6">
        <div>
          <h1 className="font-bold text-2xl">Activities</h1>
          <p className="text-muted-foreground">
            Track maintenance and recurring tasks for your products
          </p>
        </div>

        {/* Overdue Section */}
        {overdue.length > 0 && (
          <Card className="border-destructive">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Overdue ({overdue.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {overdue.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/products/$id"
                    params={{ id: activity.productId }}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                  >
                    <div>
                      <div className="font-medium">{activity.name}</div>
                      <div className="text-muted-foreground text-sm">
                        {activity.product.name}
                      </div>
                    </div>
                    <Badge variant="destructive">
                      {activity.nextDueAt &&
                        formatDistanceToNow(activity.nextDueAt, {
                          addSuffix: true,
                        })}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Due Soon Section */}
        {dueSoon.length > 0 && (
          <Card className="border-warning">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-warning">
                <Clock className="h-5 w-5" />
                Due Soon ({dueSoon.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {dueSoon.map((activity) => (
                  <Link
                    key={activity.id}
                    to="/products/$id"
                    params={{ id: activity.productId }}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50"
                  >
                    <div>
                      <div className="font-medium">{activity.name}</div>
                      <div className="text-muted-foreground text-sm">
                        {activity.product.name}
                      </div>
                    </div>
                    <Badge variant="outline">
                      {activity.nextDueAt &&
                        formatDistanceToNow(activity.nextDueAt, {
                          addSuffix: true,
                        })}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* No Activities */}
        {overdue.length === 0 && dueSoon.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <CheckCircle className="h-12 w-12 text-muted-foreground" />
              <p className="mt-4 font-medium text-lg">All caught up!</p>
              <p className="text-muted-foreground">
                No activities due in the next 30 days
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </PageWrapper>
  );
}
