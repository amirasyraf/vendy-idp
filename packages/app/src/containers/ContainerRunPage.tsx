import { useEffect, useState } from 'react';
import { Content, InfoCard, Link, Page, Progress } from '@backstage/core-components';
import { Button, Chip, makeStyles } from '@material-ui/core';
import { Route, Routes, useParams } from 'react-router-dom';
import type { RunView } from '@internal/plugin-vm-status';
import { STAGE_LABELS, useContainersApi } from './api';

const useStyles = makeStyles({
  stage: {
    display: 'grid',
    gridTemplateColumns: '220px 120px 1fr',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid #e5e7eb',
    alignItems: 'baseline',
  },
  error: { color: '#b42318', whiteSpace: 'pre-wrap' },
  muted: { color: '#667085' },
});

const COLORS: Record<string, 'default' | 'primary' | 'secondary'> = {
  running: 'primary',
  retrying: 'primary',
  failed: 'secondary',
};

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
        <p>
          <Link to={`/catalog/default/resource/${run.name}`}>Open container page →</Link>
        </p>
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
