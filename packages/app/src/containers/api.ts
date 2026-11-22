import { useMemo } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import type { RunView } from '@internal/plugin-vm-status';

export type ContainerConfig = {
  platform: 'aws' | 'azure';
  arch: 'amd64' | 'arm64';
  image: string;
  port: number;
  size: 'XS' | 'S' | 'M';
  replicas: number;
  public: boolean;
  env: Record<string, string>;
};

export type ContainerStatus = {
  enabled: boolean;
  error?: string;
  deployed?: boolean;
  url?: string | null;
  replicas?: number;
  ready?: number;
  pods?: {
    name: string;
    phase: string;
    node: string | null;
    ready: boolean;
    restarts: number;
    state: string;
    startedAt: string | null;
  }[];
};

export const SIZES: Record<string, string> = {
  XS: '0.1 vCPU, 128 MiB',
  S: '0.25 vCPU, 256 MiB',
  M: '0.5 vCPU, 512 MiB',
};

/** Client for the IDP `containers` backend plugin (CONTRACTS.md §12). */
export function useContainersApi() {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useMemo(() => {
    async function request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
      const base = await discovery.getBaseUrl('containers');
      const response = await fetchApi.fetch(`${base}${path}`, {
        method,
        ...(payload === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body === undefined) {
        let message = `Containers API: ${response.status}`;
        if (typeof body?.error === 'string') message = body.error;
        else if (typeof body?.error?.message === 'string') message = body.error.message;
        throw new Error(message);
      }
      return body as T;
    }
    return {
      getRun: (id: string | number) => request<RunView>(`/runs/${encodeURIComponent(id)}`),
      runs: (name: string) => request<{ runs: RunView[] }>(`/runs?name=${encodeURIComponent(name)}`),
      retry: (id: number) => request<RunView>(`/runs/${id}/retry`, 'POST'),
      summary: () => request<{ containers: { name: string; latest: RunView }[] }>('/summary'),
      status: (name: string) => request<ContainerStatus>(`/status/${encodeURIComponent(name)}`),
      logs: (name: string) => request<{ pod: string | null; logs: string }>(`/logs/${encodeURIComponent(name)}`),
      operate: (body: {
        operation: 'modify' | 'restart' | 'destroy';
        container: string;
        requestKey: string;
        spec?: ContainerConfig;
      }) => request<{ runId: number; runUrl: string }>('/runs', 'POST', body),
    };
  }, [discovery, fetchApi]);
}

export const requestKey = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Coarse status from the latest run, else the catalog annotation. */
export function containerStatus(run: RunView | undefined, fallback?: string) {
  if (run) {
    if (run.status === 'failed') return 'failed';
    if (run.status === 'running') return run.kind === 'destroy' ? 'destroying' : 'deploying';
    if (run.status === 'succeeded' && run.kind !== 'destroy') return 'ready';
  }
  return fallback ?? 'unknown';
}

export const STAGE_LABELS: Record<string, string> = {
  servicenow: 'ServiceNow request',
  register: 'Register inventory',
  configure: 'Save configuration',
  deploy: 'Deploy to cluster',
  rollout: 'Start containers',
  restart: 'Restart',
  undeploy: 'Remove from cluster',
  destroy: 'Remove inventory',
  finalize: 'Finalize',
};
