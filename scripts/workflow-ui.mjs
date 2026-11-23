// Exercise the actual served frontend with fixture APIs only. No login credentials,
// workflow dispatches, VM creation or backend writes. Run against local or deployed UI.
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.WORKFLOW_UI_URL;
if (!base) throw new Error('Set WORKFLOW_UI_URL to the frontend URL');
let admin = false;
const template = {
  apiVersion: 'scaffolder.backstage.io/v1beta3',
  kind: 'Template',
  metadata: {
    name: 'vm-request',
    namespace: 'default',
    title: 'Request a VM',
    description: 'A team-owned server built from a golden image.',
    tags: ['product'],
    annotations: {
      'cf/product': 'Virtual Machines',
      'cf/launch-flow': 'platform-image',
    },
  },
  spec: { type: 'vm', owner: 'group:default/alpha' },
};
const containerTemplate = {
  ...template,
  metadata: {
    name: 'container-request',
    namespace: 'default',
    title: 'Deploy a Container',
    tags: ['product'],
  },
  spec: { ...template.spec, type: 'service' },
};
const vm = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: {
    name: 'spec-vm',
    namespace: 'default',
    uid: 'spec-vm-fixture',
    annotations: {
      'cf/status': 'ready',
      'cf/instance-type': 't3.medium',
      'cf/public-ip': '203.0.113.42',
      'cf/ssh-user': 'ubuntu',
      'cf/requested-at': '2026-11-17T08:00:00Z',
      'cf/ready-at': '2026-11-17T08:05:00Z',
      'cf/request-id': 'fixture-request',
      'cf/instance-id': 'i-0fixture000000001',
    },
  },
  spec: {
    type: 'vm',
    owner: 'group:default/alpha',
    lifecycle: 'poc',
    compute: {
      platform: 'aws',
      os: 'ubuntu',
      imageVersion: '26.04',
      size: 'M',
    },
    configuration: { software: ['git', 'nginx'], adJoin: false },
    billing: { costCenter: 'CC-1234' },
    cloudTags: { environment: 'test' },
  },
  relations: [{ type: 'ownedBy', targetRef: 'group:default/alpha' }],
};
const otherResource = {
  ...vm,
  metadata: { namespace: 'default', name: 'external-storage' },
  spec: { type: 'storage', owner: 'group:default/alpha' },
};
const task = {
  id: 'workflow-ui-fixture',
  status: 'processing',
  createdAt: '2026-11-15T00:00:00Z',
  spec: {
    apiVersion: 'scaffolder.backstage.io/v1beta3',
    parameters: {},
    output: {},
    templateInfo: {
      entityRef: 'template:default/vm-request',
      entity: template,
    },
    steps: [
      {
        id: 'dispatch',
        name: 'Start VM pipeline',
        action: 'cf:vm:dispatch',
      },
    ],
  },
};
const stage = (id, status, steps = []) => ({
  id,
  status,
  attempt: ['pending', 'skipped'].includes(status) ? 0 : 1,
  maxAttempts: 4,
  nextAttemptAt: null,
  startedAt: ['pending', 'skipped'].includes(status)
    ? null
    : new Date(Date.now() - 125000).toISOString(),
  finishedAt:
    status === 'success' ? new Date(Date.now() - 65000).toISOString() : null,
  error: null,
  skippable: ['software', 'ad-join'].includes(id),
  skippedBy: null,
  retriedBy: null,
  outcome: null,
  summary: null,
  runUrl:
    id === 'servicenow' || ['pending', 'skipped'].includes(status)
      ? null
      : 'https://github.com/example/platform/actions/runs/123',
  steps,
  attempts: [],
});
let demoOn = false;
let streamRequests = 0;
let runReads = 0;
let actionError = false;
let actionPosts = 0;
let summaryReads = 0;
let demoSettings = 0;
let noSummary = false;
let runReadError = false;
let latestReads = 0;
let entityGone = false;
// Health check fixture: the VM's instance as AWS reports it.
const instance = state => ({
  instanceId: 'i-0fixture000000001',
  state,
  health: state === 'running' ? 'ok' : null,
  instanceType: 't3.medium',
  publicIp: state === 'running' ? '203.0.113.42' : null,
  requestId: 'fixture-request',
  team: 'alpha',
  launchedAt: '2026-11-17T08:01:00Z',
});
let observed = instance('running');
let observedMatrix;
let operations = [];
let submittedCompute;
const vmProductPath = '/products/compute/virtual-machines';
const vmLaunchPath = '/launch/compute/virtual-machines';
const requestUrl = `${base}/create/templates/default/vm-request`;
const prefilled = `${requestUrl}?${new URLSearchParams({
  formData: JSON.stringify({
    compute: { platform: 'aws', os: 'ubuntu', imageVersion: '24.04' },
  }),
})}`;
let terminalInput = '';
let terminalOutput = [];
let terminalClosed = 0;
let taskResult = 'processing';
let taskOutput = {
  links: [{ title: 'Follow provisioning', url: `${base}/vms/runs/42` }],
};
let listVms = [vm];
let summaryMatrix;
let snapshot = {
  id: 42,
  kind: 'provision',
  name: 'spec-vm',
  team: 'alpha',
  requestId: 'fixture-request',
  requestedBy: 'user:default/amirasyraf',
  createdAt: new Date(Date.now() - 360000).toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  status: 'running',
  actions: { retry: false, skip: false },
  stages: [
    {
      ...stage('servicenow', 'success'),
      summary: 'RITM0123456789 created (mock ServiceNow)',
    },
    { ...stage('register', 'success'), summary: 'Inventory registered' },
    stage('provision', 'running', [
      {
        name: 'Terraform apply',
        status: 'in_progress',
      },
    ]),
    stage('baseline', 'pending'),
    stage('software', 'pending'),
    stage('ad-join', 'skipped'),
    stage('access', 'pending'),
    stage('finalize', 'pending'),
  ],
};
const containerRun = {
  ...snapshot,
  id: 43,
  name: 'spec-container',
  requestId: 'container-fixture-request',
  stages: [stage('register', 'running'), stage('deploy', 'pending')],
};
let containerCatalogRequestId;
const containerConfig = {
  image: 'nginx:alpine',
  platform: 'aws',
  arch: 'amd64',
  size: 'XS',
  replicas: 1,
  port: 80,
  public: true,
  env: {},
};
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const screenshotDir = process.env.WORKFLOW_UI_SCREENSHOTS;
  const nameAndTeam = ['#root_name', '#OwnershipEntityRefPicker-dropdown'];
  async function assertRequestLayout(pairs) {
    const panel = page.locator('.vendy-request > article');
    await expect(panel).toBeVisible();
    await expect(page.locator('.bui-PluginHeader')).toBeHidden();
    await expect(
      page.getByRole('navigation', { name: 'Launch breadcrumbs' }),
    ).toBeVisible();
    expect((await panel.boundingBox()).width).toBeLessThanOrEqual(1080);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [first, second] of pairs) {
        const bounds = selector =>
          panel.locator(selector).evaluate(field => {
            const border = field.closest('.MuiOutlinedInput-root');
            const { x, y, width, height } = border.getBoundingClientRect();
            const helper = field.closest('.MuiGrid-item').querySelector('p');
            return {
              x,
              y,
              width,
              height,
              helpY: helper?.getBoundingClientRect().y,
            };
          });
        const [a, b] = await Promise.all([bounds(first), bounds(second)]);
        if (width === 1440) {
          expect(Math.abs(a.y - b.y)).toBeLessThan(1);
          expect(b.x).toBeGreaterThan(a.x + a.width);
        } else {
          expect(b.y).toBeGreaterThan(a.y + a.height);
        }
        expect(Math.abs(a.height - b.height)).toBeLessThan(1);
        if (second === nameAndTeam[1]) {
          expect(a.helpY).toBeDefined();
          expect(b.helpY).toBeDefined();
          expect(Math.abs(a.helpY - a.y - (b.helpY - b.y))).toBeLessThan(1);
        }
      }
      expect(await panel.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(
        Math.ceil((await panel.boundingBox()).width),
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function capture(name) {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1100 : name.includes('wording') ? 2600 : 1400,
      });
      await page.evaluate(() => document.fonts.ready);
      await assertLineFits();
      await page.screenshot({
        path: path.join(screenshotDir, `${name}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function assertLineFits() {
    const fits = await page.getByLabel('Pipeline stages').evaluateAll(lines =>
      lines.every(line => {
        const box = line.getBoundingClientRect();
        const parent = line.parentElement.getBoundingClientRect();
        const withinViewport =
          window.location.pathname === '/catalog' ||
          (box.left >= -1 && box.right <= window.innerWidth + 1);
        return (
          withinViewport &&
          box.width <= parent.width + 1 &&
          [...line.children].every(station => {
            const r = station.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1;
          })
        );
      }),
    );
    if (!fits) throw new Error('Pipeline stations overflow their container');
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const platform =
      new URL(route.request().url()).searchParams.get('platform') ?? 'aws';
    let json = {};
    if (path.endsWith('/password/refresh')) {
      json = {
        profile: { displayName: 'UI fixture' },
        backstageIdentity: {
          token: 'fixture-not-a-real-token',
          expiresInSeconds: 3600,
          identity: {
            type: 'user',
            userEntityRef: 'user:default/amirasyraf',
            ownershipEntityRefs: [
              'user:default/amirasyraf',
              'group:default/alpha',
              ...(admin ? ['group:default/platform-admins'] : []),
            ],
          },
        },
      };
    } else if (path.endsWith('/user-settings/multiget')) {
      json = { items: [] };
    } else if (path.endsWith('/authorize')) {
      json = {
        items: (route.request().postDataJSON()?.items ?? []).map(item => ({
          id: item.id,
          result: 'ALLOW',
        })),
      };
    } else if (path.endsWith('/eventstream')) {
      // The app must long-poll /events; SSE is buffered by corporate TLS proxies.
      streamRequests++;
      await route.fulfill({ status: 500, json: { error: 'SSE not expected' } });
      return;
    } else if (
      path.endsWith('/scaffolder/v2/tasks') &&
      route.request().method() === 'POST'
    ) {
      submittedCompute = route.request().postDataJSON()?.values?.compute;
      await route.fulfill({ status: 201, json: { id: task.id } });
      return;
    } else if (path.endsWith('/events')) {
      // Long-poll fixture: return events newer than `after`, else a short idle wait and [].
      const after = Number(
        new URL(route.request().url()).searchParams.get('after') ?? 0,
      );
      const events = [
        {
          id: 1,
          type: 'log',
          body: {
            stepId: 'dispatch',
            status: taskResult === 'failed' ? 'failed' : 'processing',
            message:
              taskResult === 'failed'
                ? 'Quota exceeded'
                : 'Creating pipeline run',
          },
        },
        ...(taskResult === 'processing'
          ? []
          : [
              {
                id: 2,
                type: taskResult === 'cancelled' ? 'cancelled' : 'completion',
                body: {
                  output: taskOutput,
                  ...(taskResult === 'failed'
                    ? {
                        error: {
                          name: 'ConflictError',
                          message: 'Quota exceeded',
                        },
                      }
                    : {}),
                },
              },
            ]),
      ]
        .filter(event => event.id > after)
        .map(event => ({
          ...event,
          taskId: task.id,
          createdAt: '2026-11-15T00:00:01Z',
        }));
      if (!events.length) await delay(500);
      await route.fulfill({ json: events }).catch(() => {});
      return;
    } else if (path.includes(`/tasks/${task.id}`)) {
      json = { ...task, status: taskResult };
    } else if (path.endsWith('/entity-facets')) {
      json = {
        facets: {
          kind: ['Resource', 'Group', 'User', 'Template', 'Location'].map(
            value => ({ value, count: 1 }),
          ),
        },
      };
    } else if (path.endsWith('/entities/by-query')) {
      const query = `${decodeURIComponent(
        new URL(route.request().url()).search,
      )} ${route.request().postData() ?? ''}`;
      const resources = /kind\W+resource/i.test(query);
      json = resources
        ? { items: listVms, totalItems: listVms.length, pageInfo: {} }
        : { items: [], totalItems: 0, pageInfo: {} };
    } else if (path.endsWith('/vm-sizes/image-availability')) {
      const cloud = new URL(route.request().url()).searchParams.get('platform');
      json = {
        images:
          cloud === 'azure'
            ? [
                { os: 'ubuntu', version: '26.04', available: true },
                { os: 'windows', version: '2025', available: true },
              ]
            : [
                { os: 'ubuntu', version: '26.04', available: false },
                { os: 'ubuntu', version: '24.04', available: true },
              ],
      };
    } else if (path.endsWith('/vm-sizes/platforms')) {
      const ubuntu = [
        { id: 'ubuntu', label: 'Ubuntu', versions: ['26.04'], family: 'linux' },
      ];
      const windows = {
        id: 'windows',
        label: 'Windows Server',
        versions: ['2025'],
        family: 'windows',
        minMemoryMiB: 4096,
      };
      const rules = (prefixes, chars) => ({
        reservedTagPrefixes: prefixes,
        forbiddenTagKeyCharacters: chars,
        error: null,
      });
      json = {
        platforms: [
          {
            id: 'aws',
            label: 'AWS',
            available: true,
            os: [{ ...ubuntu[0], versions: ['26.04', '24.04'] }],
            ...rules(['aws:'], ''),
          },
          {
            id: 'azure',
            label: 'Azure',
            available: true,
            os: [...ubuntu, windows],
            ...rules(['azure', 'microsoft', 'windows'], '<>%&\\?/'),
          },
          {
            id: 'vsphere',
            label: 'vSphere',
            available: false,
            os: [],
            ...rules([], ''),
          },
        ],
      };
    } else if (path.endsWith('/vm-sizes/software')) {
      const item = (id, label, families) => ({ id, label, families });
      json = {
        software: [
          item('git', 'Git', ['linux', 'windows']),
          item('nginx', 'nginx', ['linux']),
          item('vscode', 'VS Code', ['windows']),
        ],
      };
    } else if (path.endsWith('/vm-sizes/sizes') && platform === 'azure') {
      const specs = (vcpus, gib, quotaOk) => ({
        vcpus,
        memoryMiB: gib * 1024,
        architectures: ['x86_64'],
        network: null,
        burstable: false,
        quotaOk,
      });
      json = {
        platform: 'azure',
        label: 'Azure',
        minMemoryMiB:
          new URL(route.request().url()).searchParams.get('os') === 'windows'
            ? 4096
            : 0,
        sizes: [
          {
            size: 'XS',
            instanceType: 'Standard_D2ls_v6',
            specs: specs(2, 4, true),
          },
          {
            size: 'S',
            instanceType: 'Standard_D2s_v6',
            specs: specs(2, 8, true),
          },
          {
            size: 'M',
            instanceType: 'Standard_D4ls_v6',
            specs: specs(4, 8, true),
          },
          {
            size: 'L',
            instanceType: 'Standard_D4s_v6',
            specs: specs(4, 16, false),
          },
        ],
        error: null,
      };
    } else if (
      path.endsWith('/vm-sizes/instance-types') &&
      platform === 'azure'
    ) {
      const type = (name, family, vcpus, gib, quotaOk) => ({
        type: name,
        family,
        category: 'General purpose',
        currentGeneration: true,
        bareMetal: false,
        gpus: null,
        vcpus,
        memoryMiB: gib * 1024,
        architectures: ['x86_64'],
        network: null,
        burstable: name.startsWith('Standard_B'),
        quotaOk,
      });
      json = {
        region: 'australiaeast',
        types: [
          type('Standard_B2s_v2', 'standardBsv2Family', 2, 8, false),
          type('Standard_B2ts_v2', 'standardBsv2Family', 2, 1, true),
          type('Standard_D2s_v6', 'StandardDsv6Family', 2, 8, true),
          type('Standard_D4s_v6', 'StandardDsv6Family', 4, 16, true),
        ],
      };
    } else if (path.endsWith('/vm-sizes/sizes')) {
      const specs = memoryMiB => ({
        vcpus: 2,
        memoryMiB,
        architectures: ['x86_64'],
        network: 'Up to 5 Gigabit',
        burstable: true,
      });
      json = {
        sizes: [
          { size: 'XS', instanceType: 't3.micro', specs: specs(1024) },
          { size: 'S', instanceType: 't3.small', specs: specs(2048) },
          { size: 'M', instanceType: 't3.medium', specs: specs(4096) },
          { size: 'L', instanceType: 't3.large', specs: specs(8192) },
        ],
        error: null,
      };
    } else if (path.endsWith('/vm-sizes/instance-types')) {
      const type = (name, category, vcpus, gib, extra = {}) => ({
        type: name,
        family: name.split('.')[0],
        category,
        currentGeneration: true,
        bareMetal: false,
        gpus: null,
        vcpus,
        memoryMiB: gib * 1024,
        architectures: ['x86_64'],
        network: 'Up to 12.5 Gigabit',
        burstable: false,
        ...extra,
      });
      json = {
        region: 'ap-southeast-2',
        types: [
          ...[
            ['micro', 2, 1],
            ['small', 2, 2],
            ['medium', 2, 4],
            ['large', 2, 8],
          ].map(([size, vcpus, gib]) =>
            type(`t3.${size}`, 'General purpose', vcpus, gib, {
              burstable: true,
            }),
          ),
          type('m7i.large', 'General purpose', 2, 8),
          type('m7i.xlarge', 'General purpose', 4, 16),
          type('m4.large', 'General purpose', 2, 8, {
            currentGeneration: false,
          }),
          type('c7i.xlarge', 'Compute optimized', 4, 8),
          type('r7i.large', 'Memory optimized', 2, 16),
          type('g5.xlarge', 'Accelerated computing', 4, 16, {
            gpus: '1× NVIDIA A10G',
          }),
        ],
      };
    } else if (path.endsWith('/vms/summary')) {
      summaryReads++;
      json = {
        observedAt: new Date().toISOString(),
        vms: noSummary
          ? []
          : summaryMatrix ?? [{ name: 'spec-vm', latest: snapshot, observed }],
      };
    } else if (path.endsWith('/vms/observed/spec-vm')) {
      json = {
        enabled: true,
        checkedAt: new Date().toISOString(),
        error: null,
        vm: observed,
      };
    } else if (path.endsWith('/vms/terminal')) {
      json = { id: 'fixture-term', host: '203.0.113.42', user: 'ubuntu' };
    } else if (path.endsWith('/vms/terminal/fixture-term/output')) {
      const after = Number(
        new URL(route.request().url()).searchParams.get('after'),
      );
      if (after >= terminalOutput.length) await delay(300);
      json = {
        seq: terminalOutput.length,
        data: terminalOutput.slice(after).join(''),
        closed: null,
      };
    } else if (path.endsWith('/vms/terminal/fixture-term/input')) {
      const body = route.request().postDataJSON();
      if (typeof body.data === 'string') {
        terminalInput += body.data;
        if (body.data.includes('\r'))
          terminalOutput.push('\r\nspec-vm\r\nubuntu@spec-vm:~$ ');
        else terminalOutput.push(body.data);
      }
      json = {};
    } else if (path.endsWith('/vms/terminal/fixture-term')) {
      terminalClosed++;
      json = {};
    } else if (
      path.endsWith('/vms/runs') &&
      route.request().method() === 'POST'
    ) {
      operations.push(route.request().postDataJSON());
      json = { runId: 42, runUrl: `${base}/vms/runs/42` };
    } else if (path.endsWith('/vms/runs')) {
      latestReads++;
      const query = new URL(route.request().url()).searchParams;
      if (query.get('name') !== 'spec-vm' || query.get('limit') !== '10')
        throw new Error('Latest run query mismatch');
      json = { runs: [snapshot] };
    } else if (/\/vms\/runs\/42\/(retry|skip)$/.test(path)) {
      actionPosts++;
      await delay(500);
      if (route.request().method() !== 'POST')
        throw new Error('Expected action POST');
      if (actionError) {
        await route.fulfill({
          status: 409,
          json: { error: 'Fixture conflict: stage changed' },
        });
        return;
      }
      snapshot = {
        ...snapshot,
        status: 'running',
        actions: { retry: false, skip: false },
        stages: snapshot.stages.map(s =>
          s.id === 'software'
            ? {
                ...s,
                status: path.endsWith('/skip') ? 'skipped' : 'running',
                skippedBy: path.endsWith('/skip')
                  ? 'user:default/amirasyraf'
                  : null,
                retriedBy: path.endsWith('/retry')
                  ? 'user:default/amirasyraf'
                  : null,
              }
            : s,
        ),
      };
      json = snapshot;
    } else if (path.endsWith('/containers/runs/43')) {
      json = containerRun;
    } else if (path.endsWith('/containers/runs')) {
      json = { runs: [{ ...containerRun, status: 'succeeded' }] };
    } else if (path.endsWith('/containers/status/spec-container')) {
      json = {
        enabled: true,
        deployed: true,
        url: 'https://spec-container.example.test',
        ready: 1,
        replicas: 1,
      };
    } else if (path.endsWith('/containers/logs/spec-container')) {
      json = { pod: 'spec-container-fixture', logs: 'Container fixture log' };
    } else if (path.endsWith('/vms/runs/42')) {
      runReads++;
      if (runReadError) {
        await route.fulfill({
          status: 404,
          json: { error: 'Run not found or not visible' },
        });
        return;
      }
      json = snapshot;
    } else if (path.endsWith('/vms/demo/settings')) {
      demoSettings++;
      demoOn = route.request().postDataJSON().enabled;
      json = {};
    } else if (path.endsWith('/vms/demo/state')) {
      json = {
        enabled: demoOn,
        generation: 'fixture-generation',
        isAdmin: admin,
        automationAvailable: false,
        ownedCount: 1,
        lastScan: Date.now(),
        error: null,
        vms: [],
        instanceTypes: ['t3.micro', 't3.small', 't3.medium', 't3.large'],
      };
    } else if (path.endsWith('/container-request/parameter-schema')) {
      json = {
        title: 'Deploy a Container',
        steps: [
          {
            title: 'Container',
            schema: {
              type: 'object',
              required: ['container'],
              properties: {
                name: {
                  title: 'Name',
                  type: 'string',
                  description: 'Unique lowercase name, 3–21 characters.',
                },
                team: {
                  title: 'Owning Team',
                  type: 'string',
                  'ui:field': 'MyGroupsPicker',
                },
                container: {
                  title: 'Container',
                  type: 'object',
                  required: ['platform'],
                  properties: {
                    platform: {
                      title: 'Platform',
                      type: 'string',
                      enum: ['aws', 'azure'],
                      'ui:field': 'ContainerPlatform',
                    },
                    image: { title: 'Image', type: 'string' },
                    port: {
                      title: 'Container Port',
                      type: 'integer',
                      default: 80,
                    },
                    arch: {
                      title: 'Architecture',
                      type: 'string',
                      enum: ['amd64', 'arm64'],
                      default: 'amd64',
                    },
                    size: {
                      title: 'Size',
                      type: 'string',
                      enum: ['XS', 'S', 'M'],
                      default: 'XS',
                    },
                    replicas: { title: 'Replicas', type: 'integer', default: 1 },
                  },
                },
              },
            },
          },
        ],
      };
    } else if (path.endsWith('/vm-request/parameter-schema')) {
      json = {
        title: 'Request a VM',
        steps: [
          {
            title: 'Compute',
            schema: {
              type: 'object',
              properties: {
                name: {
                  title: 'VM Name',
                  type: 'string',
                  description: 'Unique lowercase name, 3–21 characters.',
                },
                team: {
                  title: 'Owning Team',
                  type: 'string',
                  'ui:field': 'MyGroupsPicker',
                },
                compute: {
                  title: 'Compute',
                  type: 'object',
                  required: ['platform', 'os'],
                  'ui:field': 'VmComputePicker',
                  properties: {
                    platform: {
                      type: 'string',
                      default: 'aws',
                      enum: ['aws', 'azure'],
                    },
                    os: { type: 'string', default: 'ubuntu', enum: ['ubuntu'] },
                    imageVersion: { type: 'string' },
                    size: {
                      title: 'Size',
                      type: 'string',
                      enum: ['XS', 'S', 'M', 'L'],
                    },
                    instanceType: { type: 'string' },
                  },
                },
                configuration: {
                  title: 'Configuration',
                  type: 'object',
                  properties: {
                    software: {
                      title: 'Software',
                      type: 'array',
                      default: [],
                      items: { type: 'string' },
                      'ui:field': 'VmSoftwarePicker',
                    },
                  },
                },
                tags: {
                  title: 'Tags',
                  type: 'object',
                  required: ['costCenter', 'projectCode'],
                  'ui:field': 'VmTagsEditor',
                  properties: {
                    costCenter: { type: 'string', minLength: 1 },
                    projectCode: { type: 'string', minLength: 1 },
                    extra: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        ],
      };
    } else if (path.endsWith('/entities/by-refs')) {
      json = { items: [template] };
    } else if (path.endsWith('/ancestry')) {
      json = { items: [{ entity: vm, parentEntityRefs: [] }] };
    } else if (path.includes('/entities/by-name/')) {
      if (path.endsWith('/resource/default/spec-container')) {
        if (!containerCatalogRequestId) {
          await route.fulfill({
            status: 404,
            json: { error: { name: 'NotFoundError', message: 'Not registered' } },
          });
          return;
        }
        await route.fulfill({
          json: {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Resource',
            metadata: {
              name: containerRun.name,
              namespace: 'default',
              annotations: { 'cf/request-id': containerCatalogRequestId },
            },
            spec: {
              type: 'container',
              owner: 'group:default/alpha',
              lifecycle: 'poc',
              container: containerConfig,
            },
          },
        });
        return;
      }
      if (entityGone && path.includes('/resource/')) {
        await route.fulfill({
          status: 404,
          json: { error: { name: 'NotFoundError', message: 'Entity removed' } },
        });
        return;
      }
      json = path.includes('/resource/')
        ? vm
        : path.endsWith('/container-request')
        ? containerTemplate
        : template;
    } else if (
      path.endsWith('/entities') &&
      /metadata\.tags=product/.test(
        decodeURIComponent(new URL(route.request().url()).search),
      )
    ) {
      json = [template, containerTemplate];
    } else if (path.endsWith('/entities')) {
      json = listVms;
    }
    await route.fulfill({ json });
  });
  // Real form navigation, but every API including Create is intercepted above.
  await page.goto(prefilled);
  await expect(page.getByText('Ubuntu 24.04', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'L t3.large' }).click();
  await page.getByLabel('cost_center value').fill('CC-fixture');
  await page.getByLabel('project_code value').fill('PROJECT-fixture');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/create/tasks/${task.id}$`));
  expect(submittedCompute).toEqual({
    platform: 'aws',
    os: 'ubuntu',
    imageVersion: '24.04',
    size: 'L',
  });
  await expect(
    page.getByText('Start VM pipeline', { exact: true }),
  ).toBeVisible();
  taskResult = 'completed';
  await expect(page).toHaveURL(`${base}/vms/runs/42`, { timeout: 15000 });
  await expect(
    page.getByText('RITM0123456789 created (mock ServiceNow)', { exact: true }),
  ).toBeVisible();
  await capture('create-redirect');
  await page.goBack();
  await expect(page).toHaveURL(prefilled);
  for (const output of [
    { runId: 42 },
    { links: [{ title: 'Follow run', url: '/vms/runs/42' }] },
  ]) {
    task.spec.templateInfo.entityRef = 'template:default/vm-modify';
    taskOutput = output;
    await page.goto(`${base}/create/tasks/${task.id}`);
    await expect(page).toHaveURL(`${base}/vms/runs/42`, { timeout: 15000 });
  }
  task.spec.templateInfo.entityRef = 'template:default/vm-request';
  taskResult = 'failed';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(
    page.getByText('Quota exceeded', { exact: false }).first(),
  ).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  await expect(page.locator('.bui-PluginHeader')).toBeVisible();
  await capture('task-failed');
  taskResult = 'completed';
  task.spec.templateInfo.entityRef = 'template:default/ssh-cert';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(page.getByRole('link', { name: 'Follow run' })).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  task.spec.templateInfo.entityRef = 'template:default/vm-request';
  taskOutput = {
    links: [
      { title: 'External run', url: 'https://example.invalid/vms/runs/42' },
    ],
  };
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(page.getByRole('link', { name: 'External run' })).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  taskResult = 'cancelled';
  await page.goto(`${base}/create/tasks/${task.id}`);
  await expect(
    page.getByText('Start VM pipeline', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${base}/create/tasks/${task.id}`);
  console.log(
    'TASK HANDOFF PASS: Create → run with history replacement, modify runId and run link; failed/cancelled/non-VM/external URL remain stock; long polling retained',
  );
  await expect(
    page.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Workflow stages', { exact: true })).toHaveCount(
    0,
  );
  if (streamRequests)
    throw new Error(`Task page opened ${streamRequests} SSE stream(s)`);
  await page.goto(`${base}/containers/runs/${containerRun.id}`);
  const openContainer = page.getByRole('link', { name: 'Open container page →' });
  await expect(
    page.getByText('Waiting for the container to appear in the catalog…'),
  ).toBeVisible();
  await expect(openContainer).toHaveCount(0);
  containerCatalogRequestId = 'previous-container-request';
  await page.waitForResponse(
    response =>
      new URL(response.url()).pathname.endsWith('/resource/default/spec-container') &&
      response.ok(),
    { timeout: 10000 },
  );
  await expect(openContainer).toHaveCount(0);
  containerCatalogRequestId = containerRun.requestId;
  await expect(openContainer).toHaveAttribute(
    'href',
    '/catalog/default/resource/spec-container',
    { timeout: 10000 },
  );
  console.log('CONTAINER RUN PASS: catalog link waits for the matching entry');
  await openContainer.click();
  await expect(page.getByRole('heading', { name: 'spec-container' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Container state' })).toHaveText('Ready');
  for (const section of ['Connect', 'Activity', 'Configuration', 'Details']) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByText('About', { exact: true })).toHaveCount(0);
  const containerActions = page.getByRole('group', { name: 'Container actions' });
  await containerActions.getByRole('button', { name: 'Modify' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Image' })).toHaveValue(containerConfig.image);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await containerActions.getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Restart Container' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await containerActions.getByRole('button', { name: 'More container actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete Container' }).click();
  const deleteDialog = page.getByRole('dialog');
  await expect(deleteDialog.getByRole('button', { name: 'Delete Container' })).toBeDisabled();
  await deleteDialog.getByRole('textbox').fill('spec-container');
  await expect(deleteDialog.getByRole('button', { name: 'Delete Container' })).toBeEnabled();
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Show Logs' }).click();
  await expect(page.getByText(/Container fixture log/)).toBeVisible();
  await capture('container-details');
  console.log('CONTAINER DETAIL PASS: custom overview, logs and day-2 dialogs');
  runReadError = true;
  await page.goto(`${base}/vms/runs/42`);
  await expect(page.getByRole('alert')).toContainText(
    'Run not found or not visible',
  );
  runReadError = false;
  await page.getByRole('button', { name: 'Try Again', exact: true }).click();
  const runView = page.getByRole('region', { name: 'VM run 42', exact: true });
  await expect(runView).toBeVisible();
  const serviceNow = page
    .getByLabel('Run stages')
    .getByRole('listitem')
    .filter({ hasText: 'ServiceNow request' });
  await expect(serviceNow).toContainText(
    'RITM0123456789 created (mock ServiceNow)',
  );
  await expect(serviceNow.locator('details')).toHaveCount(0);
  await expect(serviceNow.getByRole('link')).toHaveCount(0);
  await expect(
    page
      .getByLabel('Run stages')
      .getByText('Inventory registered', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(8);
  await expect(runView.getByText('In progress', { exact: true })).toHaveCount(
    2,
  );
  await expect(runView.getByText('Attempt 0/4')).toHaveCount(0);
  await expect(runView.getByText('Job steps (0)')).toHaveCount(0);
  await expect(runView.getByText('Not needed', { exact: true })).toBeVisible();
  await assertLineFits();
  await capture('run-running');
  await runView.getByText('Provision details', { exact: true }).click();
  await expect(
    runView.getByText('Terraform apply', { exact: false }),
  ).toBeVisible();
  await expect(
    runView.getByRole('link', { name: /Open VM in catalog/ }),
  ).toHaveAttribute('href', '/catalog/default/resource/spec-vm');
  await runView.getByText('Provision details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    stages: snapshot.stages.map(s => {
      if (s.id === 'software')
        return {
          ...s,
          status: 'retrying',
          attempt: 3,
          startedAt: new Date(Date.now() - 80000).toISOString(),
          runUrl: 'https://github.com/example/platform/actions/runs/456',
          nextAttemptAt: new Date(Date.now() + 120000).toISOString(),
          error: 'Package mirror unavailable',
          attempts: [
            {
              attempt: 1,
              runUrl: 'https://github.com/example/platform/actions/runs/123',
              conclusion: 'failure',
              error: 'First failure',
              finishedAt: snapshot.updatedAt,
            },
          ],
        };
      if (['provision', 'baseline'].includes(s.id))
        return stage(s.id, 'success');
      return s;
    }),
  };
  await expect(runView.getByText(/^Retrying in \d+m \d+s/)).toBeVisible({
    timeout: 10000,
  });
  await capture('run-retrying');
  await runView.getByText('Software details', { exact: true }).click();
  await expect(
    runView.getByText('Earlier Attempts (1)', { exact: true }),
  ).toBeVisible();
  await expect(
    runView.getByText('First failure', { exact: true }),
  ).toBeVisible();
  await capture('run-expanded');
  await runView.getByText('Software details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    status: 'failed',
    error: 'Software failed',
    finishedAt: new Date().toISOString(),
    actions: { retry: true, skip: true },
    stages: snapshot.stages.map(s =>
      s.id === 'software'
        ? { ...s, status: 'failed', finishedAt: new Date().toISOString() }
        : s,
    ),
  };
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const stoppedReads = runReads;
  await capture('run-failed');
  await page.waitForTimeout(5500);
  if (runReads !== stoppedReads) throw new Error('Terminal run kept polling');
  actionError = true;
  await runView.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    runView.getByRole('button', { name: 'Retrying…', exact: true }),
  ).toBeDisabled();
  await expect(runView.getByRole('alert')).toHaveText(
    'Fixture conflict: stage changed',
  );
  actionError = false;
  const beforeDismiss = actionPosts;
  await runView.getByRole('button', { name: 'Skip', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  if (actionPosts !== beforeDismiss)
    throw new Error('Cancelled skip posted an action');
  await runView.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText(/work will not be applied/),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Skip Stage', exact: true })
    .click();
  await expect(
    runView.getByText('Skipped by amirasyraf', { exact: true }),
  ).toBeVisible();
  snapshot = {
    ...snapshot,
    status: 'failed',
    actions: { retry: true, skip: false },
  };
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await runView.getByRole('button', { name: 'Retry', exact: true }).click();
  await runView.getByText('Software details', { exact: true }).click();
  await expect(runView.getByText('Retried by amirasyraf')).toBeVisible();
  await runView.getByText('Software details', { exact: true }).click();
  snapshot = {
    ...snapshot,
    status: 'succeeded',
    error: null,
    finishedAt: new Date().toISOString(),
    stages: snapshot.stages.map(s => ({
      ...s,
      status: s.id === 'ad-join' ? 'skipped' : 'success',
      attempt: s.id === 'ad-join' ? 0 : Math.max(s.attempt, 1),
      startedAt:
        s.id === 'ad-join'
          ? null
          : s.startedAt ?? new Date(Date.now() - 30000).toISOString(),
      finishedAt: s.id === 'ad-join' ? null : new Date().toISOString(),
      error: null,
    })),
  };
  await expect(runView.getByRole('status', { name: 'Run status' })).toHaveText(
    'Completed',
    { timeout: 15000 },
  );
  await expect(
    runView.getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await capture('run-succeeded');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(runView).toBeVisible();
  if (
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
  )
    throw new Error('Run page overflows mobile viewport');
  assertNoErrors(errors);
  console.log(
    'RUN UI PASS: catalog-independent route, live polling, retry countdown, earlier attempts, terminal stop, action errors, skip confirmation/cancel, retry/skip resumption, success, mobile; stock task controls and no SSE (fixture APIs)',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const succeeded = snapshot;
  const cancelledAt = new Date(Date.now() - 60000).toISOString();
  snapshot = {
    ...succeeded,
    status: 'cancelled',
    finishedAt: cancelledAt,
    updatedAt: cancelledAt,
    stages: [
      stage('register', 'success'),
      {
        ...stage('provision', 'cancelled'),
        startedAt: new Date(Date.parse(cancelledAt) - 60000).toISOString(),
        finishedAt: null,
      },
    ],
  };
  await page.reload();
  await expect(
    page.getByLabel('Run stages').getByText('1m 0s', { exact: true }),
  ).toHaveCount(2);
  await capture('run-cancelled');
  snapshot = {
    ...succeeded,
    kind: 'modify',
    stages: [
      stage('configure', 'success'),
      stage('software', 'success'),
      stage('finalize', 'success'),
    ],
  };
  await page.reload();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(3);
  await expect(
    page.getByRole('heading', { name: 'Modify · spec-vm' }),
  ).toBeVisible();
  snapshot = {
    ...succeeded,
    kind: 'power',
    stages: [stage('stop', 'success')],
  };
  await page.reload();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: 'Stop · spec-vm' }),
  ).toBeVisible();
  snapshot = {
    ...succeeded,
    kind: 'destroy',
    stages: [stage('destroy', 'success'), stage('finalize', 'skipped')],
  };
  await page.reload();
  await expect(page.getByLabel('Pipeline stages').locator('li')).toHaveCount(2);
  snapshot = {
    ...succeeded,
    status: 'failed',
    stages: succeeded.stages.map(s =>
      s.id === 'software' ? { ...s, status: 'failed' } : s,
    ),
  };
  await page.goto(`${base}/catalog`);
  const kind = page
    .getByText('Kind', { exact: true })
    .locator('..')
    .getByRole('button');
  await expect(kind).toHaveText('Resource');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Resources', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Pipeline' }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Product' }),
  ).toBeVisible();
  await expect(page.getByLabel('Pipeline stages')).toBeVisible();
  await assertLineFits();
  await capture('resources');
  if (!summaryReads) throw new Error('Catalog did not load run summary');
  if (latestReads) throw new Error('List performed per-VM latest-run requests');
  await expect(
    page.getByText('Failed at Software', { exact: true }),
  ).toBeVisible();
  snapshot = succeeded;
  await expect(page.getByText('Catalog', { exact: true })).toHaveCount(0);
  await kind.click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(
    page.getByRole('option', { name: 'Resource', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`${base}/catalog?filters%5Bkind%5D=group`);
  await expect(kind).toHaveText('Resource');
  await expect(page).toHaveURL(/filters%5Bkind%5D=resource/);
  admin = true;
  await page.goto(`${base}/catalog`);
  await expect(kind).toHaveText('Resource');
  await kind.click();
  await expect(
    page.getByRole('option', { name: 'Group', exact: true }),
  ).toBeVisible();
  await page.getByRole('option', { name: 'Group', exact: true }).click();
  await expect(kind).toHaveText('Group');
  await page.goto(`${base}/catalog?filters%5Bkind%5D=user`);
  await expect(kind).toHaveText('User');
  noSummary = true;
  await page.goto(`${base}/catalog`);
  await expect(page.getByText('No run known', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  noSummary = false;
  assertNoErrors(errors);
  console.log(
    'CATALOG UI PASS: own header, VM state/pipeline columns, Resource default, normal-user Resource-only picker and deep links, admin kind selection and explicit links (fixture APIs)',
  );
  snapshot = {
    ...succeeded,
    status: 'running',
    finishedAt: null,
    stages: succeeded.stages.map(s =>
      s.id === 'software' ? { ...s, status: 'running', finishedAt: null } : s,
    ),
  };
  const beforeEntity = runReads;
  await page.goto(`${base}/catalog/default/resource/spec-vm`);
  await expect(page.getByText('Configuration', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pipeline stages')).toBeVisible();
  await expect(page.getByLabel('Run stages')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /View Run Details/ }),
  ).toBeVisible();
  await capture('entity-running');
  snapshot = {
    ...snapshot,
    status: 'failed',
    actions: { retry: true, skip: true },
    error: 'Software could not be installed',
    stages: snapshot.stages.map(s =>
      s.id === 'software'
        ? { ...s, status: 'failed', error: 'Package mirror unavailable' }
        : s,
    ),
  };
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await capture('entity-failed');
  await expect(
    page.getByText('Ubuntu 26.04 on AWS', { exact: true }),
  ).toBeVisible();
  for (const item of ['git', 'nginx'])
    await expect(page.getByText(item, { exact: true })).toBeVisible();
  // A run in progress leaves only Destroy.
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('M · t3.medium · 2 vCPU · 4 GiB · x86_64', { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByText('cost_center: CC-1234, environment: test', { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(5500);
  if (runReads !== beforeEntity)
    throw new Error(
      'Entity card duplicated latest-run polling with per-ID polling',
    );
  entityGone = true;
  snapshot = {
    ...succeeded,
    kind: 'destroy',
    stages: [stage('destroy', 'success'), stage('finalize', 'skipped')],
  };
  await expect(page.getByRole('status', { name: 'VM state' })).toHaveText(
    'Destroyed',
    { timeout: 15000 },
  );
  const afterRemoval = latestReads;
  await page.waitForTimeout(5500);
  if (latestReads !== afterRemoval)
    throw new Error('Removed VM kept polling runs');
  entityGone = false;
  snapshot = succeeded;
  assertNoErrors(errors);
  console.log(
    'VM SPEC UI PASS: desired configuration renders from spec without desired-input annotations (fixture APIs)',
  );
  // Day-2 actions: live state, confirmations and the requests they send.
  await page.goto(`${base}/catalog/default/resource/spec-vm`);
  const vmState = page.getByRole('status', { name: 'VM state' });
  await expect(vmState).toHaveText('Running');
  await expect(
    page.getByText('ssh ubuntu@203.0.113.42', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Modify' }).first(),
  ).toHaveAttribute(
    'href',
    /\/create\/templates\/default\/vm-modify\?formData=.*%22software%22%3A%5B%22git%22%2C%22nginx%22%5D/,
  );
  await capture('entity-running-vm');
  terminalOutput = ['Welcome to Ubuntu\r\nubuntu@spec-vm:~$ '];
  await page.getByRole('button', { name: 'Open Terminal' }).click();
  const terminalDialog = page.getByRole('dialog');
  await expect(
    terminalDialog.getByRole('status', { name: 'Terminal status' }),
  ).toHaveText('ubuntu@203.0.113.42');
  await expect(terminalDialog.locator('.xterm-rows')).toContainText(
    'ubuntu@spec-vm:~$',
  );
  await page.keyboard.type('hostname');
  await page.keyboard.press('Enter');
  await expect(terminalDialog.locator('.xterm-rows')).toContainText('spec-vm');
  await expect.poll(() => terminalInput).toBe('hostname\r');
  // A full screen must fit: the last row may not fall below the visible terminal box.
  terminalOutput.push(
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\r\n'),
  );
  await expect(terminalDialog.locator('.xterm-rows')).toContainText('line 100');
  const fits = await terminalDialog
    .getByLabel('Terminal', { exact: true })
    .evaluate(box => {
      const rows = box.querySelector('.xterm-rows').getBoundingClientRect();
      return rows.bottom <= box.getBoundingClientRect().bottom + 1;
    });
  if (!fits) throw new Error('Terminal rows overflow the visible box');
  await capture('entity-terminal');
  await terminalDialog
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect.poll(() => terminalClosed).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('public IP address');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (operations.length) throw new Error('Cancelled stop posted a run');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop VM', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (
    operations.length !== 1 ||
    operations[0].operation !== 'stop' ||
    operations[0].vm !== 'resource:default/spec-vm' ||
    !/^[0-9a-f-]{36}$/.test(operations[0].requestKey)
  )
    throw new Error(`Unexpected stop request: ${JSON.stringify(operations)}`);
  observed = instance('stopped');
  await expect(vmState).toHaveText('Stopped', { timeout: 20000 });
  await expect(page.getByText(/The VM is stopped/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reboot', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Modify', exact: true }),
  ).toBeDisabled();
  await capture('entity-stopped-vm');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Start VM', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if (operations.at(-1)?.operation !== 'start')
    throw new Error('Start did not post a start run');
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(
    page.getByRole('menuitem', { name: /Apply OS Updates/ }),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('menuitem', { name: 'Destroy VM' }).click();
  const confirmDestroy = page.getByRole('button', {
    name: 'Destroy VM',
    exact: true,
  });
  await expect(confirmDestroy).toBeDisabled();
  await page.getByLabel('Type spec-vm to confirm').fill('spec-vm');
  await confirmDestroy.click();
  await expect(page).toHaveURL(`${base}/vms/runs/42`);
  if (operations.at(-1)?.operation !== 'destroy')
    throw new Error('Destroy did not post a destroy run');
  observed = instance('running');
  operations = [];
  assertNoErrors(errors);
  console.log(
    'VM ACTIONS PASS: browser terminal (open, output, typed input, close), live Running/Stopped state, stop/start/destroy confirmations post day-2 runs with request keys, stopped VM disables reboot/modify/updates, Modify prefill (fixture APIs)',
  );
  listVms = [vm, otherResource];
  await page.goto(`${base}/`);
  await expect(
    page.getByRole('heading', { name: /^Good (Morning|Afternoon|Evening)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your Resources' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compute' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Other Resources' }),
  ).toBeVisible();
  const vmPanel = page.getByRole('button', {
    name: 'Virtual Machines',
    exact: true,
  });
  const otherPanel = page.getByRole('button', {
    name: 'Other Resources',
    exact: true,
  });
  const vmLink = page.getByRole('link', { name: /^spec-vm/ });
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'false');
  await expect(vmPanel.getByText('1 resource', { exact: true })).toBeVisible();
  await expect(vmLink).toHaveCount(0);
  await capture('home-collapsed');
  await vmPanel.focus();
  await page.keyboard.press('Enter');
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'true');
  await expect(vmLink).toHaveAttribute(
    'href',
    '/catalog/default/resource/spec-vm',
  );
  await expect(vmLink.getByText('AWS', { exact: true })).toBeVisible();
  await otherPanel.click();
  await expect(
    page.getByRole('link', { name: /^external-storage/ }),
  ).toBeVisible();
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Pipeline stages')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Demo Mode' })).toHaveCount(0);
  await capture('home-expanded');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    await page.locator('main').evaluate(el => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await vmPanel.focus();
  await page.keyboard.press('Space');
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'false');
  await expect(vmLink).toHaveCount(0);
  await vmPanel.click();
  await expect(vmLink).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  listVms = [];
  await page.goto(`${base}/`);
  await vmPanel.click();
  await expect(
    page.getByText('No resources in this product yet.'),
  ).toBeVisible();
  listVms = [vm];
  await page.getByRole('link', { name: 'View All Virtual Machines' }).click();
  await expect(page).toHaveURL(`${base}${vmProductPath}`);
  await expect(
    page.getByRole('heading', { name: 'Virtual Machines' }),
  ).toBeVisible();
  const demoPanel = page.getByRole('region', {
    name: 'Demo Mode',
    exact: true,
  });
  await expect(demoPanel.getByText('Demo Mode · Off')).toBeVisible();
  await demoPanel.getByLabel('Enable Demo Mode').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('button', { name: 'Enable and Apply Limits', exact: true })
    .click();
  await expect(demoPanel.getByText('Demo Mode · On')).toBeVisible();
  if (!demoSettings)
    throw new Error('Demo toggle did not use /vms/demo/settings');
  demoOn = false;
  const row = page.getByRole('row', { name: /spec-vm/ });
  await expect(row.getByLabel('Pipeline stages')).toBeVisible();
  await assertLineFits();
  await capture('virtual-machines');
  await expect(
    row.locator('[title="M · t3.medium · 2 vCPU · 4 GiB · x86_64"]'),
  ).toHaveCount(1);
  await expect(
    row.getByRole('link', { name: 'Get SSH Certificate' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Failed/ }).click();
  await expect(page.getByText('No machines match this filter.')).toBeVisible();
  assertNoErrors(errors);
  console.log(
    'HOME AND VM PRODUCT PASS: independent product panels, keyboard and mobile controls, resource counts/rows and empty state, plus VM pipeline and filters (fixture APIs)',
  );
  await page.goto(prefilled);
  const card = name => page.getByRole('radio', { name });
  for (const name of ['XS t3.micro', 'S t3.small', 'M t3.medium', 'L t3.large'])
    await expect(card(name)).toBeVisible();
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'true');
  await card('L t3.large').click();
  await expect(card('L t3.large')).toHaveAttribute('aria-checked', 'true');
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'false');
  // Advanced picker stays hidden until asked for.
  const types = page.getByRole('table', { name: 'AWS instance types' });
  await expect(types).toHaveCount(0);
  await page
    .getByRole('button', { name: /Advanced: Choose a Specific AWS/ })
    .click();
  await expect(types).toBeVisible();
  // Previous generation hidden by default; family grouping and category tabs.
  await expect(types.getByText('m4.large')).toHaveCount(0);
  await expect(
    types.getByText(/^m7i · General purpose · 2 types$/),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Accelerated computing/ }).click();
  await expect(types.getByText('g5.xlarge')).toBeVisible();
  await expect(types.getByText('m7i.large')).toHaveCount(0);
  await page.getByRole('tab', { name: /^All/ }).click();
  await page.getByLabel('Search instance types').fill('c7i');
  await expect(types.getByRole('radio')).toHaveCount(1);
  await page.getByLabel('Search instance types').fill('');
  await types.getByRole('radio', { name: 'm7i.large' }).check();
  await expect(page.getByText('Using instance type m7i.large')).toBeVisible();
  await expect(card('L t3.large')).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Use a Size Instead' }).click();
  await expect(card('S t3.small')).toHaveAttribute('aria-checked', 'true');
  // Tags: fixed, greyed-out cost_center/project_code keys with required values; optional rows.
  await expect(page.getByLabel('cost_center key')).toBeDisabled();
  await expect(page.getByLabel('project_code key')).toBeDisabled();
  await page.getByLabel('cost_center value').fill('CC-1');
  await page.getByLabel('project_code value').fill('');
  await page.getByLabel('project_code value').blur();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByLabel('Tag 1 key').fill('Cost_Center');
  await expect(page.getByText('Reserved key')).toBeVisible();
  await page.getByLabel('Tag 1 key').fill('environment');
  await expect(page.getByText('Reserved key')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove tag 1' }).click();
  await expect(page.getByLabel('Tag 1 key')).toHaveCount(0);
  // Demo mode: only t3.micro..t3.large selectable.
  demoOn = true;
  await page.reload();
  await page
    .getByRole('button', { name: /Advanced: Choose a Specific AWS/ })
    .click();
  await expect(types.getByRole('radio', { name: 'm7i.large' })).toBeDisabled();
  await expect(types.getByRole('radio', { name: 't3.micro' })).toBeEnabled();
  await expect(page.getByText(/Demo mode is on: only t3\.micro/)).toBeVisible();
  demoOn = false;
  assertNoErrors(errors);
  console.log(
    'VM SIZE + TAGS UI PASS: required billing tags and optional rows, size cards, advanced picker, demo restrictions, and launched type on VM detail and product pages (fixture APIs)',
  );
  // Launch: product, platform and image cards, then the template with platform/OS prefilled.
  await page.goto(`${base}/`);
  // The top bar's Launch (Home also has a Launch button).
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Launch', exact: true })
    .click();
  await expect(page).toHaveURL(`${base}/launch`);
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Create', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Launch a Product' }),
  ).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Compute/ })
    .click();
  await expect(page).toHaveURL(`${base}/launch/compute`);
  await page.getByRole('link', { name: /^Containers/ }).click();
  const containerLaunchUrl = `${base}/launch/compute/containers`;
  await expect(page).toHaveURL(containerLaunchUrl);
  await expect(
    page.getByRole('heading', { name: 'Choose a Platform' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Launch Steps' }).getByText('Image'),
  ).toHaveCount(0);
  for (const [id, label] of [
    ['azure', 'Azure'],
    ['aws', 'AWS'],
  ]) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(
      `${base}/create/templates/default/container-request?formData=${encodeURIComponent(
        JSON.stringify({ container: { platform: id } }),
      )}`,
    );
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Platform' })).toHaveCount(0);
    if (id === 'aws') {
      await assertRequestLayout([
        nameAndTeam,
        ['#root_container_port', '#root_container_arch'],
        ['#root_container_size', '#root_container_replicas'],
      ]);
      await capture('launch-configure-container');
    }
    await page.getByRole('link', { name: 'Change Platform' }).click();
    await expect(page).toHaveURL(containerLaunchUrl);
  }
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  console.log('CONTAINER LAUNCH UI PASS: platform cards and form prefill');
  await page.getByRole('link', { name: /^Virtual Machines/ }).click();
  await expect(page).toHaveURL(`${base}${vmLaunchPath}`);
  await expect(page.getByRole('button', { name: /vSphere/ })).toBeDisabled();
  await expect(page.getByText('Coming Soon')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'AWS', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Azure', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Ubuntu')).toHaveCount(0);
  await capture('launch-platform');
  await page.getByRole('link', { name: 'AWS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: 'Ubuntu 26.04' }),
  ).toBeDisabled();
  await expect(page.getByText('Not available', { exact: true })).toBeVisible();
  await page.goto(`${base}${vmLaunchPath}/aws?image=ubuntu%3A26.04`);
  await expect(
    page.getByRole('radio', { name: 'Ubuntu 26.04' }),
  ).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Ubuntu 24.04' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Ubuntu 24.04', { exact: true })).toBeVisible();
  await capture('launch-configure-vm');
  await page.getByRole('link', { name: 'Change', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Ubuntu 24.04' })).toBeChecked();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await page.getByRole('link', { name: 'Azure', exact: true }).click();
  await expect(page).toHaveURL(`${base}${vmLaunchPath}/azure`);
  await expect(
    page.getByRole('heading', { name: 'Choose an Image' }),
  ).toBeVisible();
  for (const [family, image] of [
    ['Linux Distributions', 'Ubuntu 26.04'],
    ['Windows', 'Windows Server 2025'],
  ]) {
    await expect(
      page.getByRole('region', { name: family }).getByRole('radio', { name: image }),
    ).toBeVisible();
  }
  // Two images (Ubuntu, Windows Server): nothing is preselected.
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: 'Windows Server 2025' }),
  ).toBeEnabled();
  await page.getByRole('radio', { name: 'Ubuntu 26.04' }).check();
  await capture('launch-image');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(
    /\/create\/templates\/default\/vm-request\?formData=/,
  );
  await expect(page.getByText('Azure', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change' })).toHaveAttribute(
    'href',
    `${vmLaunchPath}/azure?image=ubuntu%3A26.04`,
  );
  await expect(card('S Standard_D2s_v6')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(card('L Standard_D4s_v6')).toBeDisabled();
  await expect(page.getByText('Over vCPU quota').first()).toBeVisible();
  await page
    .getByRole('button', { name: /Advanced: Choose a Specific Azure/ })
    .click();
  const azureTypes = page.getByRole('table', { name: 'Azure instance types' });
  await expect(
    azureTypes.getByRole('radio', { name: 'Standard_B2s_v2' }),
  ).toBeDisabled();
  await expect(
    azureTypes.getByRole('radio', { name: 'Standard_D4s_v6' }),
  ).toBeEnabled();
  await expect(page.getByText('Current Generation Only')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByLabel('Tag 1 key').fill('azure-env');
  await expect(page.getByText('Reserved key')).toBeVisible();
  await page.getByLabel('Tag 1 key').fill('a/b');
  await expect(page.getByText('"/" is not allowed in keys')).toBeVisible();
  await page.getByLabel('Tag 1 key').fill('aws:x');
  await expect(page.getByText('Reserved key')).toHaveCount(0);
  // Software and memory minimum follow the OS family: Ubuntu, then Windows Server.
  await expect(page.getByRole('checkbox', { name: 'nginx' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'VS Code' })).toHaveCount(0);
  await expect(
    azureTypes.getByRole('radio', { name: 'Standard_B2ts_v2' }),
  ).toBeEnabled();
  await assertRequestLayout([nameAndTeam]);
  await capture('launch-configure');
  await page.getByRole('link', { name: 'Change', exact: true }).click();
  await page.getByRole('radio', { name: 'Windows Server 2025' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('Windows Server 2025', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'VS Code' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'nginx' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Git' }).check();
  await page
    .getByRole('button', { name: /Advanced: Choose a Specific Azure/ })
    .click();
  const windowsTypes = page.getByRole('table', {
    name: 'Azure instance types',
  });
  await expect(
    windowsTypes.getByRole('radio', { name: 'Standard_B2ts_v2' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Needs 4 GiB memory for this OS').first(),
  ).toBeVisible();
  await capture('launch-configure-windows');
  await page.goto(`${base}/launch/vm-request/azure`);
  await expect(page).toHaveURL(`${base}${vmLaunchPath}/azure`);
  assertNoErrors(errors);
  console.log(
    'LAUNCH UI PASS: Compute → Virtual Machines → platform → selectable OS release, prefill, Change and legacy link; Azure sizes, quota and tag rules; software and memory minimum per OS family (fixture APIs)',
  );
  const wording = [
    [
      'building-vm',
      'provision',
      'running',
      'provision',
      'running',
      'Building · Provision',
    ],
    [
      'updating-vm',
      'modify',
      'running',
      'software',
      'running',
      'Modifying · Software',
    ],
    ['stopping-vm', 'power', 'running', 'stop', 'running', 'Stopping'],
    ['stopped-vm', 'power', 'succeeded', 'stop', 'success', 'Stopped'],
    [
      'reboot-failed-vm',
      'power',
      'failed',
      'reboot',
      'failed',
      'Reboot failed',
    ],
    ['running-vm', 'provision', 'succeeded', 'finalize', 'success', 'Running'],
    ['destroying-vm', 'destroy', 'running', 'destroy', 'running', 'Destroying'],
    [
      'destroy-retry-vm',
      'destroy',
      'running',
      'destroy',
      'retrying',
      'Destroying · retrying',
    ],
    // finalize is still recording the failure, so the run itself is still running.
    [
      'finalizing-vm',
      'provision',
      'running',
      'software',
      'failed',
      'Failed at Software',
    ],
    [
      'retrying-vm',
      'modify',
      'running',
      'software',
      'retrying',
      'Modifying · Software · retrying',
    ],
    [
      'failed-vm',
      'provision',
      'failed',
      'software',
      'failed',
      'Failed at Software',
    ],
    [
      'attention-vm',
      'modify',
      'failed',
      'software',
      'pending',
      'Needs attention',
    ],
  ];
  listVms = wording.map(([name]) => ({
    ...vm,
    metadata: {
      ...vm.metadata,
      name,
      uid: name,
      annotations: Object.fromEntries(
        Object.entries(vm.metadata.annotations).filter(
          ([key]) => key !== 'cf/ready-at' || name === 'updating-vm',
        ),
      ),
    },
  }));
  summaryMatrix = wording.map(
    ([name, kind, status, active, stageStatus], index) => {
      const ids =
        kind === 'provision'
          ? [
              'servicenow',
              'register',
              'provision',
              'baseline',
              'software',
              'ad-join',
              'access',
              'finalize',
            ]
          : kind === 'modify'
          ? ['configure', 'software', 'finalize']
          : kind === 'power'
          ? [active]
          : ['destroy', 'finalize'];
      return {
        name,
        observed: instance(name === 'stopped-vm' ? 'stopped' : 'running'),
        latest: {
          ...succeeded,
          id: 100 + index,
          name,
          kind,
          status,
          finishedAt: status === 'failed' ? new Date().toISOString() : null,
          stages: ids.map((id, i) => ({
            ...stage(id, i < ids.indexOf(active) ? 'success' : 'pending'),
            ...(id === active
              ? {
                  status: stageStatus,
                  attempt: stageStatus === 'retrying' ? 2 : 1,
                  nextAttemptAt:
                    stageStatus === 'retrying'
                      ? new Date(Date.now() + 120000).toISOString()
                      : null,
                }
              : {}),
          })),
        },
      };
    },
  );
  for (const [route, screenshot] of [
    [vmProductPath, 'vm-product-wording'],
    ['/catalog', 'resources-wording'],
  ]) {
    await page.goto(`${base}${route}`);
    // Scope to each VM's row: the product's status filters reuse labels such as Destroying.
    for (const [name, , , , , label] of wording)
      await expect(
        page
          .getByRole('row')
          .filter({ hasText: name })
          .getByText(label, { exact: true }),
      ).toBeVisible();
    await expect(page.getByText(/^Ready since /).first()).toBeVisible();
    await expect(page.getByText(/^Requested /).first()).toBeVisible();
    await capture(screenshot);
  }
  listVms = [vm];
  summaryMatrix = undefined;
  console.log(
    'ROW WORDING PASS: provision, modify, power, destroy, retrying, failed and needs-attention labels; Running/Stopped from the health check; absolute ready/request times on Virtual Machines and Resources',
  );
  await page.goto(`${base}/`);
  const banner = page.getByText('A new version of Vendy is available.');
  const running = await page.evaluate(
    () =>
      /\/static\/main\.([0-9a-f]{8,})\.js/.exec(
        document.querySelector('script[src*="/static/main."]')?.src ?? '',
      )?.[1],
  );
  if (!running) {
    console.log('VERSION BANNER SKIPPED: unhashed dev-server bundle');
  } else {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    await expect(banner).toHaveCount(0);
    // Simulate a deploy: index.html now references a different bundle.
    await page.route(new URL('/', base).href, route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script defer src="/static/main.0123456789ab.js"></script>',
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(banner).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    assertNoErrors(errors);
    console.log(
      'VERSION BANNER PASS: hidden while current, shown after the deployed bundle changes',
    );
  }
} finally {
  await browser.close();
}

function assertNoErrors(errors) {
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
}
