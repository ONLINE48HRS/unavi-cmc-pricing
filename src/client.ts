import { createHash } from 'node:crypto';

export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

// One record per API call: what was asked, what came back and what it cost. Kept so every price can be traced to a response.
export type CallRecord = {
  endpoint: string;
  params: Record<string, string>;
  payload?: string;
  status: number;
  credits: number;
  at: string;
  sha256: string;
  body: string;
};

export class CmcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'CmcError';
  }
}

export type CmcClient = {
  get<T = any>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<T>;
  post<T = any>(endpoint: string, payload: Record<string, unknown>): Promise<T>;
  calls: CallRecord[];
  credits(): number;
};

const PRO = 'https://pro-api.coinmarketcap.com',
  KEYLESS = 'https://pro-api.coinmarketcap.com/public-api';

// With no key the client uses CMC's keyless public API, which serves a fixed subset of endpoints at lower rate limits.
// Each call gives up after timeoutMs. An interactive caller passes retries:0, so a 429 fails at once instead of waiting.
export function cmcClient({
  apiKey,
  fetcher = fetch as unknown as Fetcher,
  retries = 2,
  timeoutMs = 10_000,
  pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
}: {
  apiKey?: string;
  fetcher?: Fetcher;
  retries?: number;
  timeoutMs?: number;
  pause?: (ms: number) => Promise<unknown>;
  now?: () => Date;
} = {}): CmcClient {
  const calls: CallRecord[] = [];
  async function send(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    payload?: Record<string, unknown>,
  ) {
    const clean = Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    );
    const query = new URLSearchParams(clean).toString(),
      url = `${apiKey ? PRO : KEYLESS}${endpoint}${query ? '?' + query : ''}`,
      data = payload && JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      let response: Awaited<ReturnType<Fetcher>>, body: string;
      try {
        response = await fetcher(url, {
          method: data ? 'POST' : 'GET',
          headers: {
            Accept: 'application/json',
            ...(data ? { 'Content-Type': 'application/json' } : {}),
            ...(apiKey ? { 'X-CMC_PRO_API_KEY': apiKey } : {}),
          },
          ...(data ? { body: data } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        body = await response.text();
      } catch (e) {
        throw new CmcError(
          (e as Error)?.name === 'TimeoutError'
            ? `CoinMarketCap did not answer within ${timeoutMs / 1000} s`
            : 'CoinMarketCap could not be reached',
          0,
          null,
        );
      }
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      const credits = Number(parsed?.status?.credit_count ?? 0);
      calls.push({
        endpoint,
        params: clean,
        ...(data ? { payload: data } : {}),
        status: response.status,
        credits,
        at: now().toISOString(),
        sha256: createHash('sha256').update(body).digest('hex'),
        body,
      });
      // 429 is the per-minute limit; wait as long as CMC asks (or a minute) and try again.
      if (response.status === 429 && attempt < retries) {
        await pause(Math.max(1, Number(response.headers.get('retry-after') ?? 60)) * 1000);
        continue;
      }
      const code = parsed?.status?.error_code ?? null;
      if (!response.ok || (code && Number(code) !== 0))
        throw new CmcError(
          parsed?.status?.error_message || `CoinMarketCap HTTP ${response.status}`,
          response.status,
          code === null ? null : Number(code),
        );
      return parsed;
    }
  }
  return {
    get: (endpoint, params = {}) => send(endpoint, params),
    post: (endpoint, payload) => send(endpoint, {}, payload),
    calls,
    credits: () => calls.reduce((sum, c) => sum + c.credits, 0),
  };
}
