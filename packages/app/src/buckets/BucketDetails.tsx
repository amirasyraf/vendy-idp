import { InfoCard, Link } from '@backstage/core-components';
import { Button, makeStyles, Typography } from '@material-ui/core';
import { ReactNode, useEffect, useState } from 'react';
import {
  BucketDetail,
  BucketUsage,
  platformName,
  statusLabel,
  useBucketRequest,
} from './api';

const useStyles = makeStyles(theme => ({
  facts: {
    margin: 0,
    '& > div': {
      display: 'grid',
      gridTemplateColumns: 'minmax(112px, 2fr) minmax(0, 3fr)',
      gap: 12,
      padding: '8px 0',
      borderBottom: `1px solid ${theme.palette.divider}`,
    },
    '& > div:last-child': { borderBottom: 0 },
    '& dt': { color: theme.palette.text.secondary },
    '& dd': { margin: 0, overflowWrap: 'anywhere' },
  },
  uri: {
    display: 'block',
    margin: '0 0 12px',
    overflowWrap: 'anywhere',
    fontSize: 12,
  },
}));

export const byteLabel = (size: number) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = size
    ? Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
    : 0;
  return `${(size / 1024 ** unit).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ${units[unit]}`;
};

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const classes = useStyles();
  return (
    <dl className={classes.facts}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BucketDetails({
  item,
  revision,
}: {
  item: BucketDetail;
  revision: number;
}) {
  const classes = useStyles();
  const request = useBucketRequest();
  const [usage, setUsage] = useState<BucketUsage>();
  const [usageError, setUsageError] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    if (item.status !== 'ready') return undefined;
    const controller = new AbortController();
    setUsage(undefined);
    setUsageError(false);
    request<BucketUsage>(
      `/${item.id}/usage`,
      undefined,
      controller.signal,
    ).then(
      value => {
        if (!controller.signal.aborted) setUsage(value);
      },
      () => {
        if (!controller.signal.aborted) setUsageError(true);
      },
    );
    return () => controller.abort();
  }, [item.id, item.status, request, revision]);

  const requestedBy = item.requestedBy?.split('/').pop();
  const requested = item.requestedAt && (
    <>
      {requestedBy && `${requestedBy} · `}
      <time dateTime={item.requestedAt}>
        {new Date(item.requestedAt).toLocaleString()}
      </time>
    </>
  );
  const limitPrefix = usage?.complete === false ? 'At least ' : '';
  async function copyUri() {
    if (!item.storageUri) return;
    try {
      await navigator.clipboard.writeText(item.storageUri);
      setCopyStatus('Storage URI copied.');
    } catch {
      setCopyStatus('Select the URI to copy it manually.');
    }
  }

  return (
    <>
      <InfoCard
        title="Configuration"
        titleTypographyProps={{ component: 'h2' }}
      >
        <Facts
          rows={[
            ['Platform', platformName[item.platform]],
            ['Region', item.region],
            [
              'Owning team',
              <Link to={`/catalog/default/group/${item.team}`}>
                {item.team}
              </Link>,
            ],
            ['Access', 'Private'],
            [
              item.platform === 'aws'
                ? 'S3 bucket name'
                : 'Blob container name',
              <code>{item.cloudName}</code>,
            ],
          ]}
        />
      </InfoCard>
      <InfoCard title="Details" titleTypographyProps={{ component: 'h2' }}>
        <Facts
          rows={[
            ['Status', statusLabel[item.status]],
            ['Requested', requested],
            [
              'Objects',
              usage && `${limitPrefix}${usage.objects.toLocaleString()}`,
            ],
            ['Stored data', usage && `${limitPrefix}${byteLabel(usage.bytes)}`],
          ]}
        />
        {item.status === 'ready' && !usage && (
          <Typography color="textSecondary" variant="body2" role="status">
            {usageError
              ? 'Usage is unavailable. Refresh the file list to retry.'
              : 'Checking object usage…'}
          </Typography>
        )}
        {usage?.complete === false && (
          <Typography color="textSecondary" variant="body2">
            Usage is based on the first page of objects.
          </Typography>
        )}
      </InfoCard>
      {item.status === 'ready' && item.storageUri && (
        <InfoCard title="Connect" titleTypographyProps={{ component: 'h2' }}>
          <code className={classes.uri}>{item.storageUri}</code>
          <Button variant="outlined" onClick={() => void copyUri()}>
            Copy storage URI
          </Button>
          {copyStatus && (
            <Typography variant="body2" role="status">
              {copyStatus}
            </Typography>
          )}
        </InfoCard>
      )}
    </>
  );
}
