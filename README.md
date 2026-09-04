# Changeover Planner

An offline desktop application for planning weekly summer-camp equipment changeover. It keeps the familiar paper grid while calculating same-hill tent, cot, and floorboard movements behind the scenes.

## Included in this build

- Camp Blackhawk defaults with Wilderness (1–8), Checagau (9–15), and Pioneer (16–21)
- Custom camps, hills, text or numbered sites, week counts, and pairwise walking distances
- Troop requests, OPEN sites, early arrivals, stay-overs, item locks, special requests, and final-two-week seasonal closure
- Equal-weight tent/cot/floorboard optimization using same-hill distance
- One- or two-stop basement staging, adjustable in Advanced settings
- Supply-tent calculations and a one-versus-two prompt above 20 tents or 32 cots
- Separate Money Roll and Return All Extra Equipment modes, with site-specific road pickups for the commissioner
- Money Roll floorboard instructions that keep the weekly requirement dropped and stack only unused boards on cinder blocks
- Editable preferred and absolute-maximum floorboard stack heights
- Final recount workflow; only total tents and total cots are required for the next optimization
- Autosave after every edit, a synchronous final save when the app closes, complete `.changeover` backups, direct PDF export, and `.xlsx` export
- Separate seasons by year while copying the camp structure and distance grid into a clean new season
- Configurable master grids with optional wider Notes, hill final-count sheets, dense task slips, and commissioner delivery/pickup sheets
- Exact final site targets, per-hill item-feet statistics, and an adjustable difficulty score
- Automatic recalculation before preview/printing, US Letter layouts, and a single-sided print request
- Global interface zoom plus light, dark, and system themes

## Run from source

Use the bundled or system Node.js runtime, install dependencies with pnpm, then run:

```sh
pnpm start
```

## Tests and packaging

```sh
pnpm test
pnpm make
```

The macOS application and disk image are generated beneath `out/`. GitHub Actions is configured to build Apple Silicon macOS, Intel macOS, Windows x64, and Linux x64 on their native hosted systems. See [docs/RELEASING.md](docs/RELEASING.md) for the beginner-safe publishing checklist.

Automatic-update support is wired but intentionally disabled until the public GitHub repository, signed releases, and platform update artifacts exist. This prevents alpha builds from attempting an unsafe or incomplete update.

## Data safety

The working data is saved after every meaningful edit in Electron's per-user application-data directory. Writes are atomic: a temporary save is completed before replacing the prior working file. The app also performs a final synchronous save when its window closes, covering an edit made immediately before quitting. Complete backups are explicit, portable JSON documents with the `.changeover` extension; older `.campplan` files remain importable. Import always previews the camp names and backup date before replacement.

No account, server, AI service, or internet connection is required to use the installed application.
