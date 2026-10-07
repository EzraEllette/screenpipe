// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('./',import.meta.url)),'gt-react':fileURLToPath(new URL('./eval-media-translation.ts',import.meta.url))}},esbuild:{jsx:'automatic'},test:{environment:'jsdom',include:['components/rewind/eval-media-file-url.test.tsx'],maxWorkers:1,minWorkers:1}});
