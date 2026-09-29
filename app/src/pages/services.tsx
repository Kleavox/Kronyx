import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { EmptyState } from "@/components/empty-state";
import { FilterChips } from "@/components/filter-chips";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ActionDialog,
  type ActionRequest,
} from "@/features/services/action-dialog";
import { ServiceList } from "@/features/services/service-list";
import { useOverview, useRefreshServices, useServices } from "@/lib/api";
import {
  bulkTargets,
  groupPrimary,
  groupServices,
  refreshPending,
} from "@/lib/services";

export function ServicesPage() {
  const overview = useOverview();
  const services = useServices();
  const refresh = useRefreshServices();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const notRunning = params.get("state") === "down";
  const showSystem = params.get("system") === "1";

  const setParam = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  if (!overview.data || !services.data) {
    return (
      <>
        <PageHeader title="Services" />
        <Skeleton className="h-64" />
      </>
    );
  }

  const nodes = overview.data.nodes.filter((node) => node.enrolled_at !== null);
  const seen = overview.dataUpdatedAt;
  const groups = groupServices(services.data, nodes, {
    showSystem,
    query,
    notRunning,
  });
  const refreshing = services.data.nodes.some((node) =>
    refreshPending(node, services.dataUpdatedAt),
  );
  const bulk = params.get("bulk");
  const bulkGroup = bulk
    ? groupServices(services.data, nodes, {
        showSystem: true,
        query: "",
        notRunning: false,
      }).find((group) => group.key === bulk)
    : undefined;
  const dialogRequest =
    request ??
    (bulkGroup
      ? {
          action: groupPrimary(bulkGroup),
          targets: bulkTargets(bulkGroup, seen),
        }
      : null);

  return (
    <>
      <PageHeader
        title="Services"
        actions={
          nodes.length > 0 && (
            <>
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search services or servers"
                aria-label="Search services or servers"
                className="h-11 w-full md:h-8 md:w-56"
              />
              <FilterChips
                label="Filter services"
                value={notRunning ? "down" : "all"}
                onChange={(value) =>
                  setParam("state", value === "all" ? null : value)
                }
                options={[
                  { value: "all", label: "All" },
                  { value: "down", label: "Not running" },
                ]}
              />
              <div className="flex items-center gap-2">
                <Switch
                  id="system-services"
                  checked={showSystem}
                  onCheckedChange={(checked) =>
                    setParam("system", checked ? "1" : null)
                  }
                />
                <Label
                  htmlFor="system-services"
                  className="text-xs text-muted-foreground"
                >
                  System services
                </Label>
              </div>
              <Button
                variant="outline"
                disabled={refresh.isPending || refreshing}
                onClick={() => refresh.mutate(undefined)}
              >
                <RefreshCw aria-hidden="true" />
                {refreshing ? "Refreshing…" : "Refresh all"}
              </Button>
            </>
          )
        }
      />

      {nodes.length === 0 ? (
        <EmptyState
          title="No servers yet"
          body="Enroll a server from Fleet. Its services appear here within five minutes."
          action={
            <Button asChild>
              <Link to="/">Open Fleet</Link>
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title={
            query || notRunning
              ? "No services match"
              : "No services reported yet"
          }
          body={
            query || notRunning
              ? "Change the search or the filter to see the rest."
              : "Agents report their services within five minutes of enrolling. Refresh asks them now."
          }
        />
      ) : (
        <ServiceList
          groups={groups}
          seen={seen}
          showServer
          onRequest={setRequest}
        />
      )}

      <ActionDialog
        request={dialogRequest}
        onClose={() => {
          setRequest(null);
          if (bulk) setParam("bulk", null);
        }}
      />
    </>
  );
}
