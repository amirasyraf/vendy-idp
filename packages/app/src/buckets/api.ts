import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { useCallback } from 'react';

export type Platform = 'aws' | 'azure';
export type Bucket = {
  id: string;
  name: string;
  team: string;
  platform: Platform;
  status: 'provisioning' | 'ready' | 'failed';
  region?: string;
  requestedAt?: string | null;
  requestedBy?: string | null;
};
export type BucketDetail = Bucket & { cloudName: string; storageUri?: string };
export type BucketUsage = { objects: number; bytes: number; complete: boolean };
export type ObjectEntry = {
  key: string;
  size: number;
  updatedAt?: string;
  etag: string;
};
export type Listing = {
  folders: string[];
  objects: ObjectEntry[];
  next?: string;
};
export type Grant = { url: string; headers?: Record<string, string> };
export type Credentials =
  | {
      platform: 'aws';
      expiresAt: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
    }
  | { platform: 'azure'; expiresAt: string; url: string; sas: string };
export const platformName = { aws: 'Amazon S3', azure: 'Azure Blob Storage' };
export const statusLabel: Record<Bucket['status'], string> = {
  ready: 'Ready',
  failed: 'Failed',
  provisioning: 'Provisioning',
};
export class BucketError extends Error {
  constructor(message: string, readonly existing?: ObjectEntry) {
    super(message);
  }
}
export const describeError = (error: unknown) =>
  error instanceof BucketError
    ? error.message
    : 'The request failed. Try again.';

export function useBucketRequest() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  return useCallback(
    async <T>(
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<T> => {
      const baseUrl = await discovery.getBaseUrl('buckets');
      const response = await fetch(
        `${baseUrl}${path}`,
        body === undefined
          ? { signal }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal,
            },
      );
      const result = await response.json().catch(() => undefined);
      if (!response.ok)
        throw new BucketError(
          typeof result?.error === 'string'
            ? result.error
            : `Bucket request failed (HTTP ${response.status}).`,
          result?.existing,
        );
      return result as T;
    },
    [discovery, fetch],
  );
}
