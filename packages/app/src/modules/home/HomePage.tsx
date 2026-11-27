import { ReactNode, useEffect, useId, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import ArrowForwardIcon from '@material-ui/icons/ArrowForward';
import DnsOutlinedIcon from '@material-ui/icons/DnsOutlined';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import LayersOutlinedIcon from '@material-ui/icons/LayersOutlined';
import {
  getVmConfiguration,
  platformLabel,
  runVmStatus,
  usePlatforms,
  useRunSummary,
  vmColors,
  vmRunLabel,
  vmState,
  vmStateColor,
} from '@internal/plugin-vm-status';
import { errorMessage, reportClientEvent } from '../../clientLog';
import {
  bucket,
  bucketPath,
  categories,
  productOf,
  productPath,
  products,
} from '../../products/catalog';

const useStyles = makeStyles({
  root: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: 1056,
    margin: '0 auto',
    padding: '44px 28px 64px',
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  head: {
    position: 'relative',
    isolation: 'isolate',
    overflow: 'hidden',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '20px 32px',
    justifyContent: 'space-between',
    padding: '32px 36px',
    minHeight: 182,
    boxSizing: 'border-box',
    border: '1px solid #D9E5F7',
    borderRadius: 16,
    background: '#F0F5FD',
    '@media (max-width: 600px)': { padding: '24px 20px', minHeight: 0 },
  },
  map: {
    position: 'absolute',
    zIndex: -1,
    height: '100%',
    width: 'min(53%, 470px)',
    right: 0,
    bottom: 0,
    opacity: 0.9,
    pointerEvents: 'none',
    '@media (max-width: 600px)': { width: '52%', opacity: 0.45 },
  },
  welcome: { maxWidth: 610 },
  eyebrow: {
    margin: '0 0 12px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#315A98',
  },
  h1: {
    fontSize: 'clamp(29px, 4vw, 44px)',
    fontWeight: 730,
    lineHeight: 1.08,
    letterSpacing: '-0.045em',
    margin: 0,
    color: vmColors.ink,
  },
  sub: { color: vmColors.mute, fontSize: 14, margin: '8px 0 0' },
  launch: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: vmColors.blue,
    color: '#fff',
    borderRadius: 8,
    padding: '11px 16px 11px 12px',
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    '& svg': { fontSize: 19 },
    '&:hover': { background: '#0A4FB0', textDecoration: 'none' },
  },
  resources: { marginTop: 38, '@media (max-width: 600px)': { marginTop: 30 } },
  sectionHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px 20px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: 26,
    letterSpacing: '-0.035em',
    lineHeight: 1.2,
    color: vmColors.ink,
  },
  textLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    color: '#194E9B',
    fontSize: 13,
    fontWeight: 650,
    '& svg': { fontSize: 16 },
  },
  category: { marginTop: 26 },
  categoryTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: vmColors.mute,
    margin: '0 0 10px',
    '&::after': { content: '""', flex: 1, height: 1, background: '#E5E9EF' },
  },
  panels: { display: 'grid', gap: 10 },
  panel: {
    border: '1px solid #DCE3ED',
    borderRadius: 12,
    overflow: 'hidden',
    background: '#fff',
    '&[data-open="true"]': { borderColor: '#BBD1F2' },
  },
  productHeading: { margin: 0 },
  toggle: {
    appearance: 'none',
    border: 0,
    background: 'transparent',
    color: vmColors.ink,
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
    alignItems: 'center',
    textAlign: 'left',
    gap: 16,
    width: '100%',
    padding: '17px 20px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    '&:hover': { background: '#F7FAFE' },
    '&[aria-expanded="true"]': { background: '#F8FAFF' },
    '&:focus-visible': {
      outline: `2px solid ${vmColors.blue}`,
      outlineOffset: -3,
    },
    '@media (max-width: 600px)': { gap: 9, padding: '14px 12px' },
  },
  productIcon: {
    display: 'grid',
    placeItems: 'center',
    width: 46,
    height: 46,
    borderRadius: 10,
    background: '#E8F0FF',
    color: '#2058AB',
    '& svg': { fontSize: 25 },
    '@media (max-width: 600px)': {
      width: 36,
      height: 36,
      '& svg': { fontSize: 21 },
    },
  },
  productTitle: {
    display: 'block',
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  productDetail: {
    display: 'block',
    marginTop: 3,
    color: vmColors.mute,
    fontSize: 13,
    fontWeight: 400,
    '@media (max-width: 600px)': { display: 'none' },
  },
  count: {
    color: '#40536F',
    background: '#EFF3F9',
    borderRadius: 20,
    padding: '5px 9px',
    whiteSpace: 'nowrap',
    fontSize: 12,
    fontWeight: 650,
    fontVariantNumeric: 'tabular-nums',
  },
  chevron: {
    color: '#557198',
    fontSize: 22,
    transition: 'transform 160ms ease',
    '$toggle[aria-expanded="true"] &': { transform: 'rotate(180deg)' },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  body: {
    borderTop: '1px solid #E3EBF7',
    background: '#F8FAFD',
    padding: '12px 14px 0',
  },
  list: {
    padding: 0,
    margin: 0,
    listStyle: 'none',
    background: '#fff',
    border: '1px solid #E4E9F1',
    borderRadius: 8,
    '& li + li': { borderTop: '1px solid #E9EDF3' },
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '30px minmax(0, 1fr) auto 16px',
    gridTemplateAreas: '"icon name facts arrow"',
    alignItems: 'center',
    gap: '4px 12px',
    padding: '11px 12px',
    color: vmColors.ink,
    fontSize: 14,
    '&:hover': { background: '#F5F9FF', textDecoration: 'none' },
    '&:focus-visible': {
      outline: `2px solid ${vmColors.blue}`,
      outlineOffset: -2,
    },
    '@media (max-width: 600px)': {
      gridTemplateColumns: '28px minmax(0, 1fr) 16px',
      gridTemplateAreas: '"icon name arrow" "icon facts arrow"',
      columnGap: 9,
    },
  },
  rowIcon: {
    gridArea: 'icon',
    display: 'grid',
    placeItems: 'center',
    width: 28,
    height: 28,
    borderRadius: 6,
    background: '#F0F3F8',
    color: '#48648C',
    '& svg': { fontSize: 17 },
  },
  rowName: { gridArea: 'name', fontWeight: 650, overflowWrap: 'anywhere' },
  rowFacts: {
    gridArea: 'facts',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 8px',
    color: vmColors.mute,
    fontSize: 12,
  },
  rowArrow: { gridArea: 'arrow', color: '#587198', fontSize: 16 },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 7px',
    borderRadius: 12,
    background: '#EFF2F6',
    color: '#435065',
    '&[data-state="ready"]': { background: '#E7F5ED', color: '#185F43' },
    '&[data-state="building"]': { background: '#EAF2FF', color: '#244D91' },
    '&[data-state="failed"]': { background: '#FCEBE8', color: '#A62A1E' },
  },
  dot: {
    flex: '0 0 6px',
    borderRadius: '50%',
    width: 6,
    height: 6,
  },
  message: { padding: 14, margin: 0, color: vmColors.mute, fontSize: 13 },
  footer: { display: 'flex', justifyContent: 'flex-end', padding: '12px 0' },
});

const displayName = (entity: Entity) =>
  entity.metadata.title ?? entity.metadata.name;
function currentGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

const entityPath = ({ metadata }: Entity) =>
  `/catalog/${encodeURIComponent(
    metadata.namespace ?? 'default',
  )}/resource/${encodeURIComponent(metadata.name)}`;

function TransitMap() {
  const classes = useStyles();
  return (
    <svg
      className={classes.map}
      viewBox="0 0 470 182"
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern
          id="home-coordinate-grid"
          width="18"
          height="18"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r="1" fill="#A8C3E9" />
        </pattern>
      </defs>
      <path
        d="M122 0H470V182H34V133Z"
        fill="url(#home-coordinate-grid)"
        opacity=".56"
      />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M48 144h108l40-40h85l64-64h125M216 182l49-49h64l44-44h97"
          stroke="#ADC9F0"
          strokeWidth="2"
        />
        <path
          d="M114 144h42l40-40h85l64-64h44"
          stroke="#6A9DE3"
          strokeWidth="2.5"
        />
        <path
          d="M298 182l30-30h36l38-38h68"
          stroke="#CBDCF5"
          strokeWidth="1.5"
        />
      </g>
      <g fill="#F0F5FD" stroke="#75A4E6" strokeWidth="2">
        <circle cx="114" cy="144" r="4.5" />
        <circle cx="196" cy="104" r="5.5" />
        <circle cx="281" cy="104" r="4.5" />
        <circle cx="344" cy="40" r="7" />
        <circle cx="389" cy="40" r="4.5" />
        <circle cx="373" cy="89" r="4.5" />
      </g>
    </svg>
  );
}

function ProductPanel({
  title,
  description,
  count,
  icon,
  to,
  linkLabel,
  children,
}: {
  title: string;
  description: string;
  count: number;
  icon: ReactNode;
  to: string;
  linkLabel: string;
  children: ReactNode;
}) {
  const classes = useStyles();
  const id = useId();
  const [open, setOpen] = useState(false);
  const titleId = `${id}-title`;
  const countId = `${id}-count`;
  const bodyId = `${id}-body`;
  return (
    <article className={classes.panel} data-open={open}>
      <h4 className={classes.productHeading}>
        <button
          type="button"
          className={classes.toggle}
          aria-labelledby={titleId}
          aria-describedby={countId}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(value => !value)}
        >
          <span className={classes.productIcon} aria-hidden="true">
            {icon}
          </span>
          <span>
            <span className={classes.productTitle} id={titleId}>
              {title}
            </span>
            <span className={classes.productDetail}>{description}</span>
          </span>
          <span className={classes.count} id={countId}>
            {count} {count === 1 ? 'resource' : 'resources'}
          </span>
          <ExpandMoreIcon className={classes.chevron} />
        </button>
      </h4>
      <div
        id={bodyId}
        role="region"
        aria-labelledby={titleId}
        className={classes.body}
        hidden={!open}
      >
        {open && (
          <>
            {count > 0 ? (
              children
            ) : (
              <p className={classes.message}>
                No resources in this product yet.
              </p>
            )}
            <div className={classes.footer}>
              <Link to={to} className={classes.textLink}>
                {linkLabel}
                <ArrowForwardIcon />
              </Link>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function ResourceRow({
  entity,
  facts,
  icon,
}: {
  entity: Entity;
  facts?: ReactNode;
  icon: ReactNode;
}) {
  const classes = useStyles();
  const bucketId = productOf(entity) === bucket ? entity.metadata.annotations?.['cf/bucket-id'] : undefined;
  return (
    <li>
      <Link to={bucketId ? bucketPath(bucketId) : entityPath(entity)} className={classes.row}>
        <span className={classes.rowIcon} aria-hidden="true">
          {icon}
        </span>
        <span className={classes.rowName}>{displayName(entity)}</span>
        {facts && <span className={classes.rowFacts}>{facts}</span>}
        <ArrowForwardIcon className={classes.rowArrow} />
      </Link>
    </li>
  );
}

function VmRows({ entities }: { entities: Entity[] }) {
  const classes = useStyles();
  const platforms = usePlatforms();
  const { runs, observed, error } = useRunSummary();
  return (
    <>
      {error && (
        <p className={classes.message}>
          Live VM status unavailable. Showing catalog status.
        </p>
      )}
      <ul className={classes.list}>
        {entities.map(entity => {
          const { name } = entity.metadata;
          const status = entity.metadata.annotations?.['cf/status'];
          const state = vmState(
            runVmStatus(runs[name], status, observed[name]),
          );
          return (
            <ResourceRow
              key={entityPath(entity)}
              entity={entity}
              icon={<DnsOutlinedIcon />}
              facts={
                <>
                  <span className={classes.pill}>
                    {platformLabel(
                      getVmConfiguration(entity.spec).platform,
                      platforms,
                    )}
                  </span>
                  <span className={classes.pill} data-state={state}>
                    <i
                      aria-hidden="true"
                      className={classes.dot}
                      style={{ backgroundColor: vmStateColor(state) }}
                    />
                    {vmRunLabel(runs[name], status, observed[name])}
                  </span>
                </>
              }
            />
          );
        })}
      </ul>
    </>
  );
}

function ResourceRows({ entities }: { entities: Entity[] }) {
  const classes = useStyles();
  return (
    <ul className={classes.list}>
      {entities.map(entity => (
        <ResourceRow
          key={entityPath(entity)}
          entity={entity}
          icon={<LayersOutlinedIcon />}
          facts={
            typeof entity.spec?.type === 'string' && (
              <span className={classes.pill}>{entity.spec.type}</span>
            )
          }
        />
      ))}
    </ul>
  );
}

export function HomePage() {
  const classes = useStyles();
  const catalog = useApi(catalogApiRef);
  const identity = useApi(identityApiRef);
  const [resources, setResources] = useState<Entity[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState<string>();
  const [teams, setTeams] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([identity.getProfileInfo(), identity.getBackstageIdentity()])
      .then(([profile, user]) => {
        if (!active) return;
        setName(profile.displayName ?? user.userEntityRef.split('/').pop());
        setTeams(
          user.ownershipEntityRefs
            .filter(
              ref =>
                ref.startsWith('group:default/') &&
                ref !== 'group:default/platform-admins',
            )
            .map(ref => ref.slice('group:default/'.length))
            .map(team => team.charAt(0).toUpperCase() + team.slice(1)),
        );
      })
      .catch(e =>
        reportClientEvent({
          kind: 'identity-load-failed',
          message: errorMessage(e),
          detail: 'home page',
        }),
      );
    return () => {
      active = false;
    };
  }, [identity]);

  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await catalog.getEntities({
          filter: { kind: 'Resource' },
        });
        if (active) {
          setResources(
            [...result.items].sort((a, b) =>
              displayName(a).localeCompare(displayName(b)),
            ),
          );
          setError(undefined);
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
      } finally {
        loading = false;
      }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [catalog]);

  const other = resources?.filter(entity => !productOf(entity)) ?? [];
  return (
    <main className={classes.root}>
      <header className={classes.head}>
        <TransitMap />
        <div className={classes.welcome}>
          <p className={classes.eyebrow}>Workspace Overview</p>
          <h1 className={classes.h1}>
            {currentGreeting()}
            {name && `, ${name}`}
          </h1>
          {!!teams.length && (
            <p className={classes.sub}>Team {teams.join(', ')}</p>
          )}
        </div>
        <Link to="/launch" className={classes.launch}>
          <AddIcon />
          Launch a Product
        </Link>
      </header>
      <section className={classes.resources} aria-labelledby="your-resources">
        <div className={classes.sectionHead}>
          <div>
            <h2 id="your-resources" className={classes.sectionTitle}>
              Your Resources
            </h2>
            <p className={classes.sub}>
              Open a product to see its resources and their status.
            </p>
          </div>
          <Link to="/catalog" className={classes.textLink}>
            Browse All Resources <ArrowForwardIcon />
          </Link>
        </div>
        {error && <p role="alert">Could not load resources: {error}</p>}
        {!resources && !error && <p role="status">Loading resources…</p>}
        {resources &&
          categories.map(category => (
            <section key={category.id} className={classes.category}>
              <h3 className={classes.categoryTitle}>{category.title}</h3>
              <div className={classes.panels}>
                {products
                  .filter(product => product.category === category.id)
                  .map(product => {
                    const entities = resources.filter(
                      entity => productOf(entity) === product,
                    );
                    const isVm = product.resourceType === 'vm';
                    const Rows = isVm ? VmRows : ResourceRows;
                    return (
                      <ProductPanel
                        key={product.id}
                        title={product.title}
                        description={product.description}
                        count={entities.length}
                        icon={
                          isVm ? <DnsOutlinedIcon /> : <LayersOutlinedIcon />
                        }
                        to={productPath(product)}
                        linkLabel={`View All ${product === bucket ? 'Buckets' : product.title}`}
                      >
                        <Rows entities={entities} />
                      </ProductPanel>
                    );
                  })}
              </div>
            </section>
          ))}
        {other.length > 0 && (
          <section className={classes.category}>
            <h3 className={classes.categoryTitle}>Other</h3>
            <ProductPanel
              title="Other Resources"
              description="Catalog resources without a product."
              count={other.length}
              icon={<LayersOutlinedIcon />}
              to="/catalog"
              linkLabel="View All Resources"
            >
              <ResourceRows entities={other} />
            </ProductPanel>
          </section>
        )}
      </section>
    </main>
  );
}
