// Signed-in, read-only check of the deployed IDP with real backend data. Never submits a form,
// dispatches a workflow or changes state. Credentials come from the orchestrator's gitignored
// .poc-passwords (POC only), e.g.:
//   CF_USER=user1 CF_PASSWORD="$(grep '^user1:' ../vendy/.poc-passwords | cut -d: -f2-)" \
//     mise exec -- node scripts/live-check.mjs
import { chromium, expect } from '@playwright/test';

const base = process.env.LIVE_URL ?? 'https://idp.amirasyraf.dev';
const user = process.env.CF_USER;
const password = process.env.CF_PASSWORD;
if (!user || !password) throw new Error('Set CF_USER and CF_PASSWORD');

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // VM rows can fetch these before the form mounts, and the form reuses that response.
  let sizesResult;
  page.on('response', response => {
    const url = new URL(response.url());
    if (
      url.pathname === '/api/vm-sizes/sizes' &&
      url.searchParams.get('platform') === 'aws'
    ) {
      sizesResult = response;
    }
  });

  await page.goto(base);
  await page.locator('input[name=username]').fill(user);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: /^Good (Morning|Afternoon|Evening)/ }),
  ).toBeVisible();
  console.log(`SIGN-IN PASS: ${user}`);

  await page.goto(`${base}/products/compute/containers`);
  await page.getByRole('link', { name: 'Deploy a Container' }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose a Platform' }),
  ).toBeVisible();
  for (const platform of ['Azure', 'AWS']) {
    await page.getByRole('link', { name: platform, exact: true }).click();
    await expect(page.getByText(platform, { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Platform' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Change Platform' }).click();
  }
  console.log('CONTAINER LAUNCH LIVE PASS: AWS and Azure selections reach the form');
  await page.goto(base);

  await expect(
    page.getByRole('heading', { name: 'Your Resources' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compute' })).toBeVisible();
  const vmPanel = page.getByRole('button', {
    name: 'Virtual Machines',
    exact: true,
  });
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'false');
  await vmPanel.click();
  await expect(vmPanel).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('link', { name: 'View All Virtual Machines' }).click();
  await expect(
    page.getByRole('heading', { name: 'Virtual Machines' }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Launch a Virtual Machine' })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'Choose a Platform' }),
  ).toBeVisible();
  await expect(page.getByText('Ubuntu')).toHaveCount(0);
  for (const platform of ['Azure', 'AWS']) {
    await page.getByRole('link', { name: platform, exact: true }).click();
    const image = page.getByRole('radio', { name: 'Ubuntu 26.04' });
    await expect(image).toBeEnabled();
    await image.check();
    if (platform === 'Azure') {
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(
        page.getByText('Ubuntu 26.04', { exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Change', exact: true }).click();
      await expect(image).toBeChecked();
      await page.getByRole('link', { name: 'Back', exact: true }).click();
    }
  }
  // Real vm-sizes endpoint: AWS sizes.json from GitHub plus live EC2 specs.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Ubuntu 26.04', { exact: true })).toBeVisible();
  console.log(
    'PRODUCT UI PASS: grouped Home, Virtual Machines, AWS and Azure image selection and form prefill',
  );
  await expect.poll(() => Boolean(sizesResult), { timeout: 30000 }).toBe(true);
  const sizes = await sizesResult.json();
  if (sizes.error) throw new Error(`vm-sizes error: ${sizes.error}`);
  for (const item of sizes.sizes) {
    if (!item.specs?.vcpus || !item.specs?.memoryMiB)
      throw new Error(`No AWS specs for ${item.size} (${item.instanceType})`);
  }
  for (const item of sizes.sizes) {
    await expect(
      page.getByRole('radio', { name: `${item.size} ${item.instanceType}` }),
    ).toBeVisible();
  }
  console.log(
    `VM SIZE LIVE PASS: ${sizes.sizes
      .map(
        item =>
          `${item.size}=${item.instanceType} (${item.specs.vcpus} vCPU, ${
            item.specs.memoryMiB / 1024
          } GiB)`,
      )
      .join(', ')}`,
  );

  // Advanced picker: the real region catalog from AWS (x86_64 types offered here).
  const catalogResponse = page.waitForResponse(response =>
    response.url().includes('/api/vm-sizes/instance-types'),
  );
  await page
    .getByRole('button', { name: /Advanced: Choose a Specific AWS/ })
    .click();
  const catalog = await (await catalogResponse).json();
  if (!Array.isArray(catalog.types) || catalog.types.length < 50)
    throw new Error(
      `Instance-type catalog too small: ${JSON.stringify(catalog).slice(
        0,
        300,
      )}`,
    );
  const types = page.getByRole('table', { name: 'AWS instance types' });
  await expect(types.getByRole('radio', { name: 't3.micro' })).toBeVisible();
  const demoOn = (await page.getByText(/Demo mode is on: only/).count()) > 0;
  const blocked = catalog.types.find(
    item => item.currentGeneration && !item.type.startsWith('t3.'),
  );
  if (demoOn && blocked)
    await expect(
      types.getByRole('radio', { name: blocked.type }),
    ).toBeDisabled();
  console.log(
    `ADVANCED PICKER LIVE PASS: ${catalog.types.length} types in ${
      catalog.region
    }, ${
      new Set(catalog.types.map(item => item.family)).size
    } families; demo mode ${
      demoOn ? `on, ${blocked?.type} greyed out` : 'off'
    }`,
  );

  // Task page delivery: the newest own task must load events by long polling, not SSE.
  const polls = [];
  page.on('request', request => {
    if (/\/v2\/tasks\/[^/]+\/(events|eventstream)/.test(request.url()))
      polls.push(new URL(request.url()).pathname.split('/').pop());
  });
  await page.goto(`${base}/create/tasks`);
  const taskLink = page.locator('a[href*="/create/tasks/"]').first();
  await taskLink.waitFor({ timeout: 15000 }).catch(() => {});
  if (await taskLink.count()) {
    await taskLink.click();
    await expect
      .poll(() => polls.length, { timeout: 15000 })
      .toBeGreaterThan(0);
    if (polls.includes('eventstream')) throw new Error('Task page used SSE');
    console.log('TASK PAGE LIVE PASS: events delivered by long polling');
  } else {
    console.log('TASK PAGE LIVE SKIPPED: no tasks for this user');
  }

  // Orchestrator run page: the newest visible VM run, read-only (never presses Retry/Skip).
  const summary = await page.evaluate(async () => {
    const response = await fetch('/api/vms/summary', {
      headers: {
        Authorization: `Bearer ${
          (
            await (
              await fetch('/api/auth/password/refresh', {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
              })
            ).json()
          ).backstageIdentity.token
        }`,
      },
    });
    return response.ok ? response.json() : { vms: [], status: response.status };
  });
  if (!Array.isArray(summary.vms))
    throw new Error(`Run summary failed: ${summary.status}`);
  const latest = summary.vms
    .map(vm => vm.latest)
    .sort((a, b) => b.id - a.id)[0];
  if (latest) {
    await page.goto(`${base}/vms/runs/${latest.id}`);
    const stages = page.getByRole('list', { name: 'Run stages' });
    await expect(stages).toBeVisible();
    await expect(stages.getByRole('listitem')).toHaveCount(
      latest.stages.length,
    );
    console.log(
      `RUN PAGE LIVE PASS: run #${latest.id} (${latest.kind} ${latest.name}, ${latest.status}) shows ${latest.stages.length} stages`,
    );
  } else {
    console.log('RUN PAGE LIVE SKIPPED: no VM runs visible to this user');
  }

  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
} finally {
  await browser.close();
}
