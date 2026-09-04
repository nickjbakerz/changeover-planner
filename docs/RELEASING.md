# Releasing Changeover Planner

This is the beginner-safe release checklist. The application data stored on each commissioner's computer is separate from the program files and is never included in this repository.

## Prepared build targets

- Apple Silicon macOS: DMG and ZIP
- Intel macOS: DMG and ZIP
- Windows x64: Setup EXE, update package, and ZIP
- Linux x64: ZIP (lower priority)
- Automatic tests for every change to `main`
- A tag-based workflow that builds on the correct operating systems and attaches installers to a GitHub prerelease

## First GitHub upload

1. Decide whether the repository will be public or private. Public is required for the free Electron update service.
2. Create an empty GitHub repository named `changeover-planner` under `nickjbakerz`. Do not initialize it with a README because this folder already has one.
3. Connect this local repository to that GitHub repository.
4. Push the `main` branch.
5. Open the Actions tab on GitHub and confirm that **Checks** passes.

## Creating an alpha release

1. Update the version in `package.json`, such as `0.8.1`.
2. Run `pnpm test` locally.
3. Commit the version change.
4. Create and push the matching tag, such as `v0.8.1`.
5. GitHub Actions builds all four platform variants and creates a prerelease containing the downloadable files.

Never place Apple certificates, Windows certificates, passwords, tokens, or `.env` files in the repository.

## Automatic-update gate

The updater wiring is present, but `changeoverPlanner.updatesEnabled` remains `false`. Do not switch it on until all of these are true:

- The GitHub repository is public.
- At least one correctly tagged, non-draft, non-prerelease release exists.
- The release contains the macOS ZIP and Windows Squirrel files.
- macOS builds are signed with an Apple Developer ID certificate and notarized.
- Windows signing has been considered; unsigned Windows installers show a SmartScreen warning.

Once those requirements are satisfied, set `updatesEnabled` to `true`, create one final manually installed release, and test an update from that version to a newer version on both macOS and Windows.
