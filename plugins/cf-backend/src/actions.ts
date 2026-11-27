import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { message } from './github';

type RunResult = { runId: number; runUrl: string };

// Both endpoints are idempotent per task ID and serialized, so retrying after a timeout or
// transient server error returns the first attempt's run instead of creating a second one.
// Only deliberate refusals (a string `error`) and other 4xx are final.
async function callVms(
  ctx: any,
  auth: AuthService,
  discovery: DiscoveryService,
  path: string,
  body: Record<string, unknown>,
  pluginId = 'vms',
): Promise<RunResult> {
  const noun = pluginId === 'vms' ? 'VM' : 'Container';
  const credentials = await ctx.getInitiatorCredentials();
  if (!auth.isPrincipal(credentials, 'user'))
    throw new Error('A signed-in user is required');
  const base = await discovery.getBaseUrl(pluginId);
  const deadline = Date.now() + 10 * 60 * 1000;
  for (let attempt = 1; ; attempt++) {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: credentials,
      targetPluginId: pluginId,
    });
    const timeout = AbortSignal.timeout(120000);
    let response: Response | undefined;
    let failure = '';
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      failure = `${noun} request failed (${message(error)})`;
    }
    if (response) {
      const result = await response.json().catch(() => undefined as any);
      if (response.ok && Number.isSafeInteger(result?.runId))
        return result as RunResult;
      // Our endpoints' deliberate answers carry a string; Backstage's generic error
      // handler sends { error: { name, message } }.
      if (typeof result?.error === 'string') throw new Error(result.error);
      failure = `${noun} request HTTP ${response.status}${
        typeof result?.error?.message === 'string'
          ? `: ${result.error.message}`
          : ''
      }`;
      if (response.status < 500) throw new Error(failure);
    }
    if (Date.now() > deadline)
      throw new Error(
        `${failure}. The run may still have been created; check the ${noun} page before resubmitting.`,
      );
    ctx.logger.warn(
      `${failure}; retrying the same request (attempt ${attempt + 1})`,
    );
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(5000 * attempt, 30000)),
    );
  }
}

const output = {
  runId: (z: any) => z.number(),
  runUrl: (z: any) => z.string(),
};

export function createVmDispatchAction(
  auth: AuthService,
  discovery: DiscoveryService,
) {
  return createTemplateAction({
    id: 'cf:vm:dispatch',
    description:
      'Reserve quota and start a VM provision run as the requesting user',
    schema: {
      input: { name: z => z.string(), specJson: z => z.string() },
      output,
    },
    async handler(ctx) {
      const result = await ctx.checkpoint({
        key: 'cf.vm.dispatch.v2',
        fn: () =>
          callVms(ctx, auth, discovery, '/requests', {
            name: ctx.input.name,
            specJson: ctx.input.specJson,
            requestId: ctx.task.id,
          }),
      });
      ctx.output('runId', result.runId);
      ctx.output('runUrl', result.runUrl);
      ctx.logger.info(`VM provision run #${result.runId}: ${result.runUrl}`);
    },
  });
}

export function createVmRunAction(
  auth: AuthService,
  discovery: DiscoveryService,
) {
  return createTemplateAction({
    id: 'cf:vm:run',
    description:
      'Start a day-2 run (modify, re-apply, power, OS update or destroy) for an existing VM as the requesting user',
    schema: {
      input: {
        operation: z =>
          z.enum([
            'modify',
            'reapply',
            'start',
            'stop',
            'reboot',
            'update',
            'destroy',
          ]),
        vm: z => z.string(),
        compute: z => z.record(z.string(), z.string()).optional(),
        software: z => z.array(z.string()).optional(),
        adJoin: z => z.boolean().optional(),
      },
      output,
    },
    async handler(ctx) {
      const result = await ctx.checkpoint({
        key: 'cf.vm.run.v2',
        fn: () =>
          callVms(ctx, auth, discovery, '/runs', {
            operation: ctx.input.operation,
            vm: ctx.input.vm,
            compute: ctx.input.compute,
            software: ctx.input.software,
            adJoin: ctx.input.adJoin,
            requestKey: ctx.task.id,
          }),
      });
      ctx.output('runId', result.runId);
      ctx.output('runUrl', result.runUrl);
      ctx.logger.info(
        `VM ${ctx.input.operation} run #${result.runId}: ${result.runUrl}`,
      );
    },
  });
}

export function createContainerDispatchAction(
  auth: AuthService,
  discovery: DiscoveryService,
) {
  return createTemplateAction({
    id: 'cf:container:dispatch',
    description: 'Start a container provision run as the requesting user',
    schema: {
      input: { name: z => z.string(), specJson: z => z.string() },
      output,
    },
    async handler(ctx) {
      const result = await ctx.checkpoint({
        key: 'cf.container.dispatch.v1',
        fn: () =>
          callVms(
            ctx,
            auth,
            discovery,
            '/requests',
            {
              name: ctx.input.name,
              specJson: ctx.input.specJson,
              requestId: ctx.task.id,
            },
            'containers',
          ),
      });
      ctx.output('runId', result.runId);
      ctx.output('runUrl', result.runUrl);
      ctx.logger.info(`Container provision run #${result.runId}: ${result.runUrl}`);
    },
  });
}

export function createBucketAction(auth: AuthService, discovery: DiscoveryService) {
  return createTemplateAction({
    id: 'cf:bucket:create',
    description: 'Create a private Bucket for a Vendy team',
    schema: {
      input: { name: z => z.string(), owner: z => z.string(), platform: z => z.enum(['aws', 'azure']) },
      output: { url: z => z.string() },
    },
    async handler(ctx) {
      const bucket = await ctx.checkpoint({
        key: 'cf.bucket.create.v1',
        fn: async () => {
          const caller = await ctx.getInitiatorCredentials();
          if (!auth.isPrincipal(caller, 'user')) throw new Error('A signed-in user is required');
          const { token } = await auth.getPluginRequestToken({ onBehalfOf: caller, targetPluginId: 'buckets' });
          const response = await fetch(await discovery.getBaseUrl('buckets'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...ctx.input, requestId: ctx.task.id }),
            signal: AbortSignal.timeout(100_000),
          });
          const result = await response.json();
          if (!response.ok || typeof result.id !== 'string')
            throw new Error(typeof result.error === 'string' ? result.error : `Bucket request failed (HTTP ${response.status})`);
          return { id: result.id };
        },
      });
      ctx.output('url', `/products/storage/bucket/${bucket.id}`);
    },
  });
}
