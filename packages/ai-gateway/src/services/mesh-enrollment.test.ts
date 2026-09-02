// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, test } from 'bun:test';
import type { AuthResult } from '../types';
import { enrollMeshDevice } from './mesh-enrollment';

const auth: AuthResult = {
	isValid: true,
	tier: 'logged_in',
	accountPlan: 'free',
	deviceId: 'device',
	userId: 'user_screenpipe_123',
};

describe('mesh enrollment', () => {
	test('requires an authenticated Screenpipe account', async () => {
		const response = await enrollMeshDevice(
			{ ...auth, tier: 'anonymous', userId: undefined },
			{},
		);
		expect(response.status).toBe(401);
	});

	test('creates an isolated user and one-use key', async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = input.toString();
			requests.push({ url, init });
			if (url.includes('/api/v1/user?')) return Response.json({ users: [] });
			if (url.endsWith('/api/v1/user')) {
				return Response.json({ user: { id: '42', name: 'provisioned' } });
			}
			return Response.json({ preAuthKey: { key: 'one-use-key' } });
		}) as typeof fetch;

		const response = await enrollMeshDevice(auth, {
			HEADSCALE_CONTROL_URL: 'https://mesh.screenpipe.com/',
			HEADSCALE_API_KEY: 'admin-secret',
			MESH_NAMESPACE_SECRET: 'namespace-secret',
		}, undefined, fetcher);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			control_url: 'https://mesh.screenpipe.com',
			auth_key: 'one-use-key',
		});
		const createKey = requests.at(-1)!;
		expect(JSON.parse(createKey.init.body as string)).toMatchObject({
			user: '42',
			reusable: false,
			ephemeral: false,
		});
		expect(createKey.init.headers).toMatchObject({ Authorization: 'Bearer admin-secret' });
	});

	test('does not mint another key for the current account network', async () => {
		let calls = 0;
		const namespaceResponse = await enrollMeshDevice(
			auth,
			{ HEADSCALE_CONTROL_URL: 'https://mesh.screenpipe.com', HEADSCALE_API_KEY: 'secret', MESH_NAMESPACE_SECRET: 'namespace-secret' },
			new Request('https://api.screenpipe.com/v1/mesh/enroll', {
				method: 'POST',
				body: JSON.stringify({ network_id: 'wrong' }),
			}),
			(async (input: RequestInfo | URL, init: RequestInit = {}) => {
				calls += 1;
				const url = input.toString();
				if (url.includes('/api/v1/user?')) return Response.json({ users: [] });
				if (url.endsWith('/api/v1/user') && init.method === 'POST') {
					return Response.json({ user: { id: '42' } });
				}
				return Response.json({ preAuthKey: { key: 'key' } });
			}) as typeof fetch,
		);
		const networkId = (await namespaceResponse.json() as { network_id: string }).network_id;
		calls = 0;
		const response = await enrollMeshDevice(
			auth,
			{ HEADSCALE_CONTROL_URL: 'https://mesh.screenpipe.com', HEADSCALE_API_KEY: 'secret', MESH_NAMESPACE_SECRET: 'namespace-secret' },
			new Request('https://api.screenpipe.com/v1/mesh/enroll', {
				method: 'POST',
				body: JSON.stringify({ network_id: networkId }),
			}),
			(async () => {
				calls += 1;
				throw new Error('must not call headscale');
			}) as typeof fetch,
		);
		expect(response.status).toBe(200);
		expect(calls).toBe(0);
		expect(await response.json()).not.toHaveProperty('auth_key');
	});
});
