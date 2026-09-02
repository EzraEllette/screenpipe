// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { AuthResult, Env } from '../types';

type HeadscaleUser = { id?: string; name?: string };
type HeadscaleUsersResponse = { users?: HeadscaleUser[] };
type HeadscaleCreateUserResponse = { user?: HeadscaleUser };
type HeadscaleCreateKeyResponse = { preAuthKey?: { key?: string; expiration?: string } };

type MeshEnv = Pick<Env, 'HEADSCALE_CONTROL_URL' | 'HEADSCALE_API_KEY' | 'MESH_NAMESPACE_SECRET'>;
type Fetcher = typeof fetch;

function json(status: number, body: Record<string, unknown>): Response {
	return Response.json(body, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	});
}

async function accountNamespace(userId: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sp-${hex.slice(0, 32)}`;
}

async function headscaleRequest<T>(
	env: MeshEnv,
	path: string,
	init: RequestInit,
	fetcher: Fetcher,
): Promise<T> {
	const base = env.HEADSCALE_CONTROL_URL!.replace(/\/$/, '');
	const response = await fetcher(`${base}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${env.HEADSCALE_API_KEY}`,
			'Content-Type': 'application/json',
			...init.headers,
		},
	});
	if (!response.ok) {
		throw new Error(`headscale ${path} returned ${response.status}`);
	}
	return response.json() as Promise<T>;
}

async function ensureUser(
	env: MeshEnv,
	name: string,
	fetcher: Fetcher,
): Promise<HeadscaleUser> {
	const list = async () => headscaleRequest<HeadscaleUsersResponse>(
		env,
		`/api/v1/user?name=${encodeURIComponent(name)}`,
		{ method: 'GET' },
		fetcher,
	);
	const existing = (await list()).users?.find((user) => user.name === name);
	if (existing?.id) return existing;

	try {
		const created = await headscaleRequest<HeadscaleCreateUserResponse>(
			env,
			'/api/v1/user',
			{ method: 'POST', body: JSON.stringify({ name }) },
			fetcher,
		);
		if (created.user?.id) return created.user;
	} catch {
		// Another device for this account may have won the create race. Resolve
		// the authoritative row before failing enrollment.
		const raced = (await list()).users?.find((user) => user.name === name);
		if (raced?.id) return raced;
		throw new Error('headscale user provisioning failed');
	}
	throw new Error('headscale user provisioning returned no user id');
}

export async function enrollMeshDevice(
	auth: AuthResult,
	env: MeshEnv,
	request?: Request,
	fetcher: Fetcher = fetch,
): Promise<Response> {
	if (auth.tier === 'anonymous' || auth.service || !auth.userId) {
		return json(401, {
			error: 'screenpipe_account_required',
			message: 'sign in to Screenpipe to connect this device',
		});
	}
	if (!env.HEADSCALE_CONTROL_URL || !env.HEADSCALE_API_KEY || !env.MESH_NAMESPACE_SECRET) {
		return json(503, {
			error: 'mesh_not_configured',
			message: 'Screenpipe device networking is not configured',
		});
	}

	try {
		const namespace = await accountNamespace(auth.userId, env.MESH_NAMESPACE_SECRET);
		let currentNetworkId: string | undefined;
		if (request) {
			try {
				const body = await request.json() as { network_id?: unknown };
				if (typeof body.network_id === 'string') currentNetworkId = body.network_id;
			} catch {
				// An empty body is the normal first enrollment request.
			}
		}
		if (currentNetworkId === namespace) {
			return json(200, {
				control_url: env.HEADSCALE_CONTROL_URL.replace(/\/$/, ''),
				network_id: namespace,
			});
		}
		const user = await ensureUser(env, namespace, fetcher);
		const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const created = await headscaleRequest<HeadscaleCreateKeyResponse>(
			env,
			'/api/v1/preauthkey',
			{
				method: 'POST',
				body: JSON.stringify({
					user: user.id,
					reusable: false,
					ephemeral: false,
					expiration,
					aclTags: [],
				}),
			},
			fetcher,
		);
		if (!created.preAuthKey?.key) {
			throw new Error('headscale key provisioning returned no key');
		}
		return json(200, {
			control_url: env.HEADSCALE_CONTROL_URL.replace(/\/$/, ''),
			network_id: namespace,
			auth_key: created.preAuthKey.key,
			expires_at: created.preAuthKey.expiration ?? expiration,
		});
	} catch (error) {
		console.error('mesh enrollment failed', error instanceof Error ? error.message : 'unknown error');
		return json(502, {
			error: 'mesh_enrollment_failed',
			message: 'Screenpipe could not enroll this device',
		});
	}
}
