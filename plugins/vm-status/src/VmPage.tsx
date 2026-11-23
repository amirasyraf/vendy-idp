import { Fragment, ReactNode } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import {
  FavoriteEntity,
  useAsyncEntity,
} from '@backstage/plugin-catalog-react';
import type {
  EntityContentLayoutProps,
  EntityHeaderLayoutProps,
} from '@backstage/plugin-catalog-react/alpha';
import { makeStyles } from '@material-ui/core';
import { useLocation } from 'react-router-dom';
import { getVmConfiguration } from './vmSpec';
import { osLabel, platformLabel, usePlatforms, useVmSizeText } from './vmSizes';
import { vmColors, vmStateColor } from './pipeline';
import { deriveVm, useVmLive } from './vmLive';
import { VmActions } from './VmActions';

const rule = '#E3E5E8';

const useStyles = makeStyles({
  header: {
    padding: '20px 20px 0',
    borderBottom: `1px solid ${rule}`,
  },
  crumb: {
    fontSize: 13,
    color: vmColors.mute,
    '& a': { color: vmColors.mute },
    '& a:hover': { color: vmColors.ink },
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '4px 10px',
    borderRadius: 999,
    background: '#F3F4F5',
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
  actions: { marginLeft: 'auto' },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: 0,
    overflowWrap: 'anywhere',
  },
  star: { flex: 'none' },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 20px',
    margin: '10px 0 0',
    padding: 0,
    listStyle: 'none',
    fontSize: 13.5,
    color: vmColors.mute,
    '& b': { color: vmColors.ink, fontWeight: 600 },
  },
  tabs: { display: 'flex', gap: 4, marginTop: 16, overflowX: 'auto' },
  tab: {
    padding: '10px 12px',
    fontSize: 14,
    fontWeight: 500,
    color: vmColors.mute,
    borderBottom: '3px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap',
    '&:hover': { color: vmColors.ink, textDecoration: 'none' },
  },
  tabOn: {
    color: vmColors.ink,
    fontWeight: 600,
    borderBottomColor: vmColors.blue,
  },
  spacer: { height: 16 },
  // Content cards lead; info cards follow (side column on wide screens).
  layout: {
    display: 'grid',
    gap: 24,
    gridTemplateColumns: 'minmax(0, 1fr)',
    marginTop: 24,
  },
  withInfo: {
    '@media (min-width: 1100px)': {
      gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
      alignItems: 'start',
    },
  },
  column: { display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 },
});

/** Vendy header for VM entity pages: name, live state and day-2 actions. */
export function VmHeaderLayout({ tabs, activeTabId }: EntityHeaderLayoutProps) {
  const classes = useStyles();
  const { entity } = useAsyncEntity();
  if (!entity) return <header className={classes.header} />;
  return (
    <VmHeader
      key={entity.metadata.name}
      initial={entity}
      tabs={tabs}
      activeTabId={activeTabId}
    />
  );
}

function VmHeader({
  initial,
  tabs,
  activeTabId,
}: EntityHeaderLayoutProps & { initial: Entity }) {
  const live = useVmLive(initial.metadata.name);
  // The live entity follows Modify; the page entity is only the first load.
  const entity = live.entity ?? initial;
  const sizeText = useVmSizeText(entity);
  const desired = getVmConfiguration(entity.spec);
  const platforms = usePlatforms();
  const vm = deriveVm(entity, live);
  return (
    <ComputeEntityHeader
      entity={entity}
      productName="Virtual Machines"
      productHref="/products/compute/virtual-machines"
      state={{
        name: 'VM state',
        label: live.removed ? 'Destroyed' : vm.label,
        color: vmStateColor(vm.state),
        failed: vm.state === 'failed',
      }}
      actions={!live.removed && (
        <VmActions entity={entity} vm={vm} onStarted={live.refresh} />
      )}
      metadata={
        <>
          <li>
            Team <b>{desired.team}</b>
          </li>
          <li>
            {osLabel(desired.platform, desired.os, platforms)}
            {desired.imageVersion ? ` ${desired.imageVersion}` : ''} on{' '}
            {platformLabel(desired.platform, platforms)}
          </li>
          <li>{sizeText}</li>
        </>
      }
      tabs={tabs}
      activeTabId={activeTabId}
      sectionLabel="VM sections"
    />
  );
}

export function ComputeEntityHeader({
  entity,
  productName,
  productHref,
  state,
  actions,
  metadata,
  tabs,
  activeTabId,
  sectionLabel,
}: EntityHeaderLayoutProps & {
  entity: Entity;
  productName: string;
  productHref: string;
  state: { name: string; label: string; color: string; failed?: boolean };
  actions?: ReactNode;
  metadata: ReactNode;
  sectionLabel: string;
}) {
  const classes = useStyles();
  const { pathname } = useLocation();
  const flat = tabs.flatMap(tab => ('items' in tab ? tab.items : [tab]));
  return (
    <header className={classes.header}>
      <nav className={classes.crumb} aria-label="Breadcrumb">
        <Link to="/catalog">Resources</Link> /{' '}
        <Link to={productHref}>{productName}</Link>
      </nav>
      <div className={classes.titleRow}>
        <h1 className={classes.h1}>
          {entity.metadata.title ?? entity.metadata.name}
        </h1>
        <span className={classes.pill} role="status" aria-label={state.name}>
          <i
            aria-hidden="true"
            className={classes.dot}
            style={{ background: state.color }}
          />
          <span style={state.failed ? { color: vmColors.redText } : undefined}>
            {state.label}
          </span>
        </span>
        <span className={classes.star}>
          <FavoriteEntity entity={entity} />
        </span>
        {actions && <div className={classes.actions}>{actions}</div>}
      </div>
      <ul className={classes.meta}>{metadata}</ul>
      {flat.length > 1 ? (
        <nav className={classes.tabs} aria-label={sectionLabel}>
          {flat.map(tab => {
            const on = tab.id === activeTabId || pathname.endsWith(tab.href);
            return (
              <Link
                key={tab.id}
                to={tab.href}
                className={`${classes.tab} ${on ? classes.tabOn : ''}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      ) : (
        <div className={classes.spacer} />
      )}
    </header>
  );
}

/** Responsive split for the primary cards and the configuration/details column. */
export function ComputeDetailColumns({
  primary,
  details,
}: {
  primary: ReactNode;
  details: ReactNode;
}) {
  const classes = useStyles();
  return (
    <div className={`${classes.layout} ${classes.withInfo}`}>
      <div className={classes.column}>{primary}</div>
      <div className={classes.column}>{details}</div>
    </div>
  );
}

export function VmContentLayout({ cards }: EntityContentLayoutProps) {
  const classes = useStyles();
  const content = cards.filter(card => card.type !== 'info');
  const info = cards.filter(card => card.type === 'info');
  return (
    <div className={`${classes.layout} ${info.length ? classes.withInfo : ''}`}>
      <div className={classes.column}>
        {content.map((c, i) => (
          <Fragment key={c.element.key ?? i}>{c.element}</Fragment>
        ))}
      </div>
      {info.length > 0 && (
        <div className={classes.column}>
          {info.map((c, i) => (
            <Fragment key={c.element.key ?? i}>{c.element}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
