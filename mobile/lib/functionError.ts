/**
 * supabase.functions.invoke() throws away the response body whenever an
 * edge function returns a non-2xx status: `data` comes back `null`, and
 * `error` is just a FunctionsHttpError carrying the generic message
 * "Edge Function returned a non-2xx status code" — the real `{ error:
 * "..." }` JSON body every function here actually returns is only
 * reachable via `error.context`, a Response object that's readable once.
 * (Confirmed directly in @supabase/functions-js's FunctionsClient: any
 * `!response.ok` throws FunctionsHttpError(response) before the body is
 * ever parsed into `data`.)
 *
 * Every screen that calls an edge function needs this instead of the
 * `data?.error ?? error?.message` pattern — that pattern silently never
 * shows the real message for any actual failure, since every function's
 * jsonResponse() helper sets a matching non-2xx status on every error.
 */
import { FunctionsHttpError } from '@supabase/supabase-js';

export async function getInvokeErrorMessage(error: unknown, data: unknown, fallback: string): Promise<string> {
  // The 2xx-with-an-error-body case (some call sites check this too) —
  // handled first since it needs no async work.
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) {
    return String((data as { error: unknown }).error);
  }

  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body?.error) return String(body.error);
    } catch {
      // Response wasn't JSON (or was already consumed) — fall through.
    }
  }

  if (error instanceof Error) return error.message;
  return fallback;
}
