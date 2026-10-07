// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';
import path from 'node:path';
export default defineConfig({test:{environment:'node',include:['recency-probe.test.ts'],maxWorkers:1,minWorkers:1},resolve:{alias:{'@':path.resolve(__dirname)}}});
