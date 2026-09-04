import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareVersions, latestRelease, selectDownloadAsset } = require('../src/core/updates.cjs');

test('release versions compare numerically and understand prereleases', () => {
  assert.equal(compareVersions('v0.9.0', '0.8.10'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('v0.8.0', '0.8.0'), 0);
});

test('latest release ignores drafts but includes public prereleases', () => {
  const releases = [
    { tag_name: 'v9.0.0', draft: true },
    { tag_name: 'v0.8.0', draft: false },
    { tag_name: 'v0.9.0-beta.1', draft: false, prerelease: true }
  ];
  assert.equal(latestRelease(releases).tag_name, 'v0.9.0-beta.1');
});

test('the correct package is selected for each supported computer', () => {
  const release = { assets: [
    { name: 'Changeover Planner-0.8.0-arm64.dmg' },
    { name: 'Changeover Planner-0.8.0-x64.dmg' },
    { name: 'Changeover Planner-win32-x64-0.8.0.zip' },
    { name: 'Changeover Planner-linux-x64-0.8.0.zip' },
    { name: 'ChangeoverPlannerSetup.exe' }
  ] };
  assert.match(selectDownloadAsset(release, 'darwin', 'arm64').name, /arm64\.dmg$/);
  assert.match(selectDownloadAsset(release, 'darwin', 'x64').name, /x64\.dmg$/);
  assert.match(selectDownloadAsset(release, 'win32', 'x64').name, /Setup\.exe$/);
  assert.match(selectDownloadAsset(release, 'linux', 'x64').name, /linux-x64/);
});
