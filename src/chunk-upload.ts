import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

type Api = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;

export async function uploadLargeFile(
  buildId: string,
  file: { absolutePath: string; archivePath: string; size: number },
  api: Api,
  report: (done: number, total: number) => void = () => undefined,
) {
  const endpoint = `/api/v1/builds/${encodeURIComponent(buildId)}/chunks?path=${encodeURIComponent(file.archivePath)}`;
  const status = await api(endpoint);
  if (status.complete === true) return;
  const chunkBytes = Number(status.chunkBytes);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 32 * 1024 * 1024) throw new Error('Invalid server upload chunk size.');
  const parts = new Map<number, string>();
  for (const part of Array.isArray(status.parts) ? status.parts : []) {
    if (part && typeof part.index === 'number' && typeof part.sha256 === 'string') parts.set(part.index, part.sha256);
  }
  const count = Math.max(1, Math.ceil(file.size / chunkBytes));
  const handle = await open(file.absolutePath, 'r');
  try {
    for (let index = 0; index < count; index++) {
      const length = Math.min(chunkBytes, file.size - index * chunkBytes);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, index * chunkBytes + read);
        if (!result.bytesRead) throw new Error('Build file changed during upload. Run deploy again.');
        read += result.bytesRead;
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      if (parts.get(index) !== sha256) {
        await api(`${endpoint}&index=${index}`, {method: 'PUT', headers: {'content-type': 'application/octet-stream', 'x-inkwell-chunk-sha256': sha256}, body: new Blob([buffer])});
      }
      report(index + 1, count);
    }
    await api(endpoint, {method: 'POST'});
  } finally { await handle.close(); }
}
