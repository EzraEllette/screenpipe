// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';import {resolve} from 'node:path';export default defineConfig({resolve:{alias:{'@':resolve(process.cwd())}},test:{environment:'node',include:['eval-codex-images.test.ts'],pool:'forks',minWorkers:1,maxWorkers:1}});
