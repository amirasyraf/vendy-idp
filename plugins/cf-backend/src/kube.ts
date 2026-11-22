import { readFileSync } from 'fs';
import https from 'https';

// The IDP's client for the k3s API on its own host (CONTRACTS.md §12). The token and CA belong to
// the `vendy-idp` service account; deploy/cluster/install.sh writes them to /opt/idp/kube.

export class KubeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Kube = ReturnType<typeof createKube>;

export function createKube(options: {
  server: string;
  tokenPath: string;
  caPath: string;
}) {
  const url = new URL(options.server);
  // Read per request: the files may appear after the backend starts (first bootstrap).
  const credentials = () => ({
    token: readFileSync(options.tokenPath, 'utf8').trim(),
    ca: readFileSync(options.caPath, 'utf8'),
  });

  function request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
    raw = false,
  ): Promise<T> {
    const { token, ca } = credentials();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path,
          method,
          ca,
          timeout: 15_000,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: raw ? 'text/plain' : 'application/json',
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type': contentType,
                  'Content-Length': Buffer.byteLength(payload),
                }),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              let detail = text.slice(0, 300);
              try {
                detail = JSON.parse(text).message ?? detail;
              } catch {
                // not JSON
              }
              reject(new KubeError(status, `Kubernetes ${method} ${path}: ${status} ${detail}`));
              return;
            }
            if (raw) resolve(text as T);
            else {
              try {
                resolve((text ? JSON.parse(text) : {}) as T);
              } catch (error) {
                reject(error);
              }
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Kubernetes ${method} ${path}: timed out`)));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    get: <T = any>(path: string) => request<T>('GET', path),
    text: (path: string) => request<string>('GET', path, undefined, undefined, true),
    /**
     * Server-side apply of one object (JSON is valid apply YAML). Fields this manager applied
     * before and omits now are removed, so partial updates use their own manager.
     */
    apply: (path: string, object: unknown, manager = 'vendy-idp') =>
      request('PATCH', `${path}?fieldManager=${manager}&force=true`, object, 'application/apply-patch+yaml'),
    /** Delete; an object that is already gone counts as deleted. */
    async remove(path: string) {
      try {
        await request('DELETE', path, { propagationPolicy: 'Foreground' });
      } catch (error) {
        if (!(error instanceof KubeError && error.status === 404)) throw error;
      }
    },
    async exists(path: string) {
      try {
        await request('GET', path);
        return true;
      } catch (error) {
        if (error instanceof KubeError && error.status === 404) return false;
        throw error;
      }
    },
  };
}
