// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';
import path from 'node:path';
export default defineConfig({esbuild:{jsx:'automatic'},test:{environment:'jsdom',include:['replay-probe.test.tsx'],maxWorkers:1,minWorkers:1},resolve:{alias:{'@':path.resolve(__dirname),'gt-react':path.resolve(__dirname,'replay-i18n.ts')}}});
