// Run after the image build. No AWS calls or workflow dispatches.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../plugins/cf-backend/src/passwords/index.js';

const run = promisify(execFile);
const password = randomUUID();
const normalUser = 'user1';
const users = Buffer.from(
  `amirasyraf:${await hashPassword(password)}\n${normalUser}:${await hashPassword(
    password,
  )}`,
).toString('base64');

const { stdout: imageId } = await run('docker', [
  'image',
  'inspect',
  '--format',
  '{{.Id}}',
  process.env.IDP_IMAGE ?? 'compute-factory-idp:latest',
]);
const image = imageId.trim();
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'cf-idp-smoke-')));
const configPath = join(scratch, 'app-config.smoke.local.yaml');
const caddyPath = join(scratch, 'Caddyfile');
const port = 17007;
const baseUrl = `http://localhost:${port}`;
const proxyPort = 17008;
const proxyUrl = `http://localhost:${proxyPort}`;
const token = 'local-smoke-static-catalog-token';
const containerName = `cf-idp-smoke-${process.pid}`;
const proxyName = `${containerName}-caddy`;
const networkName = `${containerName}-network`;
const config = {
  app: { baseUrl: proxyUrl },
  computeFactory: { mockServiceNowUrl: `${proxyUrl}/mock-rest/servicenow` },
  backend: {
    baseUrl: proxyUrl,
    listen: { port: 7007, host: '0.0.0.0' },
    cors: { origin: proxyUrl },
    auth: {
      externalAccess: [
        {
          type: 'static',
          options: { token, subject: 'smoke' },
          accessRestrictions: [{ plugin: 'catalog' }],
        },
      ],
    },
  },
  catalog: {
    locations: [
      'org.yaml',
      'locations.yaml',
      'templates/ssh-cert/template.yaml',
      'templates/bucket-request/template.yaml',
    ].map(file => ({ type: 'file', target: `/app/catalog/${file}` })),
  },
};
let child;
let done;
let exited = false;
try {
  // Contains only dummy local credentials, never the GitHub token.
  await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
  await run('docker', ['network', 'create', networkName]);
  child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      containerName,
      '--network',
      networkName,
      '--network-alias',
      'backstage',
      '--memory=2g',
      '--cpus=2',
      '-p',
      `127.0.0.1:${port}:7007`,
      '-p',
      `127.0.0.1:${proxyPort}:${proxyPort}`,
      '-e',
      'GITHUB_TOKEN',
      '-e',
      'IDP_USERS_B64',
      '-e',
      'NODE_ENV=development',
      '-v',
      `${configPath}:/app/app-config.smoke.local.yaml:ro`,
      image,
      'node',
      'packages/backend',
      '--config',
      'app-config.yaml',
      '--config',
      '/app/app-config.smoke.local.yaml',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, IDP_USERS_B64: users, NODE_ENV: 'development' },
    },
  );
  done = new Promise(resolveDone =>
    child.once('exit', code => {
      exited = true;
      resolveDone(code);
    }),
  );
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (exited) throw new Error('Backend exited before readiness');
    try {
      ready = (await fetch(`${baseUrl}/.backstage/health/v1/readiness`)).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('Backend readiness timed out');
  await run('docker', [
    'cp',
    `${containerName}:/app/deploy/Caddyfile`,
    caddyPath,
  ]);
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    proxyName,
    // Share loopback so both the browser and backend use the same public URL.
    '--network',
    `container:${containerName}`,
    '--memory=128m',
    '--cpus=0.5',
    '-e',
    `IDP_DOMAIN=http://:${proxyPort}`,
    '-v',
    `${caddyPath}:/etc/caddy/Caddyfile:ro`,
    'caddy:2',
  ]);
  ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ready = (await fetch(`${proxyUrl}/.backstage/health/v1/readiness`)).ok;
    } catch {
      /* proxy starting */
    }
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('Caddy readiness timed out');
  const requiredRefs = [
    'group:default/alpha',
    'group:default/bravo',
    'group:default/platform-admins',
    'user:default/amirasyraf',
    `user:default/${normalUser}`,
    'location:default/cf-vms',
    'template:default/ssh-cert',
    'template:default/bucket-request',
  ];
  let refs = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${baseUrl}/api/catalog/entities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(
        `Catalog HTTP ${response.status}: ${await response.text()}`,
      );
    refs = (await response.json()).map(
      entity =>
        `${entity.kind.toLowerCase()}:${
          entity.metadata.namespace ?? 'default'
        }/${entity.metadata.name}`,
    );
    if (
      [
        ...requiredRefs,
        'template:default/vm-request',
        'template:default/vm-modify',
      ].every(ref => refs.includes(ref))
    )
      break;
    await delay(1000);
  }
  for (const ref of requiredRefs) {
    if (!refs.includes(ref)) throw new Error(`Missing ${ref}`);
  }
  const launchTemplates = await fetch(
    `${baseUrl}/api/catalog/entities?filter=kind=template,metadata.tags=product`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (
    !launchTemplates.ok ||
    !(await launchTemplates.json()).some(
      entity => entity.metadata.name === 'bucket-request',
    )
  ) {
    throw new Error('Bucket template is not visible to the Launch picker');
  }
  const platformTemplates = refs.filter(ref =>
    /^template:default\/vm-/.test(ref),
  );
  const mockUrl = `${proxyUrl}/mock-rest/servicenow`;
  const payload = {
    vmName: 'rest-smoke',
    team: 'group:default/alpha',
    platform: 'aws',
    os: 'ubuntu',
    size: 'S',
  };
  const anonymous = await fetch(mockUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (anonymous.status !== 401)
    throw new Error(`Anonymous mock access: ${anonymous.status}`);
  const catalogOnly = await fetch(mockUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (catalogOnly.status !== 403)
    throw new Error(`Catalog-only token mock access: ${catalogOnly.status}`);
  const login = await fetch(`${proxyUrl}/api/auth/password/refresh`, {
    method: 'POST',
    headers: {
      Origin: proxyUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: 'amirasyraf', password }),
  });
  if (!login.ok) throw new Error(`Local login failed: ${login.status}`);
  const identity = (await login.json()).backstageIdentity;
  const userHeaders = {
    Authorization: `Bearer ${identity.token}`,
    'Content-Type': 'application/json',
  };
  // Real backend + database + signed identities, not mocked control APIs.
  const vmsBase = `${proxyUrl}/api/vms`;
  const demoBase = `${vmsBase}/demo`;
  const demo = await fetch(`${demoBase}/state`, { headers: userHeaders });
  const initialDemo = await demo.json();
  if (
    !demo.ok ||
    !initialDemo.isAdmin ||
    initialDemo.enabled ||
    initialDemo.automationAvailable
  )
    throw new Error(
      'Expected admin, default-off demo mode with local automation disabled',
    );
  const normalLogin = await fetch(`${proxyUrl}/api/auth/password/refresh`, {
    method: 'POST',
    headers: {
      Origin: proxyUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: normalUser, password }),
  });
  if (!normalLogin.ok) throw new Error('Normal-user smoke login failed');
  const normal = (await normalLogin.json()).backstageIdentity;
  const normalHeaders = {
    Authorization: `Bearer ${normal.token}`,
    'Content-Type': 'application/json',
  };
  const bucketsUrl = `${proxyUrl}/api/buckets`;
  const bucketsResponse = await fetch(bucketsUrl, { headers: normalHeaders });
  const buckets = await bucketsResponse.json();
  if (
    !bucketsResponse.ok ||
    buckets.buckets?.length !== 0 ||
    buckets.platforms?.aws !== false ||
    buckets.platforms?.azure !== false ||
    (await fetch(bucketsUrl)).status !== 401 ||
    (await fetch(`${bucketsUrl}/catalog`, { headers: normalHeaders })).status !==
      403
  )
    throw new Error(
      'Bucket inventory must require the right identity and run offline without cloud access',
    );
  const forbiddenToggle = await fetch(`${demoBase}/settings`, {
    method: 'POST',
    headers: normalHeaders,
    body: JSON.stringify({ enabled: true, generation: initialDemo.generation }),
  });
  if (forbiddenToggle.status !== 403)
    throw new Error('Normal user can change demo mode');
  const anonymousDemo = await fetch(`${demoBase}/state`);
  if (anonymousDemo.status !== 401)
    throw new Error('Anonymous demo state allowed');
  let generation = initialDemo.generation;
  for (const enabled of [true, false, true, false]) {
    const saved = await fetch(`${demoBase}/settings`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({ enabled, generation }),
    });
    if (!saved.ok) throw new Error(`Admin demo toggle HTTP ${saved.status}`);
    const current = await (
      await fetch(`${demoBase}/state`, { headers: userHeaders })
    ).json();
    if (current.enabled !== enabled || current.generation === generation)
      throw new Error('Demo settings not persisted/versioned');
    generation = current.generation;
  }
  const staleToggle = await fetch(`${demoBase}/settings`, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify({ enabled: true, generation: initialDemo.generation }),
  });
  if (staleToggle.status !== 409)
    throw new Error('Stale demo settings accepted');
  const disabledAutomation = await fetch(`${vmsBase}/requests`, {
    method: 'POST',
    headers: userHeaders,
    body: '{}',
  });
  if (disabledAutomation.status !== 503)
    throw new Error('Local smoke can launch real VMs');
  const disabledRun = await fetch(`${vmsBase}/runs`, {
    method: 'POST',
    headers: normalHeaders,
    body: '{}',
  });
  if (disabledRun.status !== 503)
    throw new Error('Local smoke can start VM day-2 runs');
  const observed = await fetch(`${vmsBase}/observed/spec-vm`, {
    headers: userHeaders,
  });
  const observedBody = await observed.json();
  if (
    !observed.ok ||
    observedBody.enabled !== false ||
    observedBody.vm !== null
  )
    throw new Error('Local smoke has a VM health check against AWS');
  const summary = await fetch(`${vmsBase}/summary`, { headers: userHeaders });
  const summaryBody = await summary.json();
  if (!summary.ok || !Array.isArray(summaryBody.vms))
    throw new Error(`Run summary HTTP ${summary.status}`);
  if ((await fetch(`${vmsBase}/summary`)).status !== 401)
    throw new Error('Anonymous run summary allowed');
  if (
    (await fetch(`${vmsBase}/runs/999999`, { headers: userHeaders })).status !==
    404
  )
    throw new Error('Unknown run did not return 404');
  if (
    (await fetch(`${vmsBase}/runs?name=Bad_Name`, { headers: userHeaders }))
      .status !== 400
  )
    throw new Error('Invalid run query accepted');
  const unknownRetry = await fetch(`${vmsBase}/runs/999999/retry`, {
    method: 'POST',
    headers: normalHeaders,
    body: '{}',
  });
  if (unknownRetry.status !== 404)
    throw new Error(`Retry of an unknown run: ${unknownRetry.status}`);
  console.log(
    'DEMO CONTROLS PASS: real admin toggles persisted, normal user denied, anonymous denied, stale generation rejected, local automation disabled; orchestrator read APIs authenticated, unknown runs 404',
  );
  const userAccess = await fetch(mockUrl, {
    method: 'POST',
    headers: userHeaders,
    body: JSON.stringify(payload),
  });
  if (userAccess.status !== 403)
    throw new Error(`Direct user mock access: ${userAccess.status}`);
  const browser = await run('node', ['scripts/workflow-ui.mjs'], {
    env: { ...process.env, WORKFLOW_UI_URL: proxyUrl },
    timeout: 180000,
  });
  console.log(browser.stdout);
  console.log(
    'SMOKE PASS',
    JSON.stringify({
      image,
      readiness: 200,
      refs,
      platformTemplates,
      mockRestAnonymous: anonymous.status,
      mockRestCatalogToken: catalogOnly.status,
      mockRestUser: userAccess.status,
    }),
  );
  if (platformTemplates.length !== 2)
    console.warn(
      'Platform templates not all available yet; see catalog processing logs.',
    );
} finally {
  await run('docker', ['stop', '-t', '5', proxyName]).catch(() => {});
  if (child && !exited) {
    await run('docker', ['stop', '-t', '10', containerName]).catch(() => {});
    await Promise.race([done, delay(10000, undefined, { ref: false })]);
    if (!exited) {
      await run('docker', ['rm', '-f', containerName]).catch(() => {});
      child.kill('SIGKILL');
      await done;
    }
  }
  await rm(scratch, { recursive: true, force: true });
  await run('docker', ['network', 'rm', networkName]).catch(() => {});
}
