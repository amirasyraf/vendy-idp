import { useCallback, useSyncExternalStore } from 'react';
import type { RunView } from '@internal/plugin-vm-status';
import { ContainerStatus, useContainersApi } from './api';

type ContainerLive = {
  status?: ContainerStatus;
  runs?: RunView[];
  error?: string;
};

type Store = {
  value: ContainerLive;
  listeners: Set<() => void>;
  stop: () => void;
};

const stores = new Map<string, Store>();
const empty: ContainerLive = {};

// The entity header and overview share one poller, as on the VM detail page.
function createStore(name: string, api: ReturnType<typeof useContainersApi>): Store {
  let disposed = false;
  let timer: number | undefined;
  const store: Store = {
    value: empty,
    listeners: new Set(),
    stop: () => {
      disposed = true;
      window.clearTimeout(timer);
    },
  };
  const poll = async () => {
    let next: ContainerLive;
    try {
      const [status, { runs }] = await Promise.all([
        api.status(name),
        api.runs(name),
      ]);
      next = { status, runs };
    } catch (error) {
      next = { ...store.value, error: (error as Error).message };
    }
    if (disposed) return;
    store.value = next;
    store.listeners.forEach(listener => listener());
    timer = window.setTimeout(poll, 5000);
  };
  poll();
  return store;
}

export function useContainerLive(name: string): ContainerLive {
  const api = useContainersApi();
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = stores.get(name) ?? createStore(name, api);
      stores.set(name, store);
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size) return;
        store.stop();
        stores.delete(name);
      };
    },
    [api, name],
  );
  const getSnapshot = useCallback(() => stores.get(name)?.value ?? empty, [name]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
