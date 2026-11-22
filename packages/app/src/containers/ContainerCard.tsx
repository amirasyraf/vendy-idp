import { Fragment, useCallback, useEffect, useState } from 'react';
import { InfoCard, Link } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  TextField,
  makeStyles,
} from '@material-ui/core';
import type { RunView } from '@internal/plugin-vm-status';
import {
  ContainerConfig,
  ContainerStatus,
  SIZES,
  containerStatus,
  requestKey,
  useContainersApi,
} from './api';
import { RunStages } from './ContainerRunPage';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 6, marginBottom: 16 },
  label: { color: '#667085' },
  logs: {
    background: '#0f172a',
    color: '#e2e8f0',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    padding: 12,
    maxHeight: 360,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
  },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' },
  error: { color: '#b42318' },
});

function EditDialog({
  open,
  current,
  onClose,
  onSubmit,
}: {
  open: boolean;
  current: ContainerConfig;
  onClose: () => void;
  onSubmit: (spec: ContainerConfig) => void;
}) {
  const [spec, setSpec] = useState(current);
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSpec(current);
    setEnvText(Object.entries(current.env).map(([k, v]) => `${k}=${v}`).join('\n'));
  }, [current, open]);
  const submit = () => {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n').map(item => item.trim()).filter(Boolean)) {
      const at = line.indexOf('=');
      if (at < 1) {
        setError(`Expected KEY=value: ${line}`);
        return;
      }
      env[line.slice(0, at)] = line.slice(at + 1);
    }
    onSubmit({ ...spec, env });
  };
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Change container</DialogTitle>
      <DialogContent>
        <TextField fullWidth margin="dense" label="Image" value={spec.image}
          onChange={e => setSpec({ ...spec, image: e.target.value })} />
        <TextField fullWidth margin="dense" label="Container port" type="number" value={spec.port}
          onChange={e => setSpec({ ...spec, port: Number(e.target.value) })} />
        <TextField fullWidth margin="dense" select label="Size" value={spec.size}
          onChange={e => setSpec({ ...spec, size: e.target.value as ContainerConfig['size'] })}>
          {Object.entries(SIZES).map(([key, label]) => (
            <MenuItem key={key} value={key}>{`${key} — ${label}`}</MenuItem>
          ))}
        </TextField>
        <TextField fullWidth margin="dense" select label="Replicas" value={spec.replicas}
          onChange={e => setSpec({ ...spec, replicas: Number(e.target.value) })}>
          {[1, 2].map(n => <MenuItem key={n} value={n}>{n}</MenuItem>)}
        </TextField>
        <FormControlLabel
          control={<Checkbox checked={spec.public} onChange={e => setSpec({ ...spec, public: e.target.checked })} />}
          label="Public URL"
        />
        <TextField fullWidth margin="dense" multiline minRows={3} label="Environment (KEY=value per line; stored in a public repo — no secrets)"
          value={envText} onChange={e => setEnvText(e.target.value)} />
        {error && <p style={{ color: '#b42318' }}>{error}</p>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="primary" variant="contained" onClick={submit}>Apply</Button>
      </DialogActions>
    </Dialog>
  );
}

export function ContainerCard() {
  const classes = useStyles();
  const { entity } = useEntity();
  const api = useContainersApi();
  const name = entity.metadata.name;
  const ref = `resource:default/${name}`;
  const config = entity.spec?.container as ContainerConfig;
  const [status, setStatus] = useState<ContainerStatus>();
  const [runs, setRuns] = useState<RunView[]>([]);
  const [logs, setLogs] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextRuns] = await Promise.all([api.status(name), api.runs(name)]);
      setStatus(nextStatus);
      setRuns(nextRuns.runs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, name]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const operate = async (operation: 'modify' | 'restart' | 'destroy', spec?: ContainerConfig) => {
    setBusy(true);
    setError(undefined);
    try {
      const { runId } = await api.operate({ operation, container: ref, requestKey: requestKey(), spec });
      window.location.assign(`/containers/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const latest = runs[0];
  const state = containerStatus(latest, entity.metadata.annotations?.['cf/status']);
  const active = latest?.status === 'running';
  return (
    <InfoCard title="Container" subheader={`Status: ${state}`}>
      <div className={classes.grid}>
        <span className={classes.label}>URL</span>
        <span>
          {status?.url && <Link to={status.url}>{status.url}</Link>}
          {!status?.url && (config?.public === false ? 'Not public' : '—')}
        </span>
        <span className={classes.label}>Image</span>
        <span>{config?.image}</span>
        <span className={classes.label}>Runs on</span>
        <span>{`${config?.platform?.toUpperCase()} · ${config?.arch} · ${config?.size} (${SIZES[config?.size] ?? ''})`}</span>
        <span className={classes.label}>Replicas</span>
        <span>{status?.enabled ? `${status.ready ?? 0}/${status.replicas ?? config?.replicas} ready` : `${config?.replicas}`}</span>
        <span className={classes.label}>Port</span>
        <span>{config?.port}</span>
      </div>
      {status && !status.enabled && <p className={classes.error}>Cluster unavailable: {status.error}</p>}
      {status?.pods?.length ? (
        <div className={classes.grid}>
          {status.pods.map(pod => (
            <Fragment key={pod.name}>
              <span className={classes.label}>{pod.name.split('-').slice(-1)[0]}</span>
              <span>
                {`${pod.state}${pod.ready ? ', ready' : ''} · node ${pod.node ?? 'not scheduled yet'} · ${pod.restarts} restarts`}
              </span>
            </Fragment>
          ))}
        </div>
      ) : null}
      <div className={classes.actions}>
        <Button variant="outlined" disabled={busy || active} onClick={() => setEditing(true)}>Change</Button>
        <Button variant="outlined" disabled={busy || active || !status?.deployed} onClick={() => operate('restart')}>Restart</Button>
        <Button variant="outlined" disabled={busy} onClick={async () => {
          const result = await api.logs(name).catch(e => ({ pod: null, logs: (e as Error).message }));
          setLogs(result.pod ? `# ${result.pod}\n${result.logs || '(no output yet)'}` : 'No pod is running.');
        }}>Show logs</Button>
        <Button variant="outlined" color="secondary" disabled={busy} onClick={() => setConfirmDestroy(true)}>Delete</Button>
      </div>
      {error && <p className={classes.error}>{error}</p>}
      {logs !== undefined && <pre className={classes.logs}>{logs}</pre>}
      {latest && (
        <>
          <h3>
            Latest run: {latest.kind} — {latest.status}{' '}
            <Link to={`/containers/runs/${latest.id}`}>(details)</Link>
          </h3>
          <RunStages run={latest} />
        </>
      )}
      {config && (
        <EditDialog open={editing} current={config} onClose={() => setEditing(false)}
          onSubmit={spec => { setEditing(false); operate('modify', spec); }} />
      )}
      <Dialog open={confirmDestroy} onClose={() => setConfirmDestroy(false)}>
        <DialogTitle>Delete {name}?</DialogTitle>
        <DialogContent>The container is removed from the cluster and the inventory. This cannot be undone.</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDestroy(false)}>Cancel</Button>
          <Button color="secondary" variant="contained" onClick={() => { setConfirmDestroy(false); operate('destroy'); }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </InfoCard>
  );
}
