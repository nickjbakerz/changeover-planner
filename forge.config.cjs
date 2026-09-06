const path = require('node:path');

module.exports = {
  packagerConfig: {
    asar: true,
    ignore: [
      /^\/node_modules\/\.pnpm(?:\/|$)/,
      /^\/(?:out|outputs|test|work)(?:\/|$)/
    ],
    name: 'Changeover Planner',
    executableName: 'Changeover Planner',
    appBundleId: 'org.campchangeover.planner',
    appCategoryType: 'public.app-category.productivity',
    icon: path.resolve(__dirname, 'src/assets/app-icon'),
    download: {
      cacheRoot: './work/electron-cache'
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-wix',
      platforms: ['win32'],
      config: {
        manufacturer: 'Nick Baker',
        language: 1033,
        exe: 'Changeover Planner.exe',
        icon: path.resolve(__dirname, 'src/assets/app-icon.ico'),
        arch: 'x64',
        defaultInstallMode: 'perMachine',
        ui: false
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux']
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO'
      }
    }
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'nickjbakerz',
          name: 'changeover-planner'
        },
        prerelease: true,
        draft: true
      }
    }
  ]
};
