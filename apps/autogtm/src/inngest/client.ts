import { Inngest } from 'inngest';

const forcedCloud =
  process.env.INNGEST_DEV === '0' || process.env.INNGEST_DEV === 'false';

const devServerUrl =
  (process.env.INNGEST_DEV?.startsWith('http') ? process.env.INNGEST_DEV : undefined) ||
  process.env.INNGEST_BASE_URL ||
  'http://127.0.0.1:8288';

// Next.js `fetch` on Windows often fails against `localhost` (IPv6). Pin the
// local CLI to IPv4 unless this process is explicitly in cloud/self-hosted mode.
export const inngest = new Inngest({
  id: 'autogtm',
  ...(!forcedCloud && process.env.NODE_ENV !== 'production'
    ? { isDev: true, baseUrl: devServerUrl }
    : {}),
});

export const INNGEST_UNAVAILABLE_MESSAGE =
  'Inngest is not running. For local `npm run dev`, start it with `npm run dev:inngest` (or `npx inngest-cli@latest dev`) and do not set INNGEST_DEV=0 in .env.local.';

export function isInngestUnreachable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const err = error as { cause?: unknown; code?: string; message?: string };
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') return true;
  if (err.message === INNGEST_UNAVAILABLE_MESSAGE) return true;
  if (/fetch failed|ECONNREFUSED/i.test(String(err.message || ''))) return true;
  return isInngestUnreachable(err.cause, depth + 1);
}

export async function sendInngestEvent(
  ...args: Parameters<typeof inngest.send>
): ReturnType<typeof inngest.send> {
  try {
    return await inngest.send(...args);
  } catch (error) {
    if (isInngestUnreachable(error)) {
      throw new Error(INNGEST_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw error;
  }
}
