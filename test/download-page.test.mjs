import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../docs/download.js', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('the public download page gives each supported computer an obvious download', () => {
  assert.match(page, /Download for Windows/);
  assert.match(page, /Apple Silicon Mac/);
  assert.match(page, /Intel Mac/);
  assert.match(page, /Download for Linux/);
  assert.match(page, /About the security warning/);
  assert.match(page, /publisher’s identity/);
  assert.doesNotMatch(page, /🪟|🍎|🐧/);
  assert.doesNotMatch(page, /recommendation-icon/);
  assert.match(page, /class="platform-icon windows-icon"/);
  assert.match(page, /class="platform-icon apple-icon"/);
  assert.match(page, /class="platform-icon linux-icon"/);
});

test('the download page discovers the newest official GitHub release', () => {
  assert.match(script, /api\.github\.com\/repos\/\$\{repository\}\/releases\/latest/);
  assert.match(script, /browser_download_url/);
  assert.match(script, /data-platform-card/);
});

test('future releases publish stable friendly download filenames', () => {
  for (const name of [
    'Changeover-Planner-Windows-Installer.msi',
    'Changeover-Planner-Windows-Portable.zip',
    'Changeover-Planner-Mac-Apple-Silicon.dmg',
    'Changeover-Planner-Mac-Intel.dmg',
    'Changeover-Planner-Linux-x64.zip'
  ]) {
    assert.match(releaseWorkflow, new RegExp(name.replaceAll('.', '\\.')));
  }
});
