/** Repeat only content-addressed PUT uploads, never publication or other mutations. */
export async function fetchWithUploadRetry(
  url: URL,
  init: RequestInit,
  options: {
    fetcher?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    onRetry?: (attempt: number, status?: number) => void;
  } = {},
) {
  const body = init.body;
  const replayable = body == null || typeof body === 'string' || body instanceof Blob ||
    body instanceof FormData || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  const retryable = init.method?.toUpperCase() === 'PUT' &&
    /^\/api\/v1\/builds\/[a-z0-9]+\/(files|chunks)$/.test(url.pathname) && replayable;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    let status: number | undefined;
    try {
      const signal = retryable
        ? init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
        : init.signal;
      const response = await fetcher(url, { ...init, signal });
      if (!retryable || ![500, 502, 503, 504].includes(response.status) || attempt >= 3 || init.signal?.aborted) return response;
      status = response.status;
      // Release the failed response before replaying the same immutable bytes.
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      const networkFailure = error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
      if (!retryable || !networkFailure || attempt >= 3 || init.signal?.aborted) throw error;
    }
    options.onRetry?.(attempt + 1, status);
    await sleep(1000 * 2 ** attempt);
  }
}
