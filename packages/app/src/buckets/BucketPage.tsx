import { InfoCard, Link } from '@backstage/core-components';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@material-ui/core';
import FolderOutlined from '@material-ui/icons/FolderOutlined';
import { ComputeDetailColumns } from '@internal/plugin-vm-status';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { bucket, productPath } from '../products/catalog';
import {
  Bucket,
  BucketDetail,
  BucketError,
  describeError,
  Grant,
  Listing,
  ObjectEntry,
  platformName,
  statusLabel,
  useBucketRequest,
} from './api';
import { BucketDetails, byteLabel } from './BucketDetails';
import { CredentialsDialog } from './CredentialsDialog';
import {
  droppedFiles,
  limitedParallel,
  UploadFile,
  uploadFile,
} from './transfers';

type Transfer = UploadFile & {
  id: string;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'failed' | 'replace' | 'canceled';
  existing?: ObjectEntry;
  error?: string;
};
type Preview = { name: string; url?: string; text?: string };
const filename = (key: string) => key.split('/').pop() ?? key;
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const textTypes = ['txt', 'md', 'csv', 'log', 'json', 'yaml', 'yml', 'xml'];
const ext = (key: string) =>
  filename(key).split('.').pop()?.toLowerCase() ?? '';
const canPreview = (item: ObjectEntry) =>
  item.size <= 5 * 1024 ** 2 &&
  (Object.hasOwn(imageTypes, ext(item.key)) ||
    textTypes.includes(ext(item.key)));

export function BucketPage() {
  const { bucketId } = useParams();
  const request = useBucketRequest();
  const [item, setItem] = useState<BucketDetail>();
  const [error, setError] = useState('');
  const [usageRevision, setUsageRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItem(undefined);
    setError('');
    request<BucketDetail>(`/${bucketId}`, undefined, controller.signal).then(
      value => {
        if (!controller.signal.aborted) setItem(value);
      },
      failure => {
        if (!controller.signal.aborted) setError(describeError(failure));
      },
    );
    return () => controller.abort();
  }, [bucketId, request]);
  return (
    <Box component="main" p={3}>
      <Box component="nav" aria-label="Breadcrumb">
        <Link to="/catalog">Resources</Link> /{' '}
        <Link to={productPath(bucket)}>Bucket</Link>
      </Box>
      {error && (
        <Typography role="alert" color="error">
          {error}
        </Typography>
      )}
      {!item && !error && (
        <Typography role="status">Loading bucket…</Typography>
      )}
      {item && (
        <>
          <Box my={2}>
            <h1>{item.name}</h1>
            <Typography color="textSecondary">
              {[
                statusLabel[item.status],
                platformName[item.platform],
                item.region,
                item.team,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
          </Box>
          <ComputeDetailColumns
            primary={
              <InfoCard
                title="Files"
                titleTypographyProps={{ component: 'h2' }}
              >
                {item.status === 'ready' ? (
                  <FileManager
                    key={item.id}
                    item={item}
                    onRefresh={() => setUsageRevision(value => value + 1)}
                  />
                ) : (
                  <Typography>
                    Return to Bucket to retry provisioning.
                  </Typography>
                )}
              </InfoCard>
            }
            details={
              <BucketDetails
                key={item.id}
                item={item}
                revision={usageRevision}
              />
            }
          />
        </>
      )}
    </Box>
  );
}

function FileManager({
  item,
  onRefresh,
}: {
  item: Bucket;
  onRefresh: () => void;
}) {
  const request = useBucketRequest();
  const base = `/${item.id}`;
  const [folder, setFolder] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [listing, setListing] = useState<Listing>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [queue, setQueue] = useState<Transfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [credentials, setCredentials] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ObjectEntry[]>();
  const [move, setMove] = useState<{ item: ObjectEntry; to: string }>();
  const [prefix, setPrefix] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const active = useRef(new Map<string, AbortController>()).current;
  const pending = useRef<{ entries: Transfer[]; running: boolean }>({
    entries: [],
    running: false,
  }).current;
  const mounted = useRef(true);
  const previewOpening = useRef<AbortController>();
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSelected([]);
    const query = new URLSearchParams({ prefix: `${folder}${search}` });
    if (cursor) query.set('cursor', cursor);
    request<Listing>(
      `${base}/objects?${query}`,
      undefined,
      controller.signal,
    ).then(
      value => {
        if (controller.signal.aborted) return;
        setListing(value);
        setLoading(false);
      },
      failure => {
        if (controller.signal.aborted) return;
        setListing(undefined);
        setError(describeError(failure));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [base, cursor, folder, request, revision, search]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.entries.length = 0;
      active.forEach(controller => controller.abort());
      previewOpening.current?.abort();
    };
  }, [active, pending]);
  const previewUrl = preview?.url;
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function openFolder(path: string) {
    setFolder(path);
    setCursors([]);
    setSearch('');
    setSearchInput('');
    setError('');
  }

  const refresh = () => {
    setRevision(value => value + 1);
    onRefresh();
  };
  const updateTransfer = (id: string, patch: Partial<Transfer>) => {
    setQueue(entries =>
      entries.map(entry => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  };

  async function send(entry: Transfer) {
    if (!mounted.current) return false;
    const controller = new AbortController();
    active.set(entry.id, controller);
    updateTransfer(entry.id, {
      status: 'uploading',
      progress: 0,
      error: undefined,
    });
    try {
      const grant = await request<Grant>(
        `${base}/upload`,
        {
          key: entry.path,
          size: entry.file.size,
          etag: entry.existing?.etag,
        },
        controller.signal,
      );
      await uploadFile(grant, entry.file, controller.signal, percent =>
        updateTransfer(entry.id, { progress: percent }),
      );
      updateTransfer(entry.id, {
        status: 'done',
        existing: undefined,
        progress: 100,
      });
      return true;
    } catch (failure) {
      if (controller.signal.aborted) {
        updateTransfer(entry.id, { status: 'canceled', existing: undefined });
      } else if (failure instanceof BucketError && failure.existing) {
        updateTransfer(entry.id, {
          status: 'replace',
          existing: failure.existing,
        });
      } else {
        updateTransfer(entry.id, {
          status: 'failed',
          existing: undefined,
          error: failure instanceof Error ? failure.message : 'Upload failed.',
        });
      }
      return false;
    } finally {
      active.delete(entry.id);
    }
  }

  async function schedule(entries: Transfer[]) {
    pending.entries.push(...entries);
    if (pending.running) return;
    pending.running = true;
    try {
      while (pending.entries.length) {
        let changed = false;
        await limitedParallel(
          pending.entries.splice(0, pending.entries.length),
          async entry => {
            if (await send(entry)) changed = true;
          },
        );
        if (changed && mounted.current) refresh();
      }
    } finally {
      pending.running = false;
    }
  }

  function addFiles(files: UploadFile[]) {
    if (!mounted.current) return;
    const added: Transfer[] = files.map(file => ({
      ...file,
      id: crypto.randomUUID(),
      path: `${folder}${file.path}`,
      status: 'queued',
      progress: 0,
    }));
    setQueue(previous => [...previous, ...added]);
    void schedule(added);
  }

  async function drop(event: React.DragEvent) {
    event.preventDefault();
    setDragOver(false);
    try {
      addFiles(await droppedFiles(event.dataTransfer));
    } catch {
      setError('Could not read the dropped files or folders.');
    }
  }

  async function download(entry: ObjectEntry, forPreview = false) {
    setError('');
    const controller = forPreview ? new AbortController() : undefined;
    if (controller) {
      previewOpening.current?.abort();
      previewOpening.current = controller;
    }
    try {
      const grant = await request<Grant>(
        `${base}/download`,
        { key: entry.key, preview: forPreview },
        controller?.signal,
      );
      if (!forPreview) {
        const link = document.createElement('a');
        link.href = grant.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = filename(entry.key);
        link.click();
        return;
      }
      const response = await fetch(grant.url, {
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller?.signal,
      });
      const length = response.headers.get('content-length');
      if (!response.ok || length === null || Number(length) > 5 * 1024 ** 2) {
        await response.body?.cancel();
        throw new BucketError(
          'This file could not be previewed. Try downloading it.',
        );
      }
      const type = Object.hasOwn(imageTypes, ext(entry.key))
        ? imageTypes[ext(entry.key)]
        : undefined;
      if (type) {
        const data = await response.arrayBuffer();
        if (!controller?.signal.aborted)
          setPreview({
            name: filename(entry.key),
            url: URL.createObjectURL(new Blob([data], { type })),
          });
      } else {
        const text = await response.text();
        if (!controller?.signal.aborted)
          setPreview({ name: filename(entry.key), text });
      }
    } catch (failure) {
      if (!controller?.signal.aborted) setError(describeError(failure));
    }
  }

  async function remove(entries: ObjectEntry[]) {
    setBusy(true);
    setError('');
    setStatus('');
    const failures: string[] = [];
    try {
      await limitedParallel(entries, async entry => {
        try {
          await request(`${base}/remove`, { key: entry.key, etag: entry.etag });
        } catch (failure) {
          failures.push(`${filename(entry.key)}: ${describeError(failure)}`);
        }
      });
      if (failures.length)
        setError(`${failures.length} could not be deleted. ${failures[0]}`);
      if (entries.length > failures.length)
        setStatus(`Deleted ${entries.length - failures.length} file(s).`);
    } finally {
      setConfirmDelete(undefined);
      setBusy(false);
      refresh();
    }
  }

  async function moveFile(event: React.FormEvent) {
    event.preventDefault();
    if (!move || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await request(`${base}/move`, {
        key: move.item.key,
        etag: move.item.etag,
        to: move.to,
      });
      setStatus(`Moved to ${move.to}.`);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setMove(undefined);
      setBusy(false);
      refresh();
    }
  }
  const folders = folder.split('/').filter(Boolean);
  const objects = listing?.objects.filter(entry => entry.key !== folder) ?? [];
  const allSelected = !!objects.length && selected.length === objects.length;
  return (
    <>
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        gridGap={8}
        mb={2}
      >
        <Button variant="contained" color="primary" component="label">
          Upload files
          <input
            hidden
            type="file"
            multiple
            onChange={event => {
              addFiles(
                Array.from(event.target.files ?? [], file => ({
                  file,
                  path: file.name,
                })),
              );
              event.target.value = '';
            }}
          />
        </Button>
        <Button component="label" variant="outlined">
          Upload folder
          <input
            hidden
            type="file"
            multiple
            ref={input => input?.setAttribute('webkitdirectory', '')}
            onChange={event => {
              addFiles(
                Array.from(event.target.files ?? [], file => ({
                  file,
                  path: file.webkitRelativePath || file.name,
                })),
              );
              event.target.value = '';
            }}
          />
        </Button>
        <Button onClick={() => setPrefix(folder)}>New folder</Button>
        <Box flexGrow={1} />
        <Button variant="outlined" onClick={() => setCredentials(true)}>
          Generate upload credentials
        </Button>
      </Box>
      <Paper
        variant="outlined"
        style={{
          overflowX: 'auto',
          outline: dragOver ? '2px solid #0B5FD3' : undefined,
        }}
        onDragOver={event => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={event => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragOver(false);
        }}
        onDrop={event => void drop(event)}
      >
        <Box
          display="flex"
          alignItems="center"
          gridGap={12}
          flexWrap="wrap"
          px={2}
          py={1}
        >
          <Box
            component="nav"
            aria-label="Folders"
            display="flex"
            alignItems="center"
            flexWrap="wrap"
            flexGrow={1}
          >
            <Button onClick={() => openFolder('')}>Root</Button>
            {folders.map((name, index) => {
              const path = `${folders.slice(0, index + 1).join('/')}/`;
              return (
                <Box key={path} component="span">
                  / <Button onClick={() => openFolder(path)}>{name}</Button>
                </Box>
              );
            })}
          </Box>
          <Box
            component="form"
            display="flex"
            alignItems="center"
            gridGap={8}
            onSubmit={(event: React.FormEvent) => {
              event.preventDefault();
              setError('');
              setSearch(searchInput);
              setCursors([]);
            }}
          >
            <TextField
              size="small"
              variant="outlined"
              label="Name starts with"
              value={searchInput}
              onChange={event => setSearchInput(event.target.value)}
              inputProps={{ maxLength: 200 }}
            />
            <Button type="submit">Search</Button>
            <Button
              onClick={() => {
                setSearch('');
                setSearchInput('');
                setCursors([]);
                setError('');
              }}
              disabled={!search && !searchInput}
            >
              Clear
            </Button>
          </Box>
          <Button
            onClick={() => {
              setError('');
              refresh();
            }}
          >
            Refresh
          </Button>
          <Button
            color="secondary"
            disabled={loading || !selected.length}
            onClick={() =>
              setConfirmDelete(
                objects.filter(entry => selected.includes(entry.key)),
              )
            }
          >
            Delete selected ({selected.length})
          </Button>
        </Box>
        {loading && <LinearProgress aria-label="Loading files" />}
        <Table size="small" aria-label="Bucket files">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  checked={allSelected}
                  indeterminate={!!selected.length && !allSelected}
                  disabled={!objects.length || loading}
                  inputProps={{ 'aria-label': 'Select all files on this page' }}
                  onChange={() =>
                    setSelected(
                      allSelected ? [] : objects.map(entry => entry.key),
                    )
                  }
                />
              </TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Size</TableCell>
              <TableCell>Modified</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!loading &&
              listing?.folders.map(path => (
                <TableRow key={path}>
                  <TableCell />
                  <TableCell>
                    <Button
                      color="primary"
                      startIcon={<FolderOutlined />}
                      onClick={() => openFolder(path)}
                    >
                      {path.slice(folder.length, -1)}
                    </Button>
                  </TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell />
                </TableRow>
              ))}
            {!loading &&
              objects.map(entry => (
                <TableRow
                  key={entry.key}
                  selected={selected.includes(entry.key)}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={selected.includes(entry.key)}
                      inputProps={{
                        'aria-label': `Select ${filename(entry.key)}`,
                      }}
                      onChange={event =>
                        setSelected(previous =>
                          event.target.checked
                            ? [...previous, entry.key]
                            : previous.filter(key => key !== entry.key),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell style={{ overflowWrap: 'anywhere' }}>
                    {entry.key.slice(folder.length)}
                  </TableCell>
                  <TableCell>{byteLabel(entry.size)}</TableCell>
                  <TableCell>
                    {entry.updatedAt
                      ? new Date(entry.updatedAt).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell align="right">
                    {canPreview(entry) && (
                      <Button
                        size="small"
                        onClick={() => void download(entry, true)}
                      >
                        Preview
                      </Button>
                    )}
                    <Button size="small" onClick={() => void download(entry)}>
                      Download
                    </Button>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => setMove({ item: entry, to: entry.key })}
                    >
                      Rename / Move
                    </Button>
                    <Button
                      size="small"
                      color="secondary"
                      disabled={busy}
                      onClick={() => setConfirmDelete([entry])}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            {!loading &&
              listing &&
              !objects.length &&
              !listing.folders.length && (
                <TableRow>
                  <TableCell colSpan={5}>
                    {search
                      ? 'No files match this prefix.'
                      : 'Drop files here or use Upload files.'}
                  </TableCell>
                </TableRow>
              )}
          </TableBody>
        </Table>
        {(cursors.length > 0 || listing?.next) && (
          <Box display="flex" justifyContent="flex-end" p={1}>
            <Button
              disabled={!cursors.length || loading}
              onClick={() => setCursors(previous => previous.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              disabled={!listing?.next || loading}
              onClick={() => {
                if (listing?.next)
                  setCursors(previous => [...previous, listing.next!]);
              }}
            >
              Next
            </Button>
          </Box>
        )}
      </Paper>
      {status && (
        <Box mt={2}>
          <Typography role="status">{status}</Typography>
        </Box>
      )}
      {error && (
        <Box mt={2}>
          <Typography role="alert" color="error">
            {error}
          </Typography>
        </Box>
      )}
      {queue.length > 0 && (
        <Box mt={3}>
          <Box display="flex" alignItems="center" gridGap={8}>
            <Typography variant="h2">Uploads</Typography>
            <Button
              onClick={() =>
                setQueue(previous =>
                  previous.filter(
                    entry => !['done', 'canceled'].includes(entry.status),
                  ),
                )
              }
            >
              Clear finished
            </Button>
          </Box>
          {queue.map(entry => (
            <Box
              key={entry.id}
              display="flex"
              alignItems="center"
              gridGap={8}
              flexWrap="wrap"
              py={1}
            >
              <Typography style={{ overflowWrap: 'anywhere' }}>
                {entry.path}
              </Typography>
              {entry.status === 'uploading' && (
                <>
                  <Box width={120}>
                    <LinearProgress
                      variant="determinate"
                      value={entry.progress}
                      aria-label={`Uploading ${entry.path}`}
                    />
                  </Box>
                  <Typography>{entry.progress}%</Typography>
                  <Button onClick={() => active.get(entry.id)?.abort()}>
                    Cancel
                  </Button>
                </>
              )}
              {entry.status === 'queued' && <Typography>Queued</Typography>}
              {entry.status === 'done' && <Typography>Uploaded</Typography>}
              {(entry.status === 'failed' || entry.status === 'canceled') && (
                <>
                  <Typography>{entry.error || 'Canceled'}</Typography>
                  <Button
                    onClick={() => {
                      updateTransfer(entry.id, { status: 'queued' });
                      void schedule([entry]);
                    }}
                  >
                    Retry
                  </Button>
                </>
              )}
              {entry.status === 'replace' && (
                <>
                  <Typography>File already exists.</Typography>
                  <Button
                    onClick={() => {
                      updateTransfer(entry.id, { status: 'queued' });
                      void schedule([entry]);
                    }}
                  >
                    Replace
                  </Button>
                  <Button
                    onClick={() =>
                      updateTransfer(entry.id, {
                        status: 'canceled',
                        existing: undefined,
                      })
                    }
                  >
                    Skip
                  </Button>
                </>
              )}
            </Box>
          ))}
        </Box>
      )}
      {credentials && (
        <CredentialsDialog bucket={item} close={() => setCredentials(false)} />
      )}
      {confirmDelete && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setConfirmDelete(undefined);
          }}
          aria-labelledby="bucket-delete"
        >
          <DialogTitle id="bucket-delete">
            Delete{' '}
            {confirmDelete.length === 1
              ? filename(confirmDelete[0].key)
              : `${confirmDelete.length} files`}
            ?
          </DialogTitle>
          <DialogContent>
            Deleted files disappear from this bucket.
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setConfirmDelete(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              color="secondary"
              onClick={() => void remove(confirmDelete)}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogActions>
        </Dialog>
      )}
      {move && (
        <Dialog
          open
          fullWidth
          onClose={() => {
            if (!busy) setMove(undefined);
          }}
          aria-labelledby="bucket-move"
        >
          <form onSubmit={event => void moveFile(event)}>
            <DialogTitle id="bucket-move">Rename or move file</DialogTitle>
            <DialogContent>
              <TextField
                fullWidth
                id="bucket-move-destination"
                label="Destination path from bucket root"
                value={move.to}
                onChange={event => setMove({ ...move, to: event.target.value })}
              />
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setMove(undefined)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !move.to || move.to === move.item.key}
                color="primary"
              >
                Move
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
      {prefix !== undefined && (
        <Dialog
          open
          fullWidth
          onClose={() => setPrefix(undefined)}
          aria-labelledby="bucket-folder"
        >
          <form
            onSubmit={event => {
              event.preventDefault();
              if (prefix.trim() && prefix.trim() !== folder)
                openFolder(`${prefix.trim().replace(/\/+$/, '')}/`);
              setPrefix(undefined);
            }}
          >
            <DialogTitle id="bucket-folder">New folder</DialogTitle>
            <DialogContent>
              <TextField
                fullWidth
                id="bucket-new-folder-path"
                label="Folder path from bucket root"
                value={prefix}
                onChange={event => setPrefix(event.target.value)}
                helperText="The folder appears in the bucket after you upload a file to it."
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPrefix(undefined)}>Cancel</Button>
              <Button
                color="primary"
                type="submit"
                disabled={!prefix.trim() || prefix.trim() === folder}
              >
                Open folder
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
      {preview && (
        <Dialog
          open
          fullWidth
          maxWidth="md"
          onClose={() => setPreview(undefined)}
          aria-labelledby="bucket-preview"
        >
          <DialogTitle id="bucket-preview">{preview.name}</DialogTitle>
          <DialogContent>
            {preview.url ? (
              <img
                src={preview.url}
                alt={preview.name}
                style={{ maxWidth: '100%' }}
              />
            ) : (
              <Box
                component="pre"
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {preview.text}
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPreview(undefined)}>Close</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
