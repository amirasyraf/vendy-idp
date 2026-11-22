import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Content, InfoCard, Link, Page, Progress } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Button, makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import type { RunView } from '@internal/plugin-vm-status';
import { containerStatus, useContainersApi } from './api';

const useStyles = makeStyles({
  table: { width: '100%', borderCollapse: 'collapse', '& td, & th': { textAlign: 'left', padding: '10px 8px', borderBottom: '1px solid #e5e7eb' } },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
});

export function ContainersProductPage() {
  const classes = useStyles();
  const catalog = useApi(catalogApiRef);
  const api = useContainersApi();
  const [entities, setEntities] = useState<Entity[]>();
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [list, summary] = await Promise.all([
          catalog.getEntities({ filter: { kind: 'Resource', 'spec.type': 'container' } }),
          api.summary(),
        ]);
        if (disposed) return;
        setEntities(list.items);
        setRuns(Object.fromEntries(summary.containers.map(item => [item.name, item.latest])));
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [catalog, api]);
  return (
    <Page themeId="tool">
      <Content>
        <div className={classes.header}>
          <div>
            <Link to="/catalog">Resources</Link> / Compute / Containers
            <h1>Containers</h1>
          </div>
          <Button variant="contained" color="primary" startIcon={<AddIcon />} href="/launch/compute/containers">
            Deploy a Container
          </Button>
        </div>
        <InfoCard>
          {error && <p style={{ color: '#b42318' }}>{error}</p>}
          {!entities && !error && <Progress />}
          {entities && entities.length === 0 && <p>No containers yet.</p>}
          {entities && entities.length > 0 && (
            <table className={classes.table}>
              <thead>
                <tr><th>Name</th><th>Team</th><th>Image</th><th>Runs on</th><th>Status</th><th>URL</th></tr>
              </thead>
              <tbody>
                {entities.map(entity => {
                  const name = entity.metadata.name;
                  const c = (entity.spec?.container ?? {}) as Record<string, any>;
                  const domain = window.location.hostname;
                  return (
                    <tr key={name}>
                      <td><Link to={`/catalog/default/resource/${name}`}>{name}</Link></td>
                      <td>{String(entity.spec?.owner ?? '').split('/').pop()}</td>
                      <td>{c.image}</td>
                      <td>{`${String(c.platform ?? '').toUpperCase()} · ${c.arch} · ${c.size}`}</td>
                      <td>{containerStatus(runs[name], entity.metadata.annotations?.['cf/status'])}</td>
                      <td>{c.public ? <Link to={`https://${name}.apps.${domain}`}>{`${name}.apps.${domain}`}</Link> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </InfoCard>
      </Content>
    </Page>
  );
}
