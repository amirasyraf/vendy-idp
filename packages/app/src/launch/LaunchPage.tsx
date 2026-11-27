import { ReactNode, useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Button, ButtonBase, makeStyles } from '@material-ui/core';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  useImageAvailability,
  usePlatforms,
  vmColors,
} from '@internal/plugin-vm-status';
import { errorMessage } from '../clientLog';
import {
  bucket,
  categories,
  launchPath,
  platformOptions,
  products,
  virtualMachines,
} from '../products/catalog';
import { LaunchIcon } from './LaunchIcon';

const useStyles = makeStyles(theme => ({
  root: {
    padding: '32px 20px 48px',
    maxWidth: 1200,
    '@media (max-width: 760px)': { padding: '24px 16px 40px' },
  },
  steps: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: 13,
    color: vmColors.mute,
    '& li + li::before': { content: '"›"', marginRight: 8 },
  },
  current: { color: vmColors.ink, fontWeight: 700 },
  h1: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.025em',
    lineHeight: 1.1,
    margin: '16px 0 8px',
  },
  sub: { color: vmColors.mute, fontSize: 14, marginBottom: 28 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
    gap: 16,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    textAlign: 'left',
    textDecoration: 'none',
    padding: '20px 22px',
    minHeight: 116,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    background: theme.palette.background.paper,
    transition: 'border-color 120ms, box-shadow 120ms',
    '&:hover': { borderColor: vmColors.blue, textDecoration: 'none' },
    '&.Mui-disabled': { opacity: 0.5 },
  },
  selected: {
    borderColor: vmColors.blue,
    boxShadow: `0 0 0 1px ${vmColors.blue}`,
    background: '#F5FAFF',
  },
  name: { fontSize: 20, fontWeight: 700, color: vmColors.ink },
  detail: { fontSize: 13, color: vmColors.mute, marginTop: 8 },
  soon: { marginTop: 8, fontSize: 12, color: vmColors.mute },
  choiceLine: { display: 'flex', alignItems: 'center', gap: 12 },
  imageGroup: {
    '& + &': { marginTop: 24 },
  },
  imageGroupTitle: {
    color: vmColors.ink,
    margin: '0 0 10px',
    fontSize: 16,
    lineHeight: 1.25,
  },
  image: {
    cursor: 'pointer',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  imageUnavailable: {
    cursor: 'not-allowed',
    background: theme.palette.action.disabledBackground,
    '& $name': { color: theme.palette.text.secondary },
    '&:hover': { borderColor: theme.palette.divider },
  },
  imageText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  radio: {
    accentColor: vmColors.blue,
    width: 17,
    height: 17,
    margin: '0 0 0 auto',
    order: 1,
    flexShrink: 0,
  },
  actions: { display: 'flex', gap: 16, alignItems: 'center', marginTop: 28 },
}));

const vmSteps = ['Product Type', 'Product', 'Platform', 'Image', 'Configure'];
const platformSteps = ['Product Type', 'Product', 'Platform', 'Configure'];
const imageFamilies = [
  { id: 'linux', title: 'Linux Distributions' },
  { id: 'windows', title: 'Windows' },
  { id: 'other', title: 'Other Operating Systems' },
];

function Shell({
  step,
  back,
  title,
  children,
  steps = vmSteps,
}: {
  step: number;
  back: string[];
  title: string;
  children: ReactNode;
  steps?: string[];
}) {
  const classes = useStyles();
  return (
    <main className={classes.root}>
      <nav aria-label="Launch Steps">
        <ol className={classes.steps}>
          {steps.map((name, index) => (
            <li
              key={name}
              className={index === step ? classes.current : undefined}
              aria-current={index === step ? 'step' : undefined}
            >
              {back[index] ? <Link to={back[index]}>{name}</Link> : name}
            </li>
          ))}
        </ol>
      </nav>
      <h1 className={classes.h1}>{title}</h1>
      {children}
    </main>
  );
}

function useProductTemplates() {
  const catalog = useApi(catalogApiRef);
  const [state, setState] = useState<{ items?: Entity[]; error?: string }>({});
  useEffect(() => {
    let active = true;
    catalog
      .getEntities({ filter: { kind: 'template', 'metadata.tags': 'product' } })
      .then(result => {
        if (active) setState({ items: result.items });
      })
      .catch(error => {
        if (active) setState({ error: errorMessage(error) });
      });
    return () => {
      active = false;
    };
  }, [catalog]);
  return state;
}

function templateUrl(entity: Entity, formData?: object) {
  const namespace = encodeURIComponent(entity.metadata.namespace ?? 'default');
  const name = encodeURIComponent(entity.metadata.name);
  return `/create/templates/${namespace}/${name}${
    formData ? `?formData=${encodeURIComponent(JSON.stringify(formData))}` : ''
  }`;
}

function Choices({ items, error }: ReturnType<typeof useProductTemplates>) {
  if (error) return <p role="alert">Products unavailable: {error}</p>;
  return items ? null : <p role="status">Loading products…</p>;
}

function LaunchFlow() {
  const classes = useStyles();
  const {
    category: categoryId,
    product: productId,
    platform: platformId,
  } = useParams();
  const catalog = useProductTemplates();
  const category = categories.find(item => item.id === categoryId);
  const product = products.find(
    item => item.category === categoryId && item.id === productId,
  );
  const findTemplate = (name: string) =>
    catalog.items?.find(
      item =>
        item.metadata.name === name &&
        (item.metadata.namespace ?? 'default') === 'default',
    );
  const readyProducts = products.filter(item => findTemplate(item.template));
  if (!categoryId) {
    return (
      <Shell step={0} back={[]} title="Launch a Product">
        <p className={classes.sub}>Choose a product type to get started.</p>
        <Choices {...catalog} />
        {catalog.items && !readyProducts.length && (
          <p>No products are available yet.</p>
        )}
        <div className={classes.grid}>
          {categories
            .filter(item => readyProducts.some(p => p.category === item.id))
            .map(item => (
              <Link
                key={item.id}
                to={`/launch/${item.id}`}
                className={classes.card}
              >
                <span className={classes.choiceLine}>
                  <LaunchIcon id={item.id} />
                  <span className={classes.name}>{item.title}</span>
                </span>
                <span className={classes.detail}>{item.description}</span>
              </Link>
            ))}
        </div>
      </Shell>
    );
  }
  if (!category || (productId && !product)) {
    return (
      <Shell
        step={category ? 1 : 0}
        back={category ? ['/launch'] : []}
        title="Product Not Found"
      >
        <Link to="/launch">Back to Launch</Link>
      </Shell>
    );
  }

  const categoryPath = `/launch/${category.id}`;
  if (!product) {
    const listed = readyProducts.filter(item => item.category === category.id);
    return (
      <Shell step={1} back={['/launch']} title={category.title}>
        <p className={classes.sub}>Choose a product to launch.</p>
        <Choices {...catalog} />
        {catalog.items && !listed.length && (
          <p>No products are available in this category yet.</p>
        )}
        <div className={classes.grid}>
          {listed.map(item => (
            <Link key={item.id} to={launchPath(item)} className={classes.card}>
              <span className={classes.choiceLine}>
                <LaunchIcon id={item.id} />
                <span className={classes.name}>{item.title}</span>
              </span>
              <span className={classes.detail}>{item.description}</span>
            </Link>
          ))}
        </div>
      </Shell>
    );
  }
  const template = findTemplate(product.template);
  const back = ['/launch', categoryPath];
  const productLaunch = launchPath(product);
  const platformOnly = product.launchFlow === 'platform';
  if (!template) {
    return (
      <Shell
        step={2}
        back={back}
        title={product.title}
        steps={platformOnly ? platformSteps : vmSteps}
      >
        <Choices {...catalog} />
        {catalog.items && (
          <p>This product is not available to launch right now.</p>
        )}
      </Shell>
    );
  }
  if (platformOnly) {
    const isBucket = product === bucket;
    if (platformId) {
      const platform = platformOptions.find(item => item.id === platformId);
      return (
        <Navigate
          to={
            platform
              ? templateUrl(template, isBucket
                  ? { platform: platform.id }
                  : { container: { platform: platform.id } })
              : productLaunch
          }
          replace
        />
      );
    }
    return (
      <Platforms
        back={back}
        productLaunch={productLaunch}
        platforms={platformOptions}
        workload={isBucket ? 'bucket' : 'container'}
        steps={platformSteps}
      />
    );
  }
  return platformId ? (
    <Images
      key={productLaunch + platformId}
      platformId={platformId}
      template={template}
      back={[...back, productLaunch]}
    />
  ) : (
    <VmPlatforms back={back} productLaunch={productLaunch} />
  );
}

function VmPlatforms(props: { back: string[]; productLaunch: string }) {
  const platforms = usePlatforms();
  return (
    <Platforms {...props} platforms={platforms} workload="virtual machine" />
  );
}

function Platforms({
  back,
  productLaunch,
  platforms,
  workload,
  steps,
}: {
  back: string[];
  productLaunch: string;
  platforms?: { id: string; label: string; available: boolean }[];
  workload: string;
  steps?: string[];
}) {
  const classes = useStyles();
  return (
    <Shell step={2} back={back} title="Choose a Platform" steps={steps}>
      <p className={classes.sub}>Choose where to deploy your {workload}.</p>
      {!platforms && <p role="status">Loading platforms…</p>}
      {platforms?.length === 0 && (
        <p role="alert">Platforms unavailable. Try again shortly.</p>
      )}
      <div className={classes.grid}>
        {platforms?.map(platform =>
          platform.available ? (
            <Link
              key={platform.id}
              to={`${productLaunch}/${encodeURIComponent(platform.id)}`}
              className={classes.card}
            >
              <span className={classes.choiceLine}>
                <LaunchIcon id={platform.id} />
                <span className={classes.name}>{platform.label}</span>
              </span>
            </Link>
          ) : (
            <ButtonBase key={platform.id} className={classes.card} disabled>
              <span className={classes.choiceLine}>
                <LaunchIcon id={platform.id} />
                <span className={classes.name}>{platform.label}</span>
              </span>
              <span className={classes.soon}>Coming Soon</span>
            </ButtonBase>
          ),
        )}
      </div>
      <div className={classes.actions}>
        <Link to={back[1]}>Back</Link>
      </div>
    </Shell>
  );
}

function Images({
  platformId,
  template,
  back,
}: {
  platformId: string;
  template: Entity;
  back: string[];
}) {
  const classes = useStyles();
  const platforms = usePlatforms();
  const navigate = useNavigate();
  const platform = platforms?.find(
    item => item.id === platformId && item.available,
  );
  const availability = useImageAvailability(platform?.id);
  const [imageQuery, setImageQuery] = useSearchParams();
  const choice = imageQuery.get('image');
  const options =
    platform?.os.flatMap(os =>
      os.versions.map(version => ({
        os: os.id,
        family:
          os.family === 'linux' || os.family === 'windows' ? os.family : 'other',
        version,
        label: `${os.label} ${version}`,
        key: `${os.id}:${version}`,
        available:
          availability?.some(
            item =>
              item.os === os.id &&
              item.version === version &&
              item.available === true,
          ) === true,
      })),
    ) ?? [];
  const selected =
    options.find(image => image.available && image.key === choice) ??
    (choice === null && options.length === 1 && options[0].available
      ? options[0]
      : undefined);
  return (
    <Shell step={3} back={back} title="Choose an Image">
      <p className={classes.sub}>
        {platform
          ? `Choose the image to deploy on ${platform.label}.`
          : 'Choose the image to deploy.'}
      </p>
      {!platforms && <p role="status">Loading images…</p>}
      {platforms?.length === 0 && (
        <p role="alert">Platforms unavailable. Try again shortly.</p>
      )}
      {platforms && platforms.length > 0 && !platform && (
        <p role="alert">This platform is not available.</p>
      )}
      {platform && options.length === 0 && (
        <p role={platform.error ? 'alert' : undefined}>
          {platform.error
            ? `Could not load images: ${platform.error}`
            : 'No images are available on this platform yet.'}
        </p>
      )}
      {options.length > 0 && (
        <div role="radiogroup" aria-label="Image">
          {imageFamilies.map(family => {
            const images = options.filter(image => image.family === family.id);
            if (!images.length) return null;
            return (
              <section key={family.id} className={classes.imageGroup} aria-labelledby={`images-${family.id}`}>
                <h2 id={`images-${family.id}`} className={classes.imageGroupTitle}>
                  {family.title}
                </h2>
                <div className={classes.grid}>
                  {images.map(image => (
                    <label
                      key={image.key}
                      className={`${classes.card} ${classes.image} ${
                        selected?.key === image.key ? classes.selected : ''
                      } ${image.available ? '' : classes.imageUnavailable}`}
                    >
                      <input
                        type="radio"
                        name="image"
                        className={classes.radio}
                        checked={selected?.key === image.key}
                        disabled={!image.available}
                        aria-label={image.label}
                        aria-describedby={
                          image.available ? undefined : `availability-${image.key}`
                        }
                        onChange={() =>
                          setImageQuery({ image: image.key }, { replace: true })
                        }
                      />
                      <LaunchIcon id={image.os} fallback={image.family} />
                      <span className={classes.imageText}>
                        <span className={classes.name}>{image.label}</span>
                        {!image.available && (
                          <span
                            className={classes.soon}
                            id={`availability-${image.key}`}
                          >
                            {availability ? 'Not available' : 'Checking availability…'}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <div className={classes.actions}>
        <Button
          variant="contained"
          color="primary"
          disabled={!selected}
          onClick={() =>
            selected &&
            navigate(
              templateUrl(template, {
                compute: {
                  platform: platformId,
                  os: selected.os,
                  imageVersion: selected.version,
                },
              }),
            )
          }
        >
          Continue
        </Button>
        <Link to={back[2]}>Back</Link>
      </div>
    </Shell>
  );
}

function LegacyLaunch() {
  const { platform } = useParams();
  const { search } = useLocation();
  return (
    <Navigate
      to={`${launchPath(virtualMachines)}${
        platform ? `/${encodeURIComponent(platform)}` : ''
      }${search}`}
      replace
    />
  );
}

export function LaunchPage() {
  return (
    <Routes>
      <Route index element={<LaunchFlow />} />
      <Route path="vm-request" element={<LegacyLaunch />} />
      <Route path="vm-request/:platform" element={<LegacyLaunch />} />
      <Route path=":category" element={<LaunchFlow />} />
      <Route path=":category/:product" element={<LaunchFlow />} />
      <Route path=":category/:product/:platform" element={<LaunchFlow />} />
    </Routes>
  );
}
