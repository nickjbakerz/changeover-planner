import { readFile } from 'node:fs/promises';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const rendererSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const visibleVersion = rendererSource.match(/const APP_VERSION = '([^']+)'/)?.[1];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  throw new Error(`package.json has an invalid release version: ${packageMetadata.version}`);
}

if (visibleVersion !== packageMetadata.version) {
  throw new Error(`Version mismatch: package.json is ${packageMetadata.version}, but the About page is ${visibleVersion || 'missing'}.`);
}

if (!packageMetadata.repository?.url || !packageMetadata.changeoverPlanner?.updateRepository) {
  throw new Error('GitHub repository or updater metadata is missing.');
}

console.log(`Release metadata verified for Changeover Planner ${packageMetadata.version}.`);
