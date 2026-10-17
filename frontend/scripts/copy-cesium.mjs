// Copies Cesium's static runtime assets (workers, widgets CSS, textures) into public/cesium
// so they are served at /cesium/ in dev and copied into dist/ by the build.
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'node_modules', 'cesium', 'Build', 'Cesium');
const dest = join(process.cwd(), 'public', 'cesium');

if (!existsSync(src)) {
  console.error('Cesium build directory not found. Run `npm install` first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const dir of ['Assets', 'Workers', 'ThirdParty', 'Widgets']) {
  const from = join(src, dir);
  const to = join(dest, dir);
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
  cpSync(from, to, { recursive: true });
  console.log(`copied cesium/${dir}`);
}
