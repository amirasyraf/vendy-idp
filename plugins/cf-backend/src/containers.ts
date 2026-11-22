import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import express from 'express';
import { message } from './github';
import { Kube, KubeError, createKube } from './kube';
import {
  PlannedStage,
  Run,
  RunConflict,
  RunKind,
  RunTables,
  createOrchestrator,
  initializeOrchestrator,
} from './orchestrator';
import { createServiceNowClient } from './servicenow';

// Compute → Containers (DESIGN.md §13, CONTRACTS.md §12). Git inventory is written by the platform
// repo's container-stage.yml; the cluster is changed in-process, through the k3s API on this host.

const TABLES: RunTables = {
  runs: 'container_runs',
  stages: 'container_run_stages',
};
const NAMESPACE = 'apps';
const NAME = /^[a-z][a-z0-9-]{2,20}$/;
export const CONTAINER_SIZES: Record<string, { cpu: string; memory: string }> =
  {
    XS: { cpu: '100m', memory: '128Mi' },
    S: { cpu: '250m', memory: '256Mi' },
    M: { cpu: '500m', memory: '512Mi' },
  };
const PLATFORMS = ['aws', 'azure'];
const ARCHES = ['amd64', 'arm64'];
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

class Invalid extends Error {}
const permanent = (text: string) =>
  Object.assign(new Error(text), { permanent: true });

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const text = (value: unknown, max: number, min = 1) =>
  typeof value === 'string' &&
  value.length >= min &&
  value.length <= max &&
  !CONTROL.test(value);

/** The user-editable `spec.container` section, normalized; throws Invalid. */
export function normalizeContainer(value: unknown) {
  const c = record(value);
  const known = ['platform', 'arch', 'image', 'port', 'size', 'replicas', 'public', 'env'];
  const unknown = Object.keys(c).filter(key => !known.includes(key));
  if (unknown.length) throw new Invalid(`Unknown container fields: ${unknown.join(', ')}`);
  if (!PLATFORMS.includes(c.platform)) throw new Invalid('Platform must be aws or azure');
  const arch = c.arch ?? 'amd64';
  if (!ARCHES.includes(arch)) throw new Invalid('Architecture must be amd64 or arm64');
  if (typeof c.image !== 'string' || !IMAGE.test(c.image) || c.image.includes('..'))
    throw new Invalid('Invalid container image reference');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new Invalid('Port must be 1-65535');
  const size = c.size ?? 'XS';
  if (!Object.prototype.hasOwnProperty.call(CONTAINER_SIZES, size))
    throw new Invalid('Size must be XS, S or M');
  const replicas = c.replicas ?? 1;
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 2)
    throw new Invalid('Replicas must be 1 or 2');
  const pub = c.public ?? true;
  if (typeof pub !== 'boolean') throw new Invalid('public must be true or false');
  const env = record(c.env);
  if (c.env !== undefined && (typeof c.env !== 'object' || Array.isArray(c.env)))
    throw new Invalid('env must be an object');
  if (Object.keys(env).length > 20) throw new Invalid('At most 20 environment variables');
  for (const [key, val] of Object.entries(env))
    if (!ENV_KEY.test(key) || !text(val, 1024, 0))
      throw new Invalid(`Invalid environment variable ${key}`);
  return {
    platform: c.platform as string,
    arch: arch as string,
    image: c.image as string,
    port: c.port as number,
    size: size as string,
    replicas: replicas as number,
    public: pub,
    env: env as Record<string, string>,
  };
}

/** The whole entity spec, as the platform repo's container_spec.py normalizes it. */
export function normalizeSpec(value: unknown) {
  const spec = record(value);
  const known = ['type', 'owner', 'lifecycle', 'container', 'billing', 'cloudTags'];
  const unknown = Object.keys(spec).filter(key => !known.includes(key));
  if (unknown.length) throw new Invalid(`Unknown spec fields: ${unknown.join(', ')}`);
  if (spec.type !== 'container') throw new Invalid('spec.type must be container');
  const team = /^(?:group:(?:default\/)?)?([a-z][a-z0-9-]*)$/.exec(String(spec.owner ?? ''))?.[1];
  if (!team) throw new Invalid('spec.owner must be a team');
  const lifecycle = spec.lifecycle ?? 'poc';
  if (!text(lifecycle, 64)) throw new Invalid('Invalid lifecycle');
  const billing = record(spec.billing);
  if (!text(billing.costCenter, 256) || !text(billing.projectCode, 256) || Object.keys(billing).length !== 2)
    throw new Invalid('billing needs costCenter and projectCode');
  const tags = record(spec.cloudTags);
  if (Object.keys(tags).length > 40) throw new Invalid('At most 40 tags');
  for (const [key, val] of Object.entries(tags))
    if (!text(key, 128) || !text(val, 256, 0)) throw new Invalid(`Invalid tag ${key}`);
  return {
    type: 'container',
    owner: `group:default/${team}`,
    lifecycle,
    container: normalizeContainer(spec.container),
    billing: { costCenter: billing.costCenter, projectCode: billing.projectCode },
    cloudTags: tags as Record<string, string>,
  };
}
export type ContainerSpec = ReturnType<typeof normalizeSpec>;

function containerPlan(kind: RunKind, params: Record<string, any>): PlannedStage[] {
  const stages = (names: string[]) => names.map(stage => ({ stage, applies: true }));
  if (kind === 'provision')
    return stages(['servicenow', 'register', 'deploy', 'rollout', 'finalize']);
  if (kind === 'modify') return stages(['configure', 'deploy', 'rollout', 'finalize']);
  if (kind === 'power') return stages([params.action, 'rollout']);
  return stages(['undeploy', 'destroy', 'finalize']);
}

function containerStageParams(stage: string, params: Record<string, any>, outcome: string | null) {
  if (stage === 'register' || stage === 'configure') return { spec: params.spec };
  if (stage === 'finalize') return { outcome };
  return {};
}

const base = (kind: string) =>
  kind === 'deployments'
    ? `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`
    : `/api/v1/namespaces/${NAMESPACE}/${kind}`;

/** The Deployment and Service for one container incarnation. */
export function manifests(name: string, requestId: string, spec: ContainerSpec) {
  const c = spec.container;
  const team = spec.owner.split('/').pop()!;
  const labels = {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/managed-by': 'vendy-idp',
    'vendy.io/team': team,
  };
  const resources = CONTAINER_SIZES[c.size];
  return {
    deployment: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name,
        namespace: NAMESPACE,
        labels,
        annotations: { 'vendy.io/request-id': requestId },
      },
      spec: {
        replicas: c.replicas,
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: { labels },
          spec: {
            // The pool label fixes both the cloud and the CPU architecture (DESIGN.md §13.3).
            nodeSelector: { 'vendy.io/pool': `${c.platform}-${c.arch}` },
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            containers: [
              {
                name: 'app',
                image: c.image,
                ports: [{ containerPort: c.port }],
                env: Object.entries(c.env).map(([key, value]) => ({ name: key, value })),
                resources: { requests: resources, limits: resources },
              },
            ],
          },
        },
      },
    },
    service: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: NAMESPACE,
        labels: { ...labels, 'vendy.io/public': String(c.public) },
        annotations: { 'vendy.io/request-id': requestId },
      },
      spec: {
        selector: { 'app.kubernetes.io/name': name },
        ports: [{ name: 'http', port: 80, targetPort: c.port }],
      },
    },
  };
}

type Pod = {
  metadata: { name: string; creationTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: {
      ready: boolean;
      restartCount: number;
      state?: Record<string, { reason?: string; message?: string; exitCode?: number }>;
      lastState?: Record<string, { reason?: string; message?: string; exitCode?: number }>;
    }[];
  };
};

const PULL_FAILURES = ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull'];

/** The rollout state of a Deployment: done, waiting (with a reason) or a permanent failure. */
async function rolloutState(kube: Kube, name: string, spec: ContainerSpec) {
  const deployment = await kube.get(`${base('deployments')}/${name}`);
  const want = Number(deployment.spec?.replicas ?? 0);
  const status = deployment.status ?? {};
  const done =
    Number(status.observedGeneration ?? 0) >= Number(deployment.metadata?.generation ?? 1) &&
    Number(status.updatedReplicas ?? 0) === want &&
    Number(status.availableReplicas ?? 0) === want &&
    Number(status.replicas ?? 0) === want;
  if (done) return { done: true as const, text: `${want}/${want} replicas available` };
  const pods = (
    await kube.get<{ items: Pod[] }>(
      `${base('pods')}?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${name}`)}`,
    )
  ).items;
  const pool = `${spec.container.platform}-${spec.container.arch}`;
  for (const pod of pods) {
    for (const container of pod.status?.containerStatuses ?? []) {
      const waiting = container.state?.waiting;
      if (waiting?.reason && PULL_FAILURES.includes(waiting.reason))
        return {
          failed: `The image could not be pulled (${waiting.reason}): ${(waiting.message ?? '').slice(0, 300)}`,
        };
      if (waiting?.reason === 'CrashLoopBackOff' && container.restartCount >= 3) {
        const last = container.lastState?.terminated;
        return {
          failed: `The container keeps exiting (exit ${last?.exitCode ?? '?'}${
            last?.reason ? `, ${last.reason}` : ''
          }). "exec format error" in the logs means the image does not support ${spec.container.arch}.`,
        };
      }
    }
  }
  const unschedulable = pods.some(pod =>
    (pod.status?.conditions ?? []).some(
      condition => condition.type === 'PodScheduled' && condition.status === 'False',
    ),
  );
  if (unschedulable)
    return { waiting: `Provisioning capacity: starting a ${pool} worker node (about 1-3 minutes)` };
  const ready = Number(status.readyReplicas ?? 0);
  return { waiting: `Starting containers: ${ready}/${want} ready` };
}

const teamsOf = (refs: string[]) =>
  refs.filter(ref => ref.startsWith('group:default/')).map(ref => ref.split('/').pop()!);

export const containersPlugin = createBackendPlugin({
  pluginId: 'containers',
  register(reg) {
    reg.registerInit({
      deps: {
        database: coreServices.database,
        auth: coreServices.auth,
        scheduler: coreServices.scheduler,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
      },
      async init({ database, auth, scheduler, httpRouter, httpAuth, userInfo, logger, config, catalog }) {
        const automation = config.getOptionalBoolean('computeFactory.demoAutomation') ?? false;
        const appBaseUrl = config.getString('app.baseUrl').replace(/\/$/, '');
        const appsDomain = `apps.${new URL(appBaseUrl).hostname}`;
        const kube = createKube({
          server: process.env.KUBE_API ?? 'https://host.docker.internal:6443',
          tokenPath: process.env.KUBE_TOKEN_PATH ?? '/kube/token',
          caPath: process.env.KUBE_CA_PATH ?? '/kube/ca.crt',
        });
        const db = await database.getClient();
        await initializeOrchestrator(db, TABLES);
        const serviceNow = createServiceNowClient(auth, config);

        const specOf = (run: Run): ContainerSpec => JSON.parse(run.params || '{}').spec;
        const deploy = async (run: Run) => {
          const spec = specOf(run);
          const { deployment, service } = manifests(run.name, run.request_id, spec);
          const current = await kube.get(`${base('deployments')}/${run.name}`).catch(error => {
            if (error instanceof KubeError && error.status === 404) return undefined;
            throw error;
          });
          const owner = current?.metadata?.annotations?.['vendy.io/request-id'];
          if (owner && owner !== run.request_id)
            throw permanent(`A different container incarnation named ${run.name} is deployed`);
          await kube.apply(`${base('deployments')}/${run.name}`, deployment);
          await kube.apply(`${base('services')}/${run.name}`, service);
          const c = spec.container;
          return `Applied ${c.image} (${c.size}, ${c.replicas}x) to pool ${c.platform}-${c.arch}`;
        };
        const orchestrator = createOrchestrator({
          db,
          logger,
          appBaseUrl,
          tables: TABLES,
          workflow: 'container-stage.yml',
          label: 'Container',
          basePath: '/containers',
          plan: containerPlan,
          stageParams: containerStageParams,
          waitDeadlineMs: 15 * 60_000,
          inProcess: {
            servicenow: async run => {
              const c = specOf(run).container;
              const number = await serviceNow({
                requestId: run.request_id,
                vmName: run.name,
                team: run.team,
                requestedBy: `user:default/${run.requested_by}`,
                platform: c.platform,
                os: 'container',
                size: c.size,
              });
              return `${number} created (mock ServiceNow)`;
            },
            deploy,
            rollout: async run => {
              const spec =
                run.kind === 'power'
                  ? (JSON.parse(run.params || '{}').current as ContainerSpec)
                  : specOf(run);
              const state = await rolloutState(kube, run.name, spec);
              if ('failed' in state) throw permanent(state.failed!);
              if ('waiting' in state) return { waiting: state.waiting! };
              return state.text;
            },
            restart: async run => {
              await kube.apply(`${base('deployments')}/${run.name}`, {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                metadata: { name: run.name, namespace: NAMESPACE },
                spec: {
                  template: {
                    metadata: { annotations: { 'vendy.io/restarted-at': new Date().toISOString() } },
                  },
                },
              }, 'vendy-idp-restart');
              return 'Rolling restart requested';
            },
            undeploy: async run => {
              const current = await kube.get(`${base('deployments')}/${run.name}`).catch(error => {
                if (error instanceof KubeError && error.status === 404) return undefined;
                throw error;
              });
              const owner = current?.metadata?.annotations?.['vendy.io/request-id'];
              if (owner && owner !== run.request_id)
                throw permanent(`A different container incarnation named ${run.name} is deployed`);
              await kube.remove(`${base('services')}/${run.name}`);
              await kube.remove(`${base('deployments')}/${run.name}`);
              return 'Removed from the cluster';
            },
          },
        });

        let queue: Promise<unknown> = Promise.resolve();
        function exclusive<T>(fn: () => Promise<T>): Promise<T> {
          const result = queue.then(fn);
          queue = result.catch(() => {});
          return result;
        }

        const caller = async (req: express.Request) => {
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
          const info = await userInfo.getUserInfo(credentials);
          return {
            credentials,
            user: info.userEntityRef.split('/').pop()!,
            teams: teamsOf(info.ownershipEntityRefs),
            admin: info.ownershipEntityRefs.includes('group:default/platform-admins'),
          };
        };
        type Caller = Awaited<ReturnType<typeof caller>>;
        const allowed = (info: Caller, run: Run) => info.admin || info.teams.includes(run.team);
        const route =
          (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
          async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            try {
              await fn(req, res);
            } catch (error) {
              if (error instanceof RunConflict) res.status(409).json({ error: error.message });
              else if (error instanceof Invalid) res.status(400).json({ error: error.message });
              else next(error);
            }
          };

        /** A container entity the caller may read (the catalog policy filters by owner). */
        const readContainer = async (info: Caller, name: string) => {
          const entity = await catalog.getEntityByRef(
            { kind: 'Resource', namespace: 'default', name },
            { credentials: info.credentials },
          );
          const team = /^group:default\/([a-z][a-z0-9-]*)$/.exec(String(entity?.spec?.owner ?? ''))?.[1];
          if (!entity || entity.spec?.type !== 'container' || !team)
            return { ok: false, status: 404, error: `Container ${name} not found` } as const;
          if (!info.admin && !info.teams.includes(team))
            return { ok: false, status: 403, error: 'Container belongs to another team' } as const;
          const requestId = entity.metadata.annotations?.['cf/request-id'];
          if (!requestId)
            return { ok: false, status: 409, error: 'Container inventory has no request ID' } as const;
          return { ok: true, entity, team, requestId } as const;
        };

        const router = express.Router();
        router.use(express.json({ limit: '64kb' }));

        // Caddy's on-demand TLS check: a certificate only for an existing public container.
        httpRouter.addAuthPolicy({ path: '/tls-ask', allow: 'unauthenticated' });
        router.get(
          '/tls-ask',
          route(async (req, res) => {
            const domain = String(req.query.domain ?? '').toLowerCase();
            const suffix = `.${appsDomain}`;
            const name = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : '';
            if (!NAME.test(name)) {
              res.status(404).end();
              return;
            }
            const service = await kube.get(`${base('services')}/${name}`).catch(() => undefined);
            res.status(service?.metadata?.labels?.['vendy.io/public'] === 'true' ? 200 : 404).end();
          }),
        );

        router.post(
          '/requests',
          route(async (req, res) => {
            const info = await caller(req);
            if (!automation) {
              res.status(503).json({ error: 'Container automation is disabled in this environment' });
              return;
            }
            const { name, specJson, requestId } = req.body ?? {};
            if (typeof name !== 'string' || !NAME.test(name))
              throw new Invalid('Name must match ^[a-z][a-z0-9-]{2,20}$');
            if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))
              throw new Invalid('Invalid request ID');
            let parsed: unknown;
            try {
              parsed = JSON.parse(String(specJson ?? ''));
            } catch {
              throw new Invalid('specJson is not JSON');
            }
            const spec = normalizeSpec(parsed);
            const team = spec.owner.split('/').pop()!;
            if (!info.admin && !info.teams.includes(team)) {
              res.status(403).json({ error: `You are not a member of team ${team}` });
              return;
            }
            const key = `request:${requestId}`;
            const repeated = await orchestrator.findByRequestKey(key);
            if (!repeated) {
              const [latest] = await orchestrator.runsFor(name, 1);
              const gone = !latest || (latest.kind === 'destroy' && latest.status === 'succeeded');
              if (!gone || (await kube.exists(`${base('deployments')}/${name}`))) {
                res.status(409).json({ error: `A container named ${name} already exists` });
                return;
              }
            }
            const { run, created } = await exclusive(() =>
              orchestrator.createRun({
                kind: 'provision',
                name,
                team,
                requestId,
                requestKey: key,
                requestedBy: info.user,
                requesterTeams: info.teams,
                params: { spec },
              }),
            );
            if (!created && run.requested_by !== info.user) {
              res.status(409).json({ error: 'Request key already used' });
              return;
            }
            res.json({ runId: run.id, runUrl: orchestrator.runUrl(run.id) });
          }),
        );

        // Day-2: modify (new spec.container), restart or destroy, from the container page.
        router.post(
          '/runs',
          route(async (req, res) => {
            const info = await caller(req);
            if (!automation) {
              res.status(503).json({ error: 'Container automation is disabled in this environment' });
              return;
            }
            const { operation, container, requestKey } = req.body ?? {};
            let ref;
            try {
              ref = parseEntityRef(String(container ?? ''));
            } catch {
              ref = undefined;
            }
            if (
              !['modify', 'restart', 'destroy'].includes(operation) ||
              typeof requestKey !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey) ||
              ref?.kind.toLowerCase() !== 'resource' ||
              ref.namespace !== 'default' ||
              !NAME.test(ref.name)
            ) {
              res.status(400).json({ error: 'Invalid container operation' });
              return;
            }
            const found = await readContainer(info, ref.name);
            if (!found.ok) {
              res.status(found.status).json({ error: found.error });
              return;
            }
            const current = normalizeSpec(found.entity.spec);
            let kind: RunKind = 'destroy';
            let params: Record<string, unknown> = {};
            if (operation === 'modify') {
              const next = normalizeContainer(req.body.spec);
              if (next.platform !== current.container.platform || next.arch !== current.container.arch)
                throw new Invalid('Modify cannot change the platform or architecture');
              if (JSON.stringify(next) === JSON.stringify(current.container))
                throw new Invalid('Nothing to change: this is the current configuration');
              kind = 'modify';
              params = { spec: { ...current, container: next } };
            } else if (operation === 'restart') {
              kind = 'power';
              params = { action: 'restart', current };
            }
            const { run, created } = await exclusive(() =>
              orchestrator.createRun({
                kind,
                name: ref!.name,
                team: found.team,
                requestId: found.requestId,
                requestKey: `${operation}:${ref!.name}:${requestKey}`,
                requestedBy: info.user,
                requesterTeams: info.teams,
                params,
              }),
            );
            if (!created && (run.requested_by !== info.user || run.name !== ref!.name)) {
              res.status(409).json({ error: 'Request key already used' });
              return;
            }
            res.json({ runId: run.id, runUrl: orchestrator.runUrl(run.id) });
          }),
        );

        const visibleRun = async (req: express.Request, info: Caller) => {
          const id = Number(req.params.id);
          const run = Number.isSafeInteger(id) ? await orchestrator.getRun(id) : undefined;
          return run && allowed(info, run) ? run : undefined;
        };
        router.get(
          '/runs/:id',
          route(async (req, res) => {
            const info = await caller(req);
            const run = await visibleRun(req, info);
            if (!run) res.status(404).json({ error: 'Run not found' });
            else res.json(await orchestrator.view(run, true));
          }),
        );
        router.get(
          '/runs',
          route(async (req, res) => {
            const info = await caller(req);
            const name = String(req.query.name ?? '');
            if (!NAME.test(name)) {
              res.status(400).json({ error: 'Expected a container name' });
              return;
            }
            const runs = (await orchestrator.runsFor(name, 10)).filter(run => allowed(info, run));
            res.json({ runs: await Promise.all(runs.map(run => orchestrator.view(run, true))) });
          }),
        );
        router.post(
          '/runs/:id/retry',
          route(async (req, res) => {
            const info = await caller(req);
            const run = await visibleRun(req, info);
            if (!run) {
              res.status(404).json({ error: 'Run not found' });
              return;
            }
            await exclusive(async () => orchestrator.retry((await orchestrator.getRun(run.id))!, info.user));
            res.json(await orchestrator.view((await orchestrator.getRun(run.id))!, true));
          }),
        );
        router.get(
          '/summary',
          route(async (req, res) => {
            const info = await caller(req);
            const runs = (await orchestrator.latestRuns()).filter(run => allowed(info, run));
            res.json({
              containers: await Promise.all(
                runs.map(async run => ({ name: run.name, latest: await orchestrator.view(run, true) })),
              ),
            });
          }),
        );

        // Live state from the cluster: replicas, pods (node, restarts) and the public URL.
        router.get(
          '/status/:name',
          route(async (req, res) => {
            const info = await caller(req);
            const found = await readContainer(info, req.params.name);
            if (!found.ok) {
              res.status(found.status).json({ error: found.error });
              return;
            }
            const name = req.params.name;
            const spec = normalizeSpec(found.entity.spec);
            try {
              const deployment = await kube.get(`${base('deployments')}/${name}`).catch(error => {
                if (error instanceof KubeError && error.status === 404) return undefined;
                throw error;
              });
              const pods = deployment
                ? (
                    await kube.get<{ items: Pod[] }>(
                      `${base('pods')}?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${name}`)}`,
                    )
                  ).items
                : [];
              res.json({
                enabled: true,
                deployed: Boolean(deployment),
                url: spec.container.public ? `https://${name}.${appsDomain}` : null,
                replicas: Number(deployment?.spec?.replicas ?? 0),
                ready: Number(deployment?.status?.readyReplicas ?? 0),
                pods: pods.map(pod => {
                  const container = pod.status?.containerStatuses?.[0];
                  const state = container?.state ?? {};
                  const key = Object.keys(state)[0];
                  return {
                    name: pod.metadata.name,
                    phase: pod.status?.phase ?? 'Unknown',
                    node: pod.spec?.nodeName ?? null,
                    ready: Boolean(container?.ready),
                    restarts: Number(container?.restartCount ?? 0),
                    state: key ? `${key}${state[key]?.reason ? ` (${state[key].reason})` : ''}` : 'pending',
                    startedAt: pod.metadata.creationTimestamp ?? null,
                  };
                }),
              });
            } catch (error) {
              res.json({ enabled: false, error: message(error) });
            }
          }),
        );
        router.get(
          '/logs/:name',
          route(async (req, res) => {
            const info = await caller(req);
            const found = await readContainer(info, req.params.name);
            if (!found.ok) {
              res.status(found.status).json({ error: found.error });
              return;
            }
            const pods = (
              await kube.get<{ items: Pod[] }>(
                `${base('pods')}?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${req.params.name}`)}`,
              )
            ).items;
            const pod =
              pods.find(item => item.metadata.name === req.query.pod) ??
              pods.find(item => item.status?.phase === 'Running') ??
              pods[0];
            if (!pod) {
              res.json({ pod: null, logs: '' });
              return;
            }
            const logs = await kube
              .text(`${base('pods')}/${pod.metadata.name}/log?container=app&tailLines=200&timestamps=true`)
              .catch(error => `(logs unavailable: ${message(error)})`);
            res.json({ pod: pod.metadata.name, logs });
          }),
        );
        httpRouter.use(router);

        if (automation) {
          await scheduler.scheduleTask({
            id: 'container-orchestrator',
            frequency: { seconds: 10 },
            timeout: { minutes: 5 },
            fn: () =>
              exclusive(() =>
                orchestrator.tick().catch(error => logger.warn(`Container orchestration paused: ${message(error)}`)),
              ),
          });
        }
      },
    });
  },
});
