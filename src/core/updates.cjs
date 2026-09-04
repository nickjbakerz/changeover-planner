function versionParts(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  const [numbers, prerelease = ''] = normalized.split('-', 2);
  return {
    numbers: numbers.split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease
  };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.numbers.length, b.numbers.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function latestRelease(releases = []) {
  return releases
    .filter((release) => release && !release.draft && release.tag_name)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}

function selectDownloadAsset(release, platform, arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const candidates = assets.map((asset) => ({ asset, name: String(asset.name || '').toLowerCase() }));
  const find = (...patterns) => candidates.find(({ name }) => patterns.every((pattern) => name.includes(pattern)))?.asset;

  if (platform === 'darwin') {
    return find(`-${arch}.dmg`) || find('darwin', arch, '.zip') || find(arch, '.dmg') || null;
  }
  if (platform === 'win32') {
    return find('setup', '.exe') || find('win32', arch, '.zip') || find('windows', arch, '.zip') || null;
  }
  if (platform === 'linux') {
    return find('linux', arch, '.zip') || find('linux', '.zip') || null;
  }
  return null;
}

module.exports = { compareVersions, latestRelease, selectDownloadAsset };
