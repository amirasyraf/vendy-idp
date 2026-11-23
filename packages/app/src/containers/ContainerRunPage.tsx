import { useEffect, useState } from 'react';
import { Content, InfoCard, Link, Page, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Button, Chip, makeStyles } from '@material-ui/core';
import { Route, Routes, useParams } from 'react-router-dom';
import type { RunView } from '@internal/plugin-vm-status';
import { STAGE_LABELS, useContainersApi } from './api';

const useStyles = makeStyles({
  stage: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) auto minmax(0, 3fr)',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid #e5e7eb',
    alignItems: 'baseline',
    overflowWrap: 'anywhere',
    '@media (max-width: 620px)': {
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      rowGap: 4,
      '& > span:last-child': { gridColumn: '1 / -1' },
    },
  },
  error: { color: '#b42318', whiteSpace: 'pre-wrap' },
  muted: { color: '#667085' },
});

const COLORS: Record<string, 'default' | 'primary' | 'secondary'> = {
  running: 'primary',
  retrying: 'primary',
  failed: 'secondary',
};

function ContainerCatalogLink({ run }: { run: RunView }) {
  const classes = useStyles();
  const catalog = useApi(catalogApiRef);
  const [state, setState] = useState<
    'checking' | 'waiting' | 'visible' | 'missing' | 'unavailable'
  >('checking');
  const { name, requestId, status, kind, finishedAt } = run;
  const registered = run.stages.some(
    stage => stage.id === 'register' && stage.status === 'success',
  );

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    // A successful registration does not mean Backstage has processed the entity yet.
    const deadline =
      finishedAt && registered ? Date.parse(finishedAt) + 120_000 : 0;
    const shouldWait = () =>
      kind === 'provision' && (status === 'running' || Date.now() < deadline);

    const check = async () => {
      try {
        const entity = await catalog.getEntityByRef({
          kind: 'resource',
          namespace: 'default',
          name,
        });
        if (disposed) return;
        if (
          entity?.spec?.type === 'container' &&
          entity.metadata.annotations?.['cf/request-id'] === requestId
        ) {
          setState('visible');
          return;
        }
        setState(shouldWait() ? 'waiting' : 'missing');
      } catch {
        if (disposed) return;
        setState('unavailable');
      }
      if (shouldWait()) timer = window.setTimeout(check, 5000);
    };

    check();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [catalog, finishedAt, kind, name, registered, requestId, status]);

  if (state === 'visible') {
    return (
      <p>
        <Link to={`/catalog/default/resource/${encodeURIComponent(name)}`}>
          Open container page →
        </Link>
      </p>
    );
  }
  return (
    <p className={classes.muted} role="status">
      {state === 'checking' && 'Checking for the container page…'}
      {state === 'waiting' &&
        'Waiting for the container to appear in the catalog…'}
      {state === 'missing' && 'No catalog entry is available for this run.'}
      {state === 'unavailable' && 'Could not check the container catalog entry.'}
    </p>
  );
}

export function RunStages({ run }: { run: RunView }) {
  const classes = useStyles();
  return (
    <>
      {run.stages.map(stage => (
        <div key={stage.id} className={classes.stage}>
          <strong>{STAGE_LABELS[stage.id] ?? stage.id}</strong>
          <span>
            <Chip size="small" label={stage.status} color={COLORS[stage.status] ?? 'default'} />
          </span>
          <span>
            {stage.summary && <div>{stage.summary}</div>}
            {stage.error && <div className={classes.error}>{stage.error}</div>}
            {stage.attempt > 1 && (
              <div className={classes.muted}>
                attempt {stage.attempt} of {stage.maxAttempts}
              </div>
            )}
            {stage.runUrl && <Link to={stage.runUrl}>GitHub run</Link>}
          </span>
        </div>
      ))}
    </>
  );
}

function RunPage() {
  const { id } = useParams();
  const api = useContainersApi();
  const [run, setRun] = useState<RunView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await api.getRun(id!);
        if (disposed) return;
        setRun(next);
        setError(undefined);
        if (next.status === 'running') timer = window.setTimeout(load, 3000);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, id]);
  if (error && !run) return <Content>{error}</Content>;
  if (!run) return <Progress />;
  return (
    <Content>
      <InfoCard
        title={`${run.kind === 'provision' ? 'Deploy' : run.kind} ${run.name} — run #${run.id}`}
        subheader={`Status: ${run.status}${run.error ? ` — ${run.error}` : ''}`}
      >
        {!(run.kind === 'destroy' && run.status === 'succeeded') && (
          <ContainerCatalogLink key={`${run.name}:${run.requestId}`} run={run} />
        )}
        <RunStages run={run} />
        {run.actions.retry && (
          <Button
            variant="contained"
            color="primary"
            disabled={busy}
            style={{ marginTop: 16 }}
            onClick={async () => {
              setBusy(true);
              try {
                setRun(await api.retry(run.id));
                window.location.reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry failed stage
          </Button>
        )}
        {error && <p style={{ color: '#b42318' }}>{error}</p>}
      </InfoCard>
    </Content>
  );
}

export function ContainerRunsPage() {
  return (
    <Page themeId="tool">
      <Routes>
        <Route path="runs/:id" element={<RunPage />} />
        <Route path="*" element={<Content>Choose a container run from its container page.</Content>} />
      </Routes>
    </Page>
  );
}
