import serverless from 'serverless-http';
import { serverlessApp } from '../serverless';

/** Netlify's event, as far as this handler touches it. */
interface NetlifyEvent {
  path: string;
  headers: Record<string, string | undefined>;
  requestContext?: { identity?: { sourceIp?: string } };
}

let handle: serverless.Handler | undefined;

/**
 * The whole API as one Netlify Function. netlify.toml rewrites /api/* here; Express still
 * sees /api/… paths.
 */
export async function handler(event: NetlifyEvent, context: object) {
  const { app } = await serverlessApp();
  handle ??= serverless(app);
  // The rewrite may hand over the function's own path; Express routes are under /api.
  const path = event.path.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
  // Netlify sets this header itself, so clients can't spoof it. Rate limits by IP use it.
  const sourceIp = event.headers['x-nf-client-connection-ip'] ?? event.requestContext?.identity?.sourceIp ?? '';
  return handle({ ...event, path, requestContext: { ...event.requestContext, identity: { sourceIp } } }, context);
}
