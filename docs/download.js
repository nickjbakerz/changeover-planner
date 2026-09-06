const repository = 'nickjbakerz/changeover-planner';
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

const assetRules = {
  windows: (name) => /Windows-Installer\.msi$/i.test(name),
  macArm: (name) => /arm64\.dmg$/i.test(name) || /Mac-Apple-Silicon\.dmg$/i.test(name),
  macIntel: (name) => /x64\.dmg$/i.test(name) || /Mac-Intel\.dmg$/i.test(name),
  linux: (name) => /linux-x64.*\.zip$/i.test(name) || /Linux-x64\.zip$/i.test(name)
};

function readableSize(bytes) {
  const megabytes = Number(bytes) / 1_048_576;
  return Number.isFinite(megabytes) ? `${Math.round(megabytes)} MB` : '';
}

function setDownload(key, elementId, metaId, release, description) {
  const asset = release.assets.find((candidate) => assetRules[key](candidate.name));
  if (!asset) return;
  document.getElementById(elementId).href = asset.browser_download_url;
  document.getElementById(metaId).textContent = `${description} · ${readableSize(asset.size)}`;
}

async function loadLatestRelease() {
  try {
    const response = await fetch(`${releaseApi}?checked_at=${Date.now()}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/i, '');
    document.getElementById('release-status').textContent = `Latest release: Version ${version}`;
    setDownload('windows', 'download-windows', 'meta-windows', release, `Version ${version} · Windows installer`);
    setDownload('macArm', 'download-mac-arm', 'meta-mac-arm', release, `Apple Silicon · Version ${version}`);
    setDownload('macIntel', 'download-mac-intel', 'meta-mac-intel', release, `Intel · Version ${version}`);
    setDownload('linux', 'download-linux', 'meta-linux', release, `Version ${version} · ZIP package`);
  } catch {
    document.getElementById('release-status').textContent = 'Version 0.10.4 is ready to download';
  }
}

function recommendForComputer() {
  const agent = navigator.userAgent.toLowerCase();
  let platform = null;
  let copy = '';
  if (agent.includes('windows')) {
    platform = 'windows';
    copy = 'Choose Download for Windows below and open the installer.';
  } else if (agent.includes('macintosh') || agent.includes('mac os')) {
    platform = 'mac';
    copy = 'Choose Apple Silicon or Intel using About This Mac.';
  } else if (agent.includes('linux') && !agent.includes('android')) {
    platform = 'linux';
    copy = 'Choose Download for Linux below.';
  }

  if (!platform) return;
  document.querySelector(`[data-platform-card="${platform}"]`)?.classList.add('recommended');
  const banner = document.getElementById('recommendation');
  document.getElementById('recommendation-copy').textContent = copy;
  banner.hidden = false;
}

recommendForComputer();
loadLatestRelease();
