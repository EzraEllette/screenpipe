// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { RequestBody } from '../types';
import { OpenAIProvider } from './openai';

export const SCREENPIPE_GLM_MODEL = 'glm-5.3-flash-reap50-iq3m';
const DIRECT_GLM_BASE_URL = 'https://pii.screenpipe.containers.tinfoil.dev/glm/v1';

/**
 * Text-only GLM served beside the privacy filter in Screenpipe's Tinfoil CVM.
 * Requests may go directly to the enclave or through Cloudflare AI Gateway's
 * `custom-tinfoil` provider; both paths use the container-owned bearer secret.
 */
export class ScreenpipeGlmProvider extends OpenAIProvider {
	supportsTools = false;
	supportsVision = false;

	constructor(
		apiKey: string,
		baseURL = DIRECT_GLM_BASE_URL,
		defaultHeaders?: Record<string, string | null | undefined>,
		maxRetries = 0,
	) {
		super(apiKey, baseURL, defaultHeaders, maxRetries);
	}

	async createCompletion(body: RequestBody): Promise<Response> {
		return super.createCompletion({ ...body, model: SCREENPIPE_GLM_MODEL });
	}

	async createStreamingCompletion(body: RequestBody): Promise<ReadableStream> {
		return super.createStreamingCompletion({ ...body, model: SCREENPIPE_GLM_MODEL });
	}
}

export function isScreenpipeGlmModel(model: string): boolean {
	return model.toLowerCase() === SCREENPIPE_GLM_MODEL;
}
