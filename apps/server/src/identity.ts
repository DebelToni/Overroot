import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { HttpError } from './errors.js';

const userSchema = z.object({ id: z.string().min(1).max(256), email: z.email().max(254), nickname: z.string().min(1).max(256), approved: z.literal(true) });
const policyKey = z.string().min(1).max(64);
const serviceFields = {
  service_id: z.literal('overroot'),
  role: policyKey,
  permissions: z.array(policyKey).max(64)
};
const grantSchema = z.object({ session_id: z.string().min(1).max(512), expires_at: z.number().int().positive(), ...serviceFields, user: userSchema });
const introspectionSchema = z.discriminatedUnion('active', [z.object({ active: z.literal(false) }), z.object({ active: z.literal(true), expires_at: z.number().int().positive(), ...serviceFields, user: userSchema })]);
export type IdentityGrant = z.infer<typeof grantSchema>;
export type Introspection = z.infer<typeof introspectionSchema>;
export interface IdentityProvider {
  readonly origin: string;
  readonly callback: string;
  exchange(code: string, verifier: string): Promise<IdentityGrant>;
  introspect(sessionId: string): Promise<Introspection>;
  revoke(sessionId: string): Promise<void>;
}

export class AccountsProvider implements IdentityProvider {
  readonly origin: string;
  readonly callback: string;
  private readonly base: string;
  private readonly secret: string;

  constructor(publicUrl: string) {
    const origin = process.env.OVERROOT_IDENTITY_ORIGIN;
    const secret = process.env.OVERROOT_IDENTITY_CLIENT_SECRET;
    const backchannel = process.env.OVERROOT_IDENTITY_BASE_URL;
    if (!origin || !secret || !backchannel) throw new Error('Shared account configuration is required; local password auth is disabled');
    if (secret.length < 32) throw new Error('OVERROOT_IDENTITY_CLIENT_SECRET must contain at least 32 characters');
    const issuer = new URL(origin);
    const base = new URL(backchannel);
    if (issuer.origin !== origin || issuer.protocol !== 'https:' || issuer.username || issuer.password ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
        !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) {
      throw new Error('Invalid identity origin/backchannel URL');
    }
    const app = new URL(publicUrl);
    if (app.origin !== publicUrl || app.protocol !== 'https:') throw new Error('Identity callback requires an exact HTTPS app origin');
    this.origin = origin;
    this.callback = `${publicUrl}/api/v1/auth/callback`;
    this.base = base.origin;
    this.secret = secret;
  }

  private call(endpoint: string, input: Record<string, string>): Promise<unknown> {
    const url = new URL(`/api/accounts/${endpoint}`, this.base);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = Buffer.from(JSON.stringify({ client_id: 'overroot', ...input }));
    // Native request preserves the issuer Host on a literal-loopback connection.
    // No redirect handling, browser cookies, WAN fallback or fetch Host rewriting.
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'POST', signal: AbortSignal.timeout(3000), maxHeaderSize: 16_384,
        headers: {
          Host: new URL(this.origin).host, 'X-Accounts-Client-Key': this.secret,
          'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json'
        }
      }, (response) => {
        response.once('error', () => reject(unavailable()));
        response.once('aborted', () => reject(unavailable()));
        if (response.statusCode !== 200) {
          response.destroy();
          reject(unavailable());
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            req.destroy(); response.destroy(); reject(unavailable());
          } else chunks.push(chunk);
        });
        response.once('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(unavailable()); }
        });
      });
      req.once('error', () => reject(unavailable()));
      req.end(body);
    }).catch(() => { throw unavailable(); });
  }

  async exchange(code: string, verifier: string): Promise<IdentityGrant> {
    const result = grantSchema.safeParse(await this.call('token', { grant_type: 'authorization_code', redirect_uri: this.callback, code, code_verifier: verifier }));
    if (!result.success || result.data.expires_at * 1000 <= Date.now()) throw unavailable();
    return result.data;
  }
  async introspect(sessionId: string): Promise<Introspection> {
    const result = introspectionSchema.safeParse(await this.call('introspect', { session_id: sessionId }));
    if (!result.success) throw unavailable();
    return result.data;
  }
  async revoke(sessionId: string): Promise<void> {
    const result = await this.call('revoke', { session_id: sessionId });
    if (!z.object({ ok: z.literal(true) }).safeParse(result).success) throw unavailable();
  }
}
export function unavailable(): HttpError {
  return new HttpError(503, 'Shared accounts are temporarily unavailable. Try again shortly.', 'identity_unavailable');
}
