interface ResolveApiOptions {
  envBase?: string;
  dev: boolean;
  origin: string;
  fetcher?: typeof fetch;
}

export class ServerOfflineError extends Error {
  constructor() {
    super('The Overroot server did not answer');
    this.name = 'ServerOfflineError';
  }
}

export async function resolveApiBase({ envBase, dev, origin, fetcher = fetch }: ResolveApiOptions): Promise<string> {
  const base = (envBase?.trim() || (dev ? 'http://127.0.0.1:4317' : origin)).replace(/\/$/, '');
  try {
    const status = await fetcher(`${base}/api/v1/status`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!status.ok) throw new ServerOfflineError();
  } catch {
    throw new ServerOfflineError();
  }
  return base;
}
