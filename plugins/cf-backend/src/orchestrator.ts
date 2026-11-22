import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { GitHubError, github, message, rejected, runHtmlUrl } from './github';

// Stage order, retries and run state live here; GitHub Actions only executes one stage per
// dispatch (platform repo `stage.yml`). See CONTRACTS.md §6 and §8.2.

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
export type RunKind =
  | 'provision'
  | 'modify'
  | 'reapply'
  | 'power'
  | 'update'
  | 'destroy';
type RunStatus = 'running' | 'failed' | 'succeeded' | 'cancelled';
type StageStatus =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type Run = {
  id: number;
  kind: RunKind;
  name: string;
  team: string;
  request_id: string;
  request_key: string | null;
  requested_by: string;
  requester_teams: string;
  params: string;
  status: RunStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};
type Stage = {
  run_id: number;
  stage: string;
  position: number;
  status: StageStatus;
  attempt: number;
  budget_start: number;
  max_attempts: number;
  next_attempt_at: number | null;
  dispatched_at: number | null;
  gha_run_id: string | null;
  conclusion: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  skippable: boolean;
  skipped_by: string | null;
  retried_by: string | null;
  outcome: 'ready' | 'failed' | null;
  summary: string | null;
  steps: string;
  attempts: string;
};
type Attempt = {
  attempt: number;
  runUrl: string | null;
  conclusion: string;
  error: string | null;
  finishedAt: string;
};
type GitHubRun = {
  id: number;
  display_title: string;
  status: string;
  conclusion: string | null;
};
type GitHubJobs = {
  jobs: {
    name: string;
    steps?: { name: string; status: string; conclusion: string | null }[];
  }[];
};

const SKIPPABLE = ['software', 'ad-join'];
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [30_000, 120_000, 480_000];
const DEADLINE_MS = 45 * 60_000;
const SEARCH_AFTER_MS = 20_000;
const DISPATCH_GRACE_MS = 3 * 60_000;

/** A product's run and stage tables. VMs keep their original table names. */
export type RunTables = { runs: string; stages: string };
export const VM_TABLES: RunTables = { runs: 'vm_runs', stages: 'vm_run_stages' };

export class RunConflict extends Error {}

const iso = (value: number | null) =>
  value === null ? null : new Date(Number(value)).toISOString();
const parse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const numeric = <T extends Record<string, any>>(row: T, keys: string[]): T => {
  const copy: Record<string, any> = { ...row };
  for (const key of keys)
    if (copy[key] !== null && copy[key] !== undefined)
      copy[key] = Number(copy[key]);
  return copy as T;
};
const runRow = (row: Run) =>
  numeric(row, ['id', 'created_at', 'updated_at', 'finished_at']);
const stageRow = (row: Stage) =>
  numeric(row, [
    'run_id',
    'position',
    'attempt',
    'budget_start',
    'max_attempts',
    'next_attempt_at',
    'dispatched_at',
    'started_at',
    'finished_at',
  ]);

export async function initializeOrchestrator(
  db: Database,
  T: RunTables = VM_TABLES,
) {
  if (!(await db.schema.hasTable(T.runs))) {
    await db.schema.createTable(T.runs, table => {
      table.increments('id').primary();
      table.string('kind').notNullable();
      table.string('name').notNullable().index();
      table.string('team').notNullable();
      table.string('request_id').notNullable();
      table.string('request_key').nullable().unique();
      table.string('requested_by').notNullable();
      table.text('requester_teams').notNullable();
      table.text('params').notNullable();
      table.string('status').notNullable().index();
      table.text('error').nullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.bigInteger('finished_at').nullable();
    });
  }
  if (!(await db.schema.hasTable(T.stages))) {
    await db.schema.createTable(T.stages, table => {
      table.integer('run_id').notNullable();
      table.string('stage').notNullable();
      table.integer('position').notNullable();
      table.string('status').notNullable();
      table.integer('attempt').notNullable().defaultTo(0);
      table.integer('budget_start').notNullable().defaultTo(0);
      table.integer('max_attempts').notNullable();
      table.bigInteger('next_attempt_at').nullable();
      table.bigInteger('dispatched_at').nullable();
      table.string('gha_run_id').nullable();
      table.string('conclusion').nullable();
      table.bigInteger('started_at').nullable();
      table.bigInteger('finished_at').nullable();
      table.text('error').nullable();
      table.boolean('skippable').notNullable();
      table.string('skipped_by').nullable();
      table.string('retried_by').nullable();
      table.string('outcome').nullable();
      table.text('steps').notNullable();
      table.text('attempts').notNullable();
      table.primary(['run_id', 'stage']);
    });
  }
  if (!(await db.schema.hasColumn(T.stages, 'summary'))) {
    await db.schema.alterTable(T.stages, table => {
      table.text('summary').nullable();
    });
  }
}

/**
 * A stage that runs inside the IDP instead of as a workflow dispatch. It returns a one-line
 * summary; throw an error with `permanent: true` to fail without automatic retries. Handlers must
 * be idempotent per run: an attempt interrupted by a restart is run again.
 *
 * A handler that must wait for something outside the IDP returns `{ waiting }` instead: the
 * attempt stays running, the text is shown as its summary, and the handler is called again on the
 * next tick until it returns a summary, throws, or the attempt passes `waitDeadlineMs`.
 */
export type InProcessStage = (
  run: Run,
) => Promise<string | { waiting: string }>;
const WAITING = 'Waiting: ';

/** One planned stage: whether it applies to this run, and whether a failed attempt may be skipped. */
export type PlannedStage = { stage: string; applies: boolean; skippable?: boolean };

export type NewRun = {
  kind: RunKind;
  name: string;
  team: string;
  requestId: string;
  requestKey: string;
  requestedBy: string;
  requesterTeams: string[];
  params: Record<string, unknown>;
};

function vmPlan(kind: RunKind, params: Record<string, any>): PlannedStage[] {
  let stages: PlannedStage[];
  if (kind === 'provision') {
    const configuration = params.spec?.configuration ?? {};
    stages = [
      { stage: 'servicenow', applies: true },
      { stage: 'register', applies: true },
      { stage: 'provision', applies: true },
      { stage: 'baseline', applies: true },
      {
        stage: 'software',
        applies:
          Array.isArray(configuration.software) &&
          configuration.software.length > 0,
      },
      { stage: 'ad-join', applies: configuration.adJoin === true },
      { stage: 'access', applies: true },
      { stage: 'finalize', applies: true },
    ];
  } else if (kind === 'modify') {
    // Desired-state change: persist it, then apply only what changed.
    const changes = params.changes ?? {};
    stages = [
      { stage: 'configure', applies: true },
      { stage: 'provision', applies: changes.compute === true },
      { stage: 'software', applies: changes.software === true },
      { stage: 'ad-join', applies: changes.adJoin === true },
      { stage: 'finalize', applies: true },
    ];
  } else if (kind === 'reapply') {
    // Repair drift: run every applicable fry stage again against the persisted spec.
    const configuration = params.configuration ?? {};
    stages = [
      { stage: 'baseline', applies: true },
      {
        stage: 'software',
        applies:
          Array.isArray(configuration.software) &&
          configuration.software.length > 0,
      },
      { stage: 'ad-join', applies: configuration.adJoin === true },
      { stage: 'access', applies: true },
      { stage: 'finalize', applies: true },
    ];
  } else if (kind === 'power') {
    // start | stop | reboot. Power and OS updates never change cf/status, so no finalize.
    stages = [{ stage: params.action, applies: true }];
  } else if (kind === 'update') {
    stages = [{ stage: 'os-update', applies: true }];
  } else {
    stages = [
      { stage: 'destroy', applies: true },
      // Failure path only; skipped when destroy succeeds (inventory is gone).
      { stage: 'finalize', applies: true },
    ];
  }
  return stages.map(item => ({
    ...item,
    skippable:
      (kind === 'provision' || kind === 'reapply') &&
      SKIPPABLE.includes(item.stage),
  }));
}

/** The workflow inputs' `params_json` for a VM stage. */
function vmStageParams(
  stage: string,
  params: Record<string, any>,
  outcome: string | null,
): Record<string, unknown> {
  if (stage === 'register') return { spec: params.spec };
  if (stage === 'configure')
    return { compute: params.compute, configuration: params.configuration };
  if (stage === 'software' && params.remove?.length)
    return { remove: params.remove };
  if (stage === 'destroy' && params.demoGeneration)
    return { demoGeneration: params.demoGeneration };
  if (stage === 'finalize') return { outcome };
  return {};
}

function stageRows(planned: PlannedStage[]) {
  return planned.map(({ stage, applies, skippable }, position) => ({
    stage,
    position,
    status: (applies ? 'pending' : 'skipped') as StageStatus,
    attempt: 0,
    budget_start: 0,
    max_attempts: MAX_ATTEMPTS,
    skippable: skippable === true,
    steps: '[]',
    attempts: '[]',
  }));
}

export function createOrchestrator(options: {
  db: Database;
  logger: LoggerService;
  appBaseUrl: string;
  inProcess: Record<string, InProcessStage>;
  onFinished?: (run: Run) => void;
  /** Product hooks; the defaults are the VM product. */
  tables?: RunTables;
  workflow?: string;
  label?: string;
  /** App route under which `<base>/runs/<id>` shows a run. */
  basePath?: string;
  plan?: (kind: RunKind, params: Record<string, any>) => PlannedStage[];
  stageParams?: (
    stage: string,
    params: Record<string, any>,
    outcome: string | null,
  ) => Record<string, unknown>;
  /** How long an in-process stage may keep returning `{ waiting }` in one attempt. */
  waitDeadlineMs?: number;
}) {
  const { db, logger, inProcess } = options;
  const T = options.tables ?? VM_TABLES;
  const workflow = options.workflow ?? 'stage.yml';
  const label = options.label ?? 'VM';
  const plan = options.plan ?? vmPlan;
  const stageParams = options.stageParams ?? vmStageParams;
  const waitDeadline = options.waitDeadlineMs ?? 15 * 60_000;
  const runUrl = (id: number) =>
    `${options.appBaseUrl}${options.basePath ?? '/vms'}/runs/${id}`;

  const getRun = async (id: number) => {
    const row = await db<Run>(T.runs).where({ id }).first();
    return row ? runRow(row) : undefined;
  };
  const getStages = async (id: number) =>
    (
      await db<Stage>(T.stages).where({ run_id: id }).orderBy('position')
    ).map(stageRow);
  const touch = (id: number, patch: Partial<Run> = {}) =>
    db<Run>(T.runs)
      .where({ id })
      .update({ ...patch, updated_at: Date.now() });
  const updateStage = (stage: Stage, patch: Partial<Stage>) => {
    Object.assign(stage, patch);
    return db<Stage>(T.stages)
      .where({ run_id: stage.run_id, stage: stage.stage })
      .update(patch);
  };
  // Move the finished attempt into history before the stage is reset or re-dispatched.
  const archive = (stage: Stage): Partial<Stage> => {
    if (!stage.conclusion) return {};
    const attempts = parse<Attempt[]>(stage.attempts, []);
    attempts.push({
      attempt: stage.attempt,
      runUrl: stage.gha_run_id ? runHtmlUrl(stage.gha_run_id) : null,
      conclusion: stage.conclusion,
      error: stage.error,
      finishedAt: iso(stage.finished_at ?? Date.now())!,
    });
    return { attempts: JSON.stringify(attempts), conclusion: null };
  };

  /** Cancel a run's remaining stages and the run itself, inside the caller's transaction. */
  async function cancel(run: Run, reason: string, trx: Database) {
    await trx<Stage>(T.stages)
      .where({ run_id: run.id })
      .whereIn('status', ['pending', 'running', 'retrying'])
      .update({ status: 'cancelled', next_attempt_at: null });
    await trx<Run>(T.runs).where({ id: run.id }).update({
      status: 'cancelled',
      error: reason,
      finished_at: Date.now(),
      updated_at: Date.now(),
    });
    logger.info(
      `${label} run ${run.id} (${run.kind} ${run.name}) cancelled: ${reason}`,
    );
  }

  /**
   * Create a run (cancelling the runs it supersedes) in one transaction, or return the existing
   * run for the same request key. Pass `trx` to commit together with the caller's own writes.
   * Callers serialize.
   */
  async function createRun(
    input: NewRun,
    trx?: Database,
  ): Promise<{ run: Run; created: boolean }> {
    const work = async (t: Database) => {
      const existing = await t<Run>(T.runs)
        .where({ request_key: input.requestKey })
        .first();
      if (existing) return { run: runRow(existing), created: false };
      const active = (
        await t<Run>(T.runs)
          .where({ name: input.name })
          .whereIn('status', ['running', 'failed'])
      ).map(runRow);
      // Destroy supersedes everything; any other run supersedes only a failed day-2 run. A running
      // run, or an incomplete (failed) provision, must be retried, skipped or destroyed first.
      const blocking = active.find(
        run =>
          input.kind !== 'destroy' &&
          (run.status === 'running' || run.kind === 'provision'),
      );
      if (blocking)
        throw new RunConflict(
          `${label} ${input.name} already has an active ${blocking.kind} run (#${blocking.id}); retry, skip or destroy it first`,
        );
      const now = Date.now();
      const [inserted] = await t<Run>(T.runs)
        .insert({
          kind: input.kind,
          name: input.name,
          team: input.team,
          request_id: input.requestId,
          request_key: input.requestKey,
          requested_by: input.requestedBy,
          requester_teams: input.requesterTeams.join(','),
          params: JSON.stringify(input.params),
          status: 'running',
          error: null,
          created_at: now,
          updated_at: now,
          finished_at: null,
        })
        .returning('id');
      const id = Number(
        typeof inserted === 'object'
          ? (inserted as { id: number }).id
          : inserted,
      );
      await t(T.stages).insert(
        stageRows(plan(input.kind, input.params)).map(stage => ({
          ...stage,
          run_id: id,
        })),
      );
      for (const run of active)
        await cancel(run, `Superseded by ${input.kind} run #${id}`, t);
      logger.info(
        `${label} run ${id} created: ${input.kind} ${input.name} by ${input.requestedBy}`,
      );
      return {
        run: runRow((await t<Run>(T.runs).where({ id }).first())!),
        created: true,
      };
    };
    return trx ? work(trx) : db.transaction(work);
  }

  function inputsFor(run: Run, stage: Stage, attempt: number) {
    const params = parse<Record<string, any>>(run.params, {});
    return {
      stage: stage.stage,
      name: run.name,
      request_id: run.request_id,
      run_key: `${run.id}.${stage.stage}.${attempt}`,
      requested_by: run.requested_by,
      requester_teams: run.requester_teams,
      params_json: JSON.stringify(
        stageParams(stage.stage, params, stage.outcome),
      ),
    };
  }

  async function attemptFailed(
    run: Run,
    stage: Stage,
    conclusion: string,
    error: string,
    permanent: boolean,
  ) {
    const used = stage.attempt - stage.budget_start;
    const final = permanent || used >= stage.max_attempts;
    const now = Date.now();
    await updateStage(stage, {
      status: final ? 'failed' : 'retrying',
      conclusion,
      error,
      finished_at: now,
      next_attempt_at: final ? null : now + BACKOFF_MS[Math.min(used, 3) - 1],
    });
    let outcome = `retrying in ${Math.round(
      BACKOFF_MS[Math.min(used, 3) - 1] / 1000,
    )}s`;
    if (permanent) outcome = 'permanent; not retrying';
    else if (final) outcome = 'retries exhausted';
    logger.warn(
      `${label} run ${run.id} ${run.name} stage ${stage.stage} attempt ${stage.attempt} ${conclusion}: ${error} (${outcome})`,
    );
  }

  async function begin(run: Run, stage: Stage) {
    const attempt = stage.attempt + 1;
    const now = Date.now();
    await updateStage(stage, {
      ...archive(stage),
      status: 'running',
      attempt,
      dispatched_at: now,
      gha_run_id: null,
      next_attempt_at: null,
      started_at: stage.started_at ?? now,
      finished_at: null,
      error: null,
      steps: '[]',
      summary: null,
      outcome: stage.outcome,
    });
    await touch(run.id);
    return attempt;
  }

  async function execute(
    run: Run,
    stage: Stage,
    handler: InProcessStage,
    resume = false,
  ) {
    const attempt = resume ? stage.attempt : await begin(run, stage);
    try {
      if (resume && Date.now() - Number(stage.dispatched_at) > waitDeadline)
        throw new Error(
          `${(stage.summary ?? '').slice(WAITING.length) || 'Still waiting'} after ${Math.round(
            waitDeadline / 60_000,
          )} minutes`,
        );
      const summary = await handler(run);
      if (typeof summary !== 'string') {
        const text = `${WAITING}${summary.waiting}`;
        if (text !== stage.summary) {
          await updateStage(stage, { summary: text });
          await touch(run.id);
        }
        return;
      }
      await updateStage(stage, {
        status: 'success',
        conclusion: 'success',
        summary,
        error: null,
        finished_at: Date.now(),
      });
      logger.info(
        `${label} run ${run.id} ${run.name} stage ${stage.stage} attempt ${attempt} succeeded: ${summary}`,
      );
    } catch (error) {
      const permanent = (error as { permanent?: boolean })?.permanent === true;
      await attemptFailed(run, stage, 'error', message(error), permanent);
    }
  }

  async function dispatch(run: Run, stage: Stage) {
    // Persist the attempt (and its run key) before dispatching, so a crash or lost
    // response is recovered by finding the run, not by dispatching blindly again.
    const attempt = await begin(run, stage);
    try {
      const result = await github<{ workflow_run_id?: number }>(
        `/actions/workflows/${workflow}/dispatches`,
        {
          ref: 'main',
          inputs: inputsFor(run, stage, attempt),
          return_run_details: true,
        },
      );
      if (Number.isSafeInteger(result?.workflow_run_id)) {
        await updateStage(stage, {
          gha_run_id: String(result!.workflow_run_id),
        });
        logger.info(
          `${label} run ${run.id} ${run.name} stage ${
            stage.stage
          } attempt ${attempt}: GitHub run ${result!.workflow_run_id}`,
        );
      } else {
        logger.warn(
          `${label} run ${run.id} stage ${stage.stage}: dispatch returned no run ID; recovering by run key`,
        );
      }
    } catch (error) {
      if (rejected(error)) {
        await attemptFailed(
          run,
          stage,
          'dispatch_rejected',
          message(error),
          true,
        );
        return;
      }
      logger.warn(
        `${label} run ${run.id} stage ${
          stage.stage
        }: dispatch outcome uncertain (${message(
          error,
        )}); recovering by run key`,
      );
    }
  }

  async function recover(run: Run, stage: Stage) {
    const age = Date.now() - Number(stage.dispatched_at);
    if (age < SEARCH_AFTER_MS) return;
    const key = `[${run.id}.${stage.stage}.${stage.attempt}]`;
    const result = await github<{ workflow_runs: GitHubRun[] }>(
      `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`,
    );
    const found = result?.workflow_runs.find(item =>
      item.display_title.endsWith(key),
    );
    if (found) {
      await updateStage(stage, { gha_run_id: String(found.id) });
      logger.info(
        `${label} run ${run.id} stage ${stage.stage}: recovered GitHub run ${found.id}`,
      );
    } else if (age > DISPATCH_GRACE_MS) {
      await attemptFailed(
        run,
        stage,
        'dispatch_failed',
        'The stage dispatch could not be confirmed',
        false,
      );
    }
  }

  async function poll(run: Run, stage: Stage) {
    if (!stage.gha_run_id) {
      await recover(run, stage);
      return;
    }
    const overdue = Date.now() - Number(stage.dispatched_at) > DEADLINE_MS;
    let ghRun: GitHubRun | undefined;
    let jobs: GitHubJobs | undefined;
    try {
      ghRun = await github<GitHubRun>(`/actions/runs/${stage.gha_run_id}`);
      jobs = await github<GitHubJobs>(
        `/actions/runs/${stage.gha_run_id}/jobs?per_page=100`,
      );
    } catch (error) {
      // GitHub outages, rate limits and the brief 404 after dispatch: keep waiting.
      if (!overdue) {
        if (!(error instanceof GitHubError && error.status === 404))
          logger.warn(
            `${label} run ${run.id} stage ${stage.stage}: ${message(error)}`,
          );
        return;
      }
    }
    const list = jobs?.jobs ?? [];
    const steps = list.flatMap(job =>
      (job.steps ?? []).map(step => ({
        name: list.length > 1 ? `${job.name}: ${step.name}` : step.name,
        status:
          step.status === 'completed'
            ? step.conclusion ?? 'completed'
            : step.status,
      })),
    );
    if (jobs && JSON.stringify(steps) !== stage.steps)
      await updateStage(stage, { steps: JSON.stringify(steps) });
    if (ghRun?.status === 'completed' && jobs) {
      if (ghRun.conclusion === 'success') {
        await updateStage(stage, {
          status: 'success',
          conclusion: 'success',
          error: null,
          finished_at: Date.now(),
        });
        logger.info(
          `${label} run ${run.id} ${run.name} stage ${stage.stage} succeeded`,
        );
        return;
      }
      const conclusion = ghRun.conclusion ?? 'failure';
      const failedStep = steps.find(step =>
        ['failure', 'timed_out', 'cancelled'].includes(step.status),
      );
      const invalid = list.some(job =>
        (job.steps ?? []).some(
          step =>
            step.name === 'Validate inputs' && step.conclusion === 'failure',
        ),
      );
      await attemptFailed(
        run,
        stage,
        conclusion,
        invalid
          ? 'Validation failed; see the GitHub run for the reason'
          : `GitHub run ${conclusion}${
              failedStep ? ` at step "${failedStep.name}"` : ''
            }`,
        invalid || conclusion === 'startup_failure',
      );
      return;
    }
    if (overdue) {
      await github(`/actions/runs/${stage.gha_run_id}/cancel`, {}).catch(
        error =>
          logger.warn(
            `Cancel GitHub run ${stage.gha_run_id}: ${message(error)}`,
          ),
      );
      await attemptFailed(
        run,
        stage,
        'timed_out',
        'The stage did not finish within 45 minutes',
        false,
      );
    }
  }

  async function finish(run: Run, status: RunStatus, error: string | null) {
    await touch(run.id, { status, error, finished_at: Date.now() });
    run.status = status;
    options.onFinished?.(run);
    logger.info(
      `${label} run ${run.id} (${run.kind} ${run.name}) ${status}${
        error ? `: ${error}` : ''
      }`,
    );
  }

  // One step of the state machine; returns true when it made progress worth re-evaluating now.
  async function advanceRun(run: Run): Promise<boolean> {
    const stages = await getStages(run.id);
    // Power and OS-update runs have no finalize stage.
    const finalize = stages.find(stage => stage.stage === 'finalize');
    const failed = stages.find(
      stage => stage.status === 'failed' && stage.stage !== 'finalize',
    );
    let current: Stage | undefined;
    if (failed) {
      if (
        !finalize ||
        ['success', 'failed', 'skipped', 'cancelled'].includes(finalize.status)
      ) {
        await finish(
          run,
          'failed',
          `Stage ${failed.stage} failed: ${failed.error}`,
        );
        return false;
      }
      if (finalize.status === 'pending')
        await updateStage(finalize, { outcome: 'failed' });
      current = finalize;
    } else if (finalize?.status === 'failed') {
      await finish(run, 'failed', `Stage finalize failed: ${finalize.error}`);
      return false;
    } else {
      current = stages.find(
        stage => !['success', 'skipped'].includes(stage.status),
      );
      if (!current) {
        await finish(run, 'succeeded', null);
        return false;
      }
      if (finalize && current === finalize && finalize.status === 'pending') {
        if (run.kind === 'destroy') {
          await updateStage(finalize, { status: 'skipped' });
          return true;
        }
        await updateStage(finalize, { outcome: 'ready' });
      }
    }
    const before = current.status;
    const handler = inProcess[current.stage];
    const due =
      current.status === 'pending' ||
      (current.status === 'retrying' &&
        Number(current.next_attempt_at) <= Date.now());
    if (handler) {
      const waiting =
        current.status === 'running' &&
        (current.summary ?? '').startsWith(WAITING);
      // Other in-process attempts finish within the tick; `running` then means a restart
      // interrupted one. A waiting attempt is simply checked again.
      if (current.status === 'running' && !waiting)
        // Keep the interrupted attempt in the history before starting the next one.
        await updateStage(current, {
          conclusion: 'interrupted',
          error: 'Interrupted by an IDP restart',
          finished_at: Date.now(),
        });
      if (waiting) await execute(run, current, handler, true);
      else if (due || current.status === 'running')
        await execute(run, current, handler);
    } else if (due) await dispatch(run, current);
    else if (current.status === 'running') await poll(run, current);
    return (
      current.status !== before &&
      ['success', 'failed', 'skipped'].includes(current.status)
    );
  }

  async function tick() {
    const runs = (
      await db<Run>(T.runs).where({ status: 'running' }).orderBy('id')
    ).map(runRow);
    for (const run of runs) {
      try {
        for (let i = 0; i < 12 && run.status === 'running'; i++)
          if (!(await advanceRun(run))) break;
      } catch (error) {
        logger.warn(`${label} run ${run.id} ${run.name}: ${message(error)}`);
      }
    }
  }

  async function failedTarget(run: Run) {
    const stages = await getStages(run.id);
    const failed =
      stages.find(
        stage => stage.status === 'failed' && stage.stage !== 'finalize',
      ) ?? stages.find(stage => stage.status === 'failed');
    return { stages, failed };
  }

  // Reset the target (and finalize) and reopen the run in one transaction.
  async function reopen(
    run: Run,
    stages: Stage[],
    target: Stage,
    patch: Partial<Stage>,
  ) {
    const finalize = stages.find(stage => stage.stage === 'finalize');
    await db.transaction(async trx => {
      const set = (stage: Stage, values: Partial<Stage>) =>
        trx<Stage>(T.stages)
          .where({ run_id: stage.run_id, stage: stage.stage })
          .update(values);
      await set(target, { ...archive(target), ...patch });
      if (finalize && finalize !== target && finalize.status !== 'pending')
        await set(finalize, {
          ...archive(finalize),
          status: 'pending',
          outcome: null,
          budget_start: finalize.attempt,
          error: null,
          finished_at: null,
          next_attempt_at: null,
        });
      await trx<Run>(T.runs).where({ id: run.id }).update({
        status: 'running',
        error: null,
        finished_at: null,
        updated_at: Date.now(),
      });
    });
  }

  async function retry(run: Run, user: string) {
    if (run.status !== 'failed')
      throw new RunConflict('Only a failed run can be retried');
    const { stages, failed } = await failedTarget(run);
    if (!failed) throw new RunConflict('No failed stage to retry');
    await reopen(run, stages, failed, {
      status: 'pending',
      budget_start: failed.attempt,
      retried_by: user,
      error: null,
      finished_at: null,
      next_attempt_at: null,
    });
    logger.info(
      `${label} run ${run.id} ${run.name}: ${user} retried stage ${failed.stage}`,
    );
  }

  async function skip(run: Run, user: string) {
    if (run.status !== 'failed')
      throw new RunConflict('Only a failed run can skip a stage');
    const { stages, failed } = await failedTarget(run);
    if (!failed?.skippable)
      throw new RunConflict(
        `Stage ${
          failed?.stage ?? 'unknown'
        } cannot be skipped; only software and AD join can`,
      );
    await reopen(run, stages, failed, {
      status: 'skipped',
      skipped_by: user,
      error: null,
      finished_at: Date.now(),
      next_attempt_at: null,
    });
    logger.info(
      `${label} run ${run.id} ${run.name}: ${user} skipped stage ${failed.stage}`,
    );
  }

  async function view(run: Run, allowed: boolean) {
    const stages = await getStages(run.id);
    const failed =
      stages.find(
        stage => stage.status === 'failed' && stage.stage !== 'finalize',
      ) ?? stages.find(stage => stage.status === 'failed');
    const actionable = run.status === 'failed' && allowed && Boolean(failed);
    return {
      id: run.id,
      kind: run.kind,
      name: run.name,
      team: run.team,
      requestId: run.request_id,
      requestedBy: run.requested_by,
      status: run.status,
      error: run.error,
      createdAt: iso(run.created_at)!,
      updatedAt: iso(run.updated_at)!,
      finishedAt: iso(run.finished_at),
      actions: {
        retry: actionable,
        skip:
          actionable &&
          Boolean(failed?.skippable) &&
          failed?.stage !== 'finalize',
      },
      stages: stages.map(stage => ({
        id: stage.stage,
        status: stage.status,
        attempt: stage.attempt,
        maxAttempts: stage.budget_start + stage.max_attempts,
        nextAttemptAt:
          stage.status === 'retrying' ? iso(stage.next_attempt_at) : null,
        startedAt: iso(stage.started_at),
        finishedAt: iso(stage.finished_at),
        error: stage.error,
        skippable: Boolean(stage.skippable),
        skippedBy: stage.skipped_by,
        retriedBy: stage.retried_by,
        outcome: stage.stage === 'finalize' ? stage.outcome : null,
        summary: stage.summary ?? null,
        runUrl: stage.gha_run_id ? runHtmlUrl(stage.gha_run_id) : null,
        steps: parse<{ name: string; status: string }[]>(stage.steps, []),
        attempts: parse<Attempt[]>(stage.attempts, []),
      })),
    };
  }

  return {
    runUrl,
    getRun,
    createRun,
    cancel,
    tick,
    retry,
    skip,
    view,
    async findByRequestKey(requestKey: string) {
      const row = await db<Run>(T.runs)
        .where({ request_key: requestKey })
        .first();
      return row ? runRow(row) : undefined;
    },
    async runsFor(name: string, limit: number) {
      return (
        await db<Run>(T.runs)
          .where({ name })
          .orderBy('id', 'desc')
          .limit(limit)
      ).map(runRow);
    },
    async latestRuns() {
      const latest = db<Run>(T.runs).max('id').groupBy('name');
      return (
        await db<Run>(T.runs).whereIn('id', latest).orderBy('name')
      ).map(runRow);
    },
    /** Request ID -> `spec.compute.platform`, from each VM incarnation's provision run. */
    async platforms(requestIds: string[]) {
      const rows = await db<Run>(T.runs)
        .where({ kind: 'provision' })
        .whereIn('request_id', requestIds)
        .select('request_id', 'params');
      return new Map(
        rows.map(row => [
          row.request_id,
          String(
            parse<Record<string, any>>(row.params, {})?.spec?.compute
              ?.platform ?? '',
          ),
        ]),
      );
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
