// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { AuthResult, Env } from '../types';

const TAILSCALE_API = 'https://api.tailscale.com/api/v2';
const AUTH_KEY_EXPIRY_SECONDS = 60 * 60;

type MeshEnv = Pick<
	Env,
	| 'DB'
	| 'TAILSCALE_ORGANIZATION'
	| 'TAILSCALE_OAUTH_CLIENT_ID'
	| 'TAILSCALE_OAUTH_CLIENT_SECRET'
	| 'MESH_NAMESPACE_SECRET'
	| 'MESH_CREDENTIAL_ENCRYPTION_KEY'
>;

type TailnetCredentials = {
	tailnetId: string;
	clientId: string;
	clientSecret: string;
};

type StoredTailnet = {
	status: 'provisioning' | 'ready';
	tailnetId?: string;
	credentialsCiphertext?: string;
};

export type MeshTailnetStore = {
	get(namespace: string): Promise<StoredTailnet | null>;
	claim(namespace: string): Promise<boolean>;
	save(namespace: string, tailnetId: string, credentialsCiphertext: string): Promise<void>;
};

type EnrollmentDependencies = {
	fetcher?: typeof fetch;
	store?: MeshTailnetStore;
};

type OAuthTokenResponse = { access_token?: string };
type CreateTailnetResponse = {
	id?: string;
	alreadyExists?: boolean;
	oauthClient?: { id?: string; secret?: string };
};
type CreateAuthKeyResponse = { key?: string; expires?: string };

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

function bytesToBase64(bytes: Uint8Array): string {
	let value = '';
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
	const decoded = atob(value);
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function credentialKey(encoded: string): Promise<CryptoKey> {
	const raw = base64ToBytes(encoded);
	if (raw.byteLength !== 32) {
		throw new Error('mesh credential encryption key must decode to 32 bytes');
	}
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptCredentials(
	credentials: TailnetCredentials,
	namespace: string,
	encodedKey: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(namespace) },
		await credentialKey(encodedKey),
		plaintext,
	);
	const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.byteLength);
	return bytesToBase64(combined);
}

async function decryptCredentials(
	encoded: string,
	namespace: string,
	encodedKey: string,
): Promise<TailnetCredentials> {
	const combined = base64ToBytes(encoded);
	if (combined.byteLength <= 12) throw new Error('mesh credentials are invalid');
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: combined.slice(0, 12),
			additionalData: new TextEncoder().encode(namespace),
		},
		await credentialKey(encodedKey),
		combined.slice(12),
	);
	return JSON.parse(new TextDecoder().decode(plaintext)) as TailnetCredentials;
}

function d1Store(db: D1Database): MeshTailnetStore {
	return {
		async get(namespace) {
			const row = await db.prepare(`
				SELECT status, tailnet_id, credentials_ciphertext
				FROM mesh_tailnets WHERE account_namespace = ?
			`).bind(namespace).first<{
				status: 'provisioning' | 'ready';
				tailnet_id: string | null;
				credentials_ciphertext: string | null;
			}>();
			if (!row) return null;
			return {
				status: row.status,
				tailnetId: row.tailnet_id ?? undefined,
				credentialsCiphertext: row.credentials_ciphertext ?? undefined,
			};
		},
		async claim(namespace) {
			const result = await db.prepare(`
				INSERT OR IGNORE INTO mesh_tailnets (account_namespace, status)
				VALUES (?, 'provisioning')
			`).bind(namespace).run();
			return (result.meta.changes ?? 0) === 1;
		},
		async save(namespace, tailnetId, credentialsCiphertext) {
			await db.prepare(`
				UPDATE mesh_tailnets
				SET status = 'ready', tailnet_id = ?, credentials_ciphertext = ?, updated_at = CURRENT_TIMESTAMP
				WHERE account_namespace = ? AND status = 'provisioning'
			`).bind(tailnetId, credentialsCiphertext, namespace).run();
		},
	};
}

async function oauthToken(
	clientId: string,
	clientSecret: string,
	scope: string,
	fetcher: typeof fetch,
): Promise<string> {
	const body = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: clientId,
		client_secret: clientSecret,
		scope,
	});
	const response = await fetcher(`${TAILSCALE_API}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!response.ok) throw new Error(`Tailscale OAuth returned ${response.status}`);
	const token = await response.json() as OAuthTokenResponse;
	if (!token.access_token) throw new Error('Tailscale OAuth returned no access token');
	return token.access_token;
}

async function tailscaleRequest<T>(
	path: string,
	token: string,
	init: RequestInit,
	fetcher: typeof fetch,
): Promise<T> {
	const response = await fetcher(`${TAILSCALE_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...init.headers,
		},
	});
	if (!response.ok) throw new Error(`Tailscale ${path} returned ${response.status}`);
	return response.json() as Promise<T>;
}

async function provisionTailnet(
	env: MeshEnv,
	namespace: string,
	store: MeshTailnetStore,
	fetcher: typeof fetch,
): Promise<TailnetCredentials> {
	const stored = await store.get(namespace);
	if (stored?.status === 'ready' && stored.tailnetId && stored.credentialsCiphertext) {
		return decryptCredentials(
			stored.credentialsCiphertext,
			namespace,
			env.MESH_CREDENTIAL_ENCRYPTION_KEY!,
		);
	}
	if (stored?.status === 'provisioning' || !(await store.claim(namespace))) {
		throw new Error('Tailscale tailnet provisioning is already in progress');
	}

	const organizationToken = await oauthToken(
		env.TAILSCALE_OAUTH_CLIENT_ID!,
		env.TAILSCALE_OAUTH_CLIENT_SECRET!,
		'tailnets',
		fetcher,
	);
	const created = await tailscaleRequest<CreateTailnetResponse>(
		`/organizations/${encodeURIComponent(env.TAILSCALE_ORGANIZATION!)}/tailnets`,
		organizationToken,
		{
			method: 'POST',
			body: JSON.stringify({ displayName: `Screenpipe-${namespace.slice(3)}` }),
		},
		fetcher,
	);
	if (created.alreadyExists || !created.id || !created.oauthClient?.id || !created.oauthClient.secret) {
		throw new Error('Tailscale did not return credentials for the new API-only tailnet');
	}
	const credentials: TailnetCredentials = {
		tailnetId: created.id,
		clientId: created.oauthClient.id,
		clientSecret: created.oauthClient.secret,
	};
	await store.save(
		namespace,
		credentials.tailnetId,
		await encryptCredentials(credentials, namespace, env.MESH_CREDENTIAL_ENCRYPTION_KEY!),
	);
	return credentials;
}

async function currentNetworkId(request?: Request): Promise<string | undefined> {
	if (!request) return undefined;
	try {
		const body = await request.json() as { network_id?: unknown };
		return typeof body.network_id === 'string' ? body.network_id : undefined;
	} catch {
		return undefined;
	}
}

export async function enrollMeshDevice(
	auth: AuthResult,
	env: MeshEnv,
	request?: Request,
	dependencies: EnrollmentDependencies = {},
): Promise<Response> {
	if (auth.tier === 'anonymous' || auth.service || !auth.userId) {
		return json(401, {
			error: 'screenpipe_account_required',
			message: 'sign in to Screenpipe to connect this device',
		});
	}
	if (
		!env.DB
		|| !env.TAILSCALE_ORGANIZATION
		|| !env.TAILSCALE_OAUTH_CLIENT_ID
		|| !env.TAILSCALE_OAUTH_CLIENT_SECRET
		|| !env.MESH_NAMESPACE_SECRET
		|| !env.MESH_CREDENTIAL_ENCRYPTION_KEY
	) {
		return json(503, {
			error: 'mesh_not_configured',
			message: 'Screenpipe device networking is not configured',
		});
	}

	try {
		const fetcher = dependencies.fetcher ?? fetch;
		const namespace = await accountNamespace(auth.userId, env.MESH_NAMESPACE_SECRET);
		const credentials = await provisionTailnet(
			env,
			namespace,
			dependencies.store ?? d1Store(env.DB),
			fetcher,
		);
		if (await currentNetworkId(request) === credentials.tailnetId) {
			return json(200, { network_id: credentials.tailnetId });
		}

		const tailnetToken = await oauthToken(
			credentials.clientId,
			credentials.clientSecret,
			'auth_keys',
			fetcher,
		);
		const created = await tailscaleRequest<CreateAuthKeyResponse>(
			`/tailnet/${encodeURIComponent(credentials.tailnetId)}/keys`,
			tailnetToken,
			{
				method: 'POST',
				body: JSON.stringify({
					capabilities: {
						devices: {
							create: {
								reusable: false,
								ephemeral: false,
								preauthorized: true,
							},
						},
					},
					expirySeconds: AUTH_KEY_EXPIRY_SECONDS,
					description: 'Screenpipe device enrollment',
				}),
			},
			fetcher,
		);
		if (!created.key) throw new Error('Tailscale returned no device auth key');
		return json(200, {
			network_id: credentials.tailnetId,
			auth_key: created.key,
			expires_at: created.expires,
		});
	} catch (error) {
		console.error('mesh enrollment failed', error instanceof Error ? error.message : 'unknown error');
		return json(502, {
			error: 'mesh_enrollment_failed',
			message: 'Screenpipe could not enroll this device',
		});
	}
}
