// Static hosts serve files, not client-side routes: a direct load of /mission (the home page's
// "Simulate Collision" link, a refresh, a shared URL) would 404. The app picks its page from the
// pathname in main.tsx, so a copy of index.html at each route makes every host serve it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
const routes = ['mission'];

for (const route of routes) {
  mkdirSync(resolve(dist, route), { recursive: true });
  copyFileSync(resolve(dist, 'index.html'), resolve(dist, route, 'index.html'));
  console.log(`wrote dist/${route}/index.html`);
}
