import { Grant } from './api';

export function uploadFile(
  grant: Grant,
  file: File,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Upload canceled.'));
      return;
    }
    const transfer = new XMLHttpRequest();
    transfer.open('PUT', grant.url);
    const cancel = () => transfer.abort();
    transfer.onloadend = () => signal.removeEventListener('abort', cancel);
    transfer.upload.onprogress = event => {
      if (event.lengthComputable && event.total)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    transfer.onload = () => {
      if (transfer.status >= 200 && transfer.status < 300) resolve();
      else
        reject(
          new Error(
            transfer.status === 409 || transfer.status === 412
              ? 'The destination changed. Retry to check the new version.'
              : `Storage rejected the upload (HTTP ${transfer.status}).`,
          ),
        );
    };
    transfer.onerror = () =>
      reject(new Error('Could not reach cloud storage.'));
    transfer.onabort = () => reject(new Error('Upload canceled.'));
    for (const [key, value] of Object.entries(grant.headers ?? {}))
      transfer.setRequestHeader(key, value);
    signal.addEventListener('abort', cancel, { once: true });
    transfer.send(file);
  });
}

export type UploadFile = { file: File; path: string };

export async function droppedFiles(data: DataTransfer): Promise<UploadFile[]> {
  const entries = Array.from(data.items)
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (!entries.length)
    return Array.from(data.files, file => ({ file, path: file.name }));
  const result: UploadFile[] = [];
  async function walk(entry: FileSystemEntry) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      result.push({ file, path: entry.fullPath.slice(1) });
    } else if (entry.isDirectory) {
      const directory = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          directory.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return result;
}

export async function limitedParallel<T>(
  items: T[],
  work: (item: T) => Promise<void>,
  workers = 3,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item);
      }
    }),
  );
}
