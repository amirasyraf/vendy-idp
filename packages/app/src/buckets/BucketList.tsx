import { Content, InfoCard, Link, Page } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  Box,
  Button,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { bucket, bucketPath, launchPath } from '../products/catalog';
import {
  Bucket,
  describeError,
  Platform,
  platformName,
  statusLabel,
  useBucketRequest,
} from './api';

export function BucketList() {
  const request = useBucketRequest();
  const [inventory, setInventory] = useState<{
    buckets: Bucket[];
    platforms: Record<Platform, boolean>;
  }>();
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState<string>();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await request<typeof inventory>('/', undefined, signal);
        if (!signal?.aborted) {
          setInventory(result);
          setError('');
        }
      } catch (failure) {
        if (!signal?.aborted) setError(describeError(failure));
      }
    },
    [request],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const retry = async (id: string) => {
    setRetrying(id);
    setError('');
    try {
      await request(`/${id}/retry`, {});
      await refresh();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setRetrying(undefined);
    }
  };
  const unavailable =
    inventory && !Object.values(inventory.platforms).some(Boolean);
  return (
    <Page themeId="tool">
      <Content>
        <Box
          display="flex"
          alignItems="center"
          flexWrap="wrap"
          gridGap={16}
          mb={3}
        >
          <Box flexGrow={1}>
            <nav aria-label="Breadcrumb">
              <Link to="/catalog">Resources</Link> / Storage / Bucket
            </nav>
            <h1>Bucket</h1>
            <Typography color="textSecondary">
              Browse and manage private team buckets on AWS and Azure.
            </Typography>
          </Box>
          <Button onClick={() => void refresh()}>Refresh</Button>
          <Button
            component={RouterLink}
            to={launchPath(bucket)}
            disabled={unavailable}
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
          >
            Create bucket
          </Button>
        </Box>
        {error && (
          <Typography color="error" role="alert">
            {error}
          </Typography>
        )}
        {unavailable && (
          <Typography color="textSecondary">
            Bucket infrastructure is unavailable in this environment.
          </Typography>
        )}
        {!inventory && !error && (
          <Typography role="status">Loading buckets…</Typography>
        )}
        {inventory && (
          <InfoCard>
            {!inventory.buckets.length && (
              <Typography>No team buckets yet.</Typography>
            )}
            {!!inventory.buckets.length && (
              <Box style={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Buckets">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Platform</TableCell>
                      <TableCell>Region</TableCell>
                      <TableCell>Team</TableCell>
                      <TableCell>Requested</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {inventory.buckets.map(item => (
                      <TableRow key={item.id}>
                        <TableCell>
                          {item.status === 'ready' ? (
                            <Link to={bucketPath(item.id)}>{item.name}</Link>
                          ) : (
                            item.name
                          )}
                        </TableCell>
                        <TableCell>{platformName[item.platform]}</TableCell>
                        <TableCell>{item.region ?? '—'}</TableCell>
                        <TableCell>
                          <Link to={`/catalog/default/group/${item.team}`}>
                            {item.team}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {item.requestedAt ? (
                            <time dateTime={item.requestedAt}>
                              {new Date(item.requestedAt).toLocaleDateString()}
                            </time>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={statusLabel[item.status]} />
                        </TableCell>
                        <TableCell align="right">
                          {item.status !== 'ready' && (
                            <Button
                              onClick={() => void retry(item.id)}
                              disabled={Boolean(retrying)}
                            >
                              {retrying === item.id
                                ? 'Retrying…'
                                : 'Retry provisioning'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </InfoCard>
        )}
      </Content>
    </Page>
  );
}

export function BucketOverview() {
  const { entity } = useEntity();
  const id = entity.metadata.annotations?.['cf/bucket-id'];
  return (
    <Box p={3}>
      <Typography variant="h1" gutterBottom>
        {entity.metadata.title ?? entity.metadata.name}
      </Typography>
      {id && (
        <Button
          component={RouterLink}
          to={bucketPath(id)}
          color="primary"
          variant="contained"
        >
          Open bucket
        </Button>
      )}
    </Box>
  );
}
