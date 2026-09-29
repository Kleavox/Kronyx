import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";

import type {
  ActionRecord,
  BatchMode,
  CheckKind,
  CheckResults,
  Enrollment,
  EnrollmentStatus,
  MetricRange,
  NodeMetrics,
  Overview,
  RecentMetrics,
  ServiceAction,
  ServicesResponse,
  SessionResponse,
} from "../types";
import { pollEnrollment } from "./enrollment";
import { apiFetch, errorMessage } from "./http";
import { keepWhileSameNode, queryKeys } from "./query-client";
import { untilWindowSettles } from "./series";
import { pollServices, type ActionTarget } from "./services";

const MINUTE = 60_000;

const RANGE_REFRESH: Record<MetricRange, number> = {
  "6h": 5 * MINUTE,
  "24h": 15 * MINUTE,
  "7d": 60 * MINUTE,
};

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiFetch<SessionResponse>("/api/session"),
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => apiFetch<Overview>("/api/overview"),
    refetchInterval: () => untilWindowSettles(Date.now()),
  });
}

export function useRecentMetrics() {
  return useQuery({
    queryKey: queryKeys.recentMetrics,
    queryFn: () => apiFetch<RecentMetrics>("/api/metrics/recent"),
    refetchInterval: () => untilWindowSettles(Date.now()),
  });
}

export function useNodeMetrics(id: string, range: MetricRange) {
  return useQuery({
    queryKey: queryKeys.nodeMetrics(id, range),
    queryFn: () =>
      apiFetch<NodeMetrics>(
        `/api/nodes/${encodeURIComponent(id)}/metrics?range=${range}`,
      ),
    refetchInterval: RANGE_REFRESH[range],
    placeholderData: keepWhileSameNode(id),
  });
}

export function useCheckResults() {
  return useQuery({
    queryKey: queryKeys.checkResults,
    queryFn: () => apiFetch<CheckResults>("/api/checks/results"),
    refetchInterval: () => untilWindowSettles(Date.now()),
  });
}

function useApiMutation<TVariables, TData = unknown>(
  request: (variables: TVariables) => Promise<TData>,
  invalidate: readonly QueryKey[],
  toastErrors = false,
) {
  const client = useQueryClient();
  return useMutation<TData, Error, TVariables>({
    mutationFn: request,
    onSuccess: () =>
      Promise.all(
        invalidate.map((queryKey) => client.invalidateQueries({ queryKey })),
      ).then(() => undefined),
    onError: toastErrors
      ? (error) => {
          toast.error(errorMessage(error));
        }
      : undefined,
  });
}

function send(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, body: JSON.stringify(body) };
}

interface NewCheck {
  nodeId: string;
  name: string;
  kind: CheckKind;
  target: string;
}

export const useCreateEnrollment = () =>
  useApiMutation(
    () => apiFetch<Enrollment>("/api/enrollments", send("POST", {})),
    [],
  );

export function useEnrollmentStatus(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.enrollment(id ?? ""),
    queryFn: () =>
      apiFetch<EnrollmentStatus>(`/api/enrollments/${encodeURIComponent(id!)}`),
    enabled: id !== undefined,
    refetchInterval: (query) => pollEnrollment(query.state.data),
  });
}

export const useUpdateNode = () =>
  useApiMutation(
    ({ id, ...change }: { id: string; name?: string; autoUpdate?: boolean }) =>
      apiFetch(`/api/nodes/${id}`, send("PATCH", change)),
    [queryKeys.overview, queryKeys.recentMetrics],
  );

export const useRequestAgentUpdate = () =>
  useApiMutation(
    (nodeId: string) =>
      apiFetch<{ version: string }>(
        `/api/nodes/${nodeId}/update`,
        send("POST"),
      ),
    [queryKeys.overview],
    true,
  );

export const useCheckAgentRelease = () =>
  useApiMutation(
    () =>
      apiFetch<{ version: string | null; requested: number }>(
        "/api/agent-release/check",
        send("POST"),
      ),
    [queryKeys.overview],
    true,
  );

export const useDeleteNode = () =>
  useApiMutation(
    (nodeId: string) => apiFetch(`/api/nodes/${nodeId}`, send("DELETE")),
    [queryKeys.overview, queryKeys.recentMetrics, queryKeys.checkResults],
  );

export const useCreateCheck = () =>
  useApiMutation(
    (check: NewCheck) =>
      apiFetch("/api/checks", send("POST", { ...check, timeoutSeconds: 10 })),
    [queryKeys.overview, queryKeys.checkResults],
  );

export const useUpdateCheck = () =>
  useApiMutation(
    ({
      id,
      ...change
    }: {
      id: string;
      public?: boolean;
      publicNote?: string;
    }) => apiFetch(`/api/checks/${id}`, send("PATCH", change)),
    [queryKeys.overview],
  );

export const useDeleteCheck = () =>
  useApiMutation(
    (checkId: string) => apiFetch(`/api/checks/${checkId}`, send("DELETE")),
    [queryKeys.overview, queryKeys.checkResults],
    true,
  );

export function useServices() {
  return useQuery({
    queryKey: queryKeys.services,
    queryFn: () => apiFetch<ServicesResponse>("/api/services"),
    refetchInterval: (query) => pollServices(query.state.data, Date.now()),
  });
}

export function useNodeActions(id: string) {
  return useQuery({
    queryKey: queryKeys.nodeActions(id),
    queryFn: () =>
      apiFetch<{ actions: ActionRecord[] }>(
        `/api/nodes/${encodeURIComponent(id)}/actions`,
      ),
    refetchInterval: (query) =>
      query.state.data?.actions.some(
        (action) => action.status === "queued" || action.status === "sent",
      )
        ? 5_000
        : untilWindowSettles(Date.now()),
  });
}

export const useRunAction = (toastErrors = true) =>
  useApiMutation(
    ({
      action,
      mode,
      targets,
    }: {
      action: ServiceAction;
      mode: BatchMode;
      targets: ActionTarget[];
    }) =>
      apiFetch<{ batchId: string }>(
        "/api/actions",
        send("POST", {
          action,
          mode,
          targets: targets.map(({ nodeId, kind, name }) => ({
            nodeId,
            kind,
            name,
          })),
        }),
      ),
    [queryKeys.services, ["actions"]],
    toastErrors,
  );

export const useCancelActions = () =>
  useApiMutation(
    (batchId: string) =>
      apiFetch(
        `/api/actions/${encodeURIComponent(batchId)}/cancel`,
        send("POST"),
      ),
    [queryKeys.services, ["actions"]],
    true,
  );

export const useRefreshServices = () =>
  useApiMutation(
    (nodeIds: string[] | undefined) =>
      apiFetch(
        "/api/services/refresh",
        send("POST", nodeIds ? { nodeIds } : {}),
      ),
    [queryKeys.services],
    true,
  );
