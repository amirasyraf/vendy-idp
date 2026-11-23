import { ReactNode, useEffect, useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { InfoCard, Link } from '@backstage/core-components';
import { useAsyncEntity, useEntity } from '@backstage/plugin-catalog-react';
import type { EntityHeaderLayoutProps } from '@backstage/plugin-catalog-react/alpha';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  makeStyles,
} from '@material-ui/core';
import MoreHoriz from '@material-ui/icons/MoreHoriz';
import {
  ComputeDetailColumns,
  ComputeEntityHeader,
  vmColors,
  type RunView,
} from '@internal/plugin-vm-status';
import { useNavigate } from 'react-router-dom';
import { containers, productPath } from '../products/catalog';
import {
  ContainerConfig,
  SIZES,
  containerStatus,
  requestKey,
  useContainersApi,
} from './api';
import { RunStages } from './ContainerRunPage';
import { useContainerLive } from './useContainerLive';

const useStyles = makeStyles(theme => ({
  facts: {
    margin: 0,
    '& > div': {
      display: 'grid',
      gridTemplateColumns: '110px minmax(0, 1fr)',
      gap: 12,
      padding: '7px 0',
      borderTop: `1px solid ${theme.palette.divider}`,
    },
    '& > div:first-child': { borderTop: 0, paddingTop: 0 },
    '& dt': { color: vmColors.mute, fontSize: 12.5 },
    '& dd': { margin: 0, fontSize: 13.5, overflowWrap: 'anywhere' },
  },
  endpoint: { margin: '0 0 12px', overflowWrap: 'anywhere' },
  muted: { color: vmColors.mute, fontSize: 13.5, margin: 0 },
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
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  error: { color: vmColors.redText, margin: '8px 0 0' },
  activity: { listStyle: 'none', margin: 0, padding: 0 },
  activityRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 12,
    alignItems: 'baseline',
    padding: '9px 0',
    borderTop: `1px solid ${theme.palette.divider}`,
    fontSize: 13.5,
    '&:first-child': { borderTop: 0 },
  },
  activityMeta: { color: vmColors.mute, fontSize: 12.5 },
  stages: { marginBottom: 16 },
}));

const states: Record<string, { label: string; color: string }> = {
  ready: { label: 'Ready', color: vmColors.green },
  deploying: { label: 'Deploying', color: vmColors.blue },
  failed: { label: 'Failed', color: vmColors.red },
  destroying: { label: 'Deleting', color: vmColors.grey },
  destroyed: { label: 'Deleted', color: vmColors.grey },
  unknown: { label: 'Status unknown', color: vmColors.grey },
};

const runLabels: Partial<Record<RunView['kind'], string>> = {
  provision: 'Deploy',
  modify: 'Modify',
  power: 'Restart',
  destroy: 'Delete',
};
const runStates: Record<RunView['status'], string> = {
  running: 'In progress',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function cloud(config?: ContainerConfig) {
  if (!config?.platform) return '—';
  return config.platform === 'azure' ? 'Azure' : 'AWS';
}

function EditDialog({
  open,
  current,
  onClose,
  onSubmit,
  submitting,
  submitError,
}: {
  open: boolean;
  current: ContainerConfig;
  onClose: () => void;
  onSubmit: (spec: ContainerConfig) => void;
  submitting: boolean;
  submitError?: string;
}) {
  const [spec, setSpec] = useState(current);
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSpec(current);
    setEnvText(Object.entries(current.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
    setError(undefined);
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
    <Dialog open={open} onClose={() => !submitting && onClose()} fullWidth maxWidth="sm" aria-labelledby="container-edit-title">
      <DialogTitle id="container-edit-title">Modify Container</DialogTitle>
      <DialogContent>
        <TextField id="container-edit-image" fullWidth margin="dense" label="Image" value={spec.image}
          onChange={e => setSpec({ ...spec, image: e.target.value })} />
        <TextField id="container-edit-port" fullWidth margin="dense" label="Container port" type="number" value={spec.port}
          onChange={e => setSpec({ ...spec, port: Number(e.target.value) })} />
        <TextField id="container-edit-size" fullWidth margin="dense" select label="Size" value={spec.size}
          onChange={e => setSpec({ ...spec, size: e.target.value as ContainerConfig['size'] })}>
          {Object.entries(SIZES).map(([key, label]) => (
            <MenuItem key={key} value={key}>{`${key} — ${label}`}</MenuItem>
          ))}
        </TextField>
        <TextField id="container-edit-replicas" fullWidth margin="dense" select label="Replicas" value={spec.replicas}
          onChange={e => setSpec({ ...spec, replicas: Number(e.target.value) })}>
          {[1, 2].map(n => <MenuItem key={n} value={n}>{n}</MenuItem>)}
        </TextField>
        <FormControlLabel
          control={<Checkbox checked={spec.public} onChange={e => setSpec({ ...spec, public: e.target.checked })} />}
          label="Public URL"
        />
        <TextField id="container-edit-environment" fullWidth margin="dense" multiline minRows={3} label="Environment (KEY=value per line; stored in a public repo — no secrets)"
          value={envText} onChange={e => setEnvText(e.target.value)} />
        {(error || submitError) && <p role="alert" style={{ color: vmColors.redText }}>{error || submitError}</p>}
      </DialogContent>
      <DialogActions>
        <Button disabled={submitting} onClick={onClose}>Cancel</Button>
        <Button disabled={submitting} color="primary" variant="contained" onClick={submit}>Apply</Button>
      </DialogActions>
    </Dialog>
  );
}

export function ContainerHeaderLayout(props: EntityHeaderLayoutProps) {
  const { entity } = useAsyncEntity();
  if (!entity) return <></>;
  return <ContainerHeader key={stringifyEntityRef(entity)} {...props} />;
}

function ContainerHeader(props: EntityHeaderLayoutProps) {
  const classes = useStyles();
  const { entity } = useEntity();
  const api = useContainersApi();
  const navigate = useNavigate();
  const name = entity.metadata.name;
  const config = entity.spec?.container as ContainerConfig | undefined;
  const { runs, status } = useContainerLive(name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<'restart' | 'destroy'>();
  const [typed, setTyped] = useState('');
  const latest = runs?.[0];
  const active = latest?.status === 'running';
  const deleted = latest?.kind === 'destroy' && latest.status === 'succeeded';
  const state = deleted
    ? 'destroyed'
    : containerStatus(latest, entity.metadata.annotations?.['cf/status']);
  const team = String(entity.spec?.owner ?? '').split('/').pop() || '—';

  const openConfirm = (operation: 'restart' | 'destroy') => {
    setMenu(null);
    setTyped('');
    setError(undefined);
    setConfirm(operation);
  };

  const operate = async (operation: 'modify' | 'restart' | 'destroy', spec?: ContainerConfig) => {
    setBusy(true);
    setError(undefined);
    try {
      const { runId } = await api.operate({
        operation,
        container: stringifyEntityRef(entity),
        requestKey: requestKey(),
        spec,
      });
      setConfirm(undefined);
      navigate(`/containers/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const destroying = latest?.kind === 'destroy' && active;
  return (
    <>
      <ComputeEntityHeader
        {...props}
        entity={entity}
        productName={containers.title}
        productHref={productPath(containers)}
        sectionLabel="Container sections"
        state={{
          ...(states[state] ?? states.unknown),
          name: 'Container state',
          failed: state === 'failed',
        }}
        metadata={
          <>
            <li>Team <b>{team}</b></li>
            {config && (
              <>
                <li>{config.image}</li>
                <li>{cloud(config)} · {config.arch} · {config.size}</li>
              </>
            )}
          </>
        }
        actions={
          !deleted && !destroying && (
            <div className={classes.actions} role="group" aria-label="Container actions">
              <Button
                variant="outlined"
                disabled={busy || active || !status?.deployed}
                onClick={() => openConfirm('restart')}
              >
                Restart
              </Button>
              <Button
                variant="outlined"
                disabled={busy || active || !config}
                onClick={() => { setError(undefined); setEditing(true); }}
              >
                Modify
              </Button>
              <IconButton
                aria-label="More container actions"
                aria-haspopup="menu"
                aria-expanded={Boolean(menu)}
                onClick={event => setMenu(event.currentTarget)}
              >
                <MoreHoriz />
              </IconButton>
              <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
                <MenuItem disabled={busy} onClick={() => openConfirm('destroy')}>
                  Delete Container
                </MenuItem>
              </Menu>
            </div>
          )
        }
      />
      {config && editing && (
        <EditDialog
          open={editing}
          current={config}
          onClose={() => setEditing(false)}
          onSubmit={spec => operate('modify', spec)}
          submitting={busy}
          submitError={error}
        />
      )}
      <Dialog open={Boolean(confirm)} onClose={() => !busy && setConfirm(undefined)} aria-labelledby="container-action-title">
        <DialogTitle id="container-action-title">{confirm === 'destroy' ? 'Delete' : 'Restart'} {name}?</DialogTitle>
        <DialogContent>
          {confirm === 'destroy' ? (
            <>
              <p>This removes the container from the cluster and inventory. It cannot be undone.</p>
              <TextField
                id="container-delete-name"
                fullWidth
                variant="outlined"
                label={`Type ${name} to confirm`}
                value={typed}
                onChange={event => setTyped(event.target.value)}
              />
            </>
          ) : (
            <p>Restart the running pods for this container.</p>
          )}
          {error && <p role="alert" className={classes.error}>{error}</p>}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</Button>
          <Button
            color={confirm === 'destroy' ? 'secondary' : 'primary'}
            variant="contained"
            disabled={busy || (confirm === 'destroy' && typed !== name)}
            onClick={() => confirm && operate(confirm)}
          >
            {confirm === 'destroy' ? 'Delete Container' : 'Restart Container'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function timestamp(iso?: string | null) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
    </time>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  const classes = useStyles();
  return (
    <dl className={classes.facts}>
      {rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

export function ContainerOverview() {
  const { entity } = useEntity();
  return <ContainerDetails key={stringifyEntityRef(entity)} />;
}

function ContainerDetails() {
  const classes = useStyles();
  const { entity } = useEntity();
  const name = entity.metadata.name;
  const api = useContainersApi();
  const { runs, status, error } = useContainerLive(name);
  const [logs, setLogs] = useState<string>();
  const [logsError, setLogsError] = useState<string>();
  const [loadingLogs, setLoadingLogs] = useState(false);
  const config = entity.spec?.container as ContainerConfig | undefined;
  const annotations = entity.metadata.annotations ?? {};
  const latest = runs?.[0];
  const inProgress = latest?.status === 'running' || latest?.status === 'failed';
  const location = annotations['backstage.io/managed-by-origin-location'] ?? '';
  const source =
    annotations['backstage.io/view-url'] ??
    (location.startsWith('url:') ? location.slice(4) : undefined);
  const tags = entity.spec?.billing as { costCenter?: string; projectCode?: string } | undefined;
  const inventoryTags = {
    cost_center: tags?.costCenter,
    project_code: tags?.projectCode,
    ...((entity.spec?.cloudTags ?? {}) as Record<string, string>),
  };
  const requested = timestamp(annotations['cf/requested-at']);
  const loadLogs = async () => {
    setLoadingLogs(true);
    setLogsError(undefined);
    try {
      const result = await api.logs(name);
      setLogs(result.pod ? `# ${result.pod}\n${result.logs || '(no output yet)'}` : 'No pod is running.');
    } catch (e) {
      setLogsError((e as Error).message);
    } finally {
      setLoadingLogs(false);
    }
  };

  return (
    <ComputeDetailColumns
      primary={
        <>
          <InfoCard title="Connect" titleTypographyProps={{ component: 'h2' }}>
            {status?.url ? (
              <p className={classes.endpoint}><Link to={status.url}>{status.url}</Link></p>
            ) : (
              <p className={classes.endpoint}>
                {config?.public === false ? 'This container has no public URL.' : 'No public URL is available yet.'}
              </p>
            )}
            <Button variant="outlined" disabled={loadingLogs} onClick={loadLogs}>
              {loadingLogs ? 'Loading Logs…' : 'Show Logs'}
            </Button>
            {logsError && <p role="alert" className={classes.error}>{logsError}</p>}
            {logs !== undefined && <pre className={classes.logs}>{logs}</pre>}
          </InfoCard>
          <InfoCard title="Activity" titleTypographyProps={{ component: 'h2' }}>
            {error && <p role="alert" className={classes.error}>{error}</p>}
            {inProgress && latest && (
              <div className={classes.stages}>
                <RunStages run={latest} />
              </div>
            )}
            {runs?.length ? (
              <ul className={classes.activity}>
                {runs.map(run => (
                  <li key={run.id} className={classes.activityRow}>
                    <div>
                      <Link to={`/containers/runs/${run.id}`}>{runLabels[run.kind] ?? run.kind}</Link>
                      {' · '}{runStates[run.status]}
                      <div className={classes.activityMeta}>
                        Run #{run.id} · {run.requestedBy.split('/').pop()}
                      </div>
                    </div>
                    <span className={classes.activityMeta}>{timestamp(run.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : !error && (
              <p className={classes.muted}>{runs ? 'No runs yet.' : 'Loading activity…'}</p>
            )}
          </InfoCard>
        </>
      }
      details={
        <>
          <InfoCard title="Configuration" titleTypographyProps={{ component: 'h2' }}>
            <Facts rows={[
              ['Image', config?.image],
              ['Platform', cloud(config)],
              ['Architecture', config?.arch],
              ['Size', config && `${config.size} · ${SIZES[config.size]}`],
              ['Container Port', config?.port],
              ['Replicas', config?.replicas],
              ['Public URL', config && (config.public ? 'Enabled' : 'Disabled')],
              ['Tags', Object.entries(inventoryTags).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(', ') || '—'],
            ]} />
          </InfoCard>
          <InfoCard title="Details" titleTypographyProps={{ component: 'h2' }}>
            {status && !status.enabled && (
              <p className={classes.error}>Cluster unavailable: {status.error}</p>
            )}
            <Facts rows={[
              ['Replicas Ready', status?.enabled ? `${status.ready ?? 0}/${status.replicas ?? config?.replicas ?? 0}` : '—'],
              ['Requested', requested && <>{annotations['cf/requested-by'] && `${annotations['cf/requested-by']} · `}{requested}</>],
              ['First Ready', timestamp(annotations['cf/ready-at'])],
              ['Lifecycle', entity.spec?.lifecycle as string | undefined],
              ['Inventory', source && <Link to={source}>View Source</Link>],
              ...(status?.pods ?? []).map((pod): [string, ReactNode] => [
                `Pod ${pod.name.split('-').pop()}`,
                `${pod.state}${pod.ready ? ', ready' : ''} · ${pod.node ?? 'not scheduled yet'} · ${pod.restarts} restarts`,
              ]),
            ]} />
          </InfoCard>
        </>
      }
    />
  );
}
