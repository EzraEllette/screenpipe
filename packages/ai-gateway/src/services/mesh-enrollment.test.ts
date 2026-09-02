// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, test } from 'bun:test';
import type { AuthResult, Env } from '../types';
import { enrollMeshDevice, type MeshTailnetStore } from './mesh-enrollment';

const auth: AuthResult = {
	isValid: true,
	tier: 'logged_in',
	accountPlan: 'free',
	deviceId: 'device',
	userId: 'user_screenpipe_123',
};

const encryptionKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function meshEnv(): Env {
	return {
		DB: {} as D1Database,
		TAILSCALE_ORGANIZATION: 'screenpipe-org',
		TAILSCALE_OAUTH_CLIENT_ID: 'organization-client',
		TAILSCALE_OAUTH_CLIENT_SECRET: 'organization-secret',
		MESH_NAMESPACE_SECRET: 'namespace-secret',
		MESH_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
	} as Env;
}

function memoryStore(): MeshTailnetStore {
	const records = new Map<string, {
		status: 'provisioning' | 'ready';
		tailnetId?: string;
		credentialsCiphertext?: string;
	}>();
	return {
		async get(namespace) {
			return records.get(namespace) ?? null;
		},
		async claim(namespace) {
			if (records.has(namespace)) return false;
			records.set(namespace, { status: 'provisioning' });
			return true;
		},
		async save(namespace, tailnetId, credentialsCiphertext) {
			records.set(namespace, { status: 'ready', tailnetId, credentialsCiphertext });
		},
	};
}

function tailscaleFetcher(requests: Array<{ url: string; init: RequestInit }>): typeof fetch {
	let tokenCalls = 0;
	return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = input.toString();
		requests.push({ url, init });
		if (url.endsWith('/oauth/token')) {
			tokenCalls += 1;
			return Response.json({ access_token: tokenCalls === 1 ? 'organization-token' : 'tailnet-token' });
		}
		if (url.includes('/organizations/')) {
			return Response.json({
				id: 'tailnet-account-123',
				oauthClient: { id: 'tailnet-client', secret: 'tailnet-secret' },
			});
		}
		return Response.json({ key: 'tskey-auth-one-use', expires: '2026-09-02T01:00:00Z' });
	}) as typeof fetch;
}

describe('mesh enrollment', () => {
	test('requires an authenticated Screenpipe account', async () => {
		const response = await enrollMeshDevice(
			{ ...auth, tier: 'anonymous', userId: undefined },
			{} as Env,
		);
		expect(response.status).toBe(401);
	});

	test('creates a private Tailscale tailnet and one-use device key', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const response = await enrollMeshDevice(auth, meshEnv(), undefined, {
			fetcher: tailscaleFetcher(requests),
			store: memoryStore(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			network_id: 'tailnet-account-123',
			auth_key: 'tskey-auth-one-use',
		});
		expect(requests.map(({ url }) => url)).toEqual([
			'https://api.tailscale.com/api/v2/oauth/token',
			'https://api.tailscale.com/api/v2/organizations/screenpipe-org/tailnets',
			'https://api.tailscale.com/api/v2/oauth/token',
			'https://api.tailscale.com/api/v2/tailnet/tailnet-account-123/keys',
		]);
		const organizationTokenBody = new URLSearchParams(requests[0].init.body as URLSearchParams);
		expect(organizationTokenBody.get('grant_type')).toBe('client_credentials');
		expect(organizationTokenBody.get('scope')).toBe('tailnets');
		const tailnetTokenBody = new URLSearchParams(requests[2].init.body as URLSearchParams);
		expect(tailnetTokenBody.get('scope')).toBe('auth_keys');
		const tailnetBody = JSON.parse(requests[1].init.body as string);
		expect(tailnetBody.displayName).toMatch(/^Screenpipe-[a-f0-9]{32}$/);
		const keyBody = JSON.parse(requests[3].init.body as string);
		expect(keyBody).toMatchObject({
			capabilities: {
				devices: {
					create: { reusable: false, ephemeral: false, preauthorized: true },
				},
			},
			expirySeconds: 3600,
		});
	});

	test('reuses the account tailnet without minting another key for existing state', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const store = memoryStore();
		const fetcher = tailscaleFetcher(requests);
		const first = await enrollMeshDevice(auth, meshEnv(), undefined, { fetcher, store });
		const networkId = (await first.json() as { network_id: string }).network_id;
		requests.length = 0;

		const response = await enrollMeshDevice(
			auth,
			meshEnv(),
			new Request('https://api.screenpipe.com/v1/mesh/enroll', {
				method: 'POST',
				body: JSON.stringify({ network_id: networkId }),
			}),
			{
				store,
				fetcher: (async () => {
					throw new Error('must not call Tailscale for existing node state');
				}) as typeof fetch,
			},
		);
		expect(response.status).toBe(200);
		expect(requests).toHaveLength(0);
		expect(await response.json()).toEqual({ network_id: networkId });
	});
});
