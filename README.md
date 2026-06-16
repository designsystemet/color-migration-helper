# Color migration helper

Figma plugin for migrating Core UI Kit files from color variants to variable modes.

## What it does

The plugin opens on a landing screen with two workflows:

- **Update library** — run in the library file. Three steps, in order:
  1. **Prepare** — renames the `Main color` collection to `Color` and strips the `color/main/` prefix off its variables. The plugin checks the current state on entry and only offers the action when needed.
  2. **Remove variants** — removes `neutral`/`support` (and any semantic) color variants from component sets and cleans up the variant names. `Alert` and `ValidationMessage` keep their variants but have their paints moved to `Color` + modes.
  3. **Fix in library** — swaps example instances whose old variant was removed to the matching current variant and sets the right color mode.

- **Update sketches** — run in a sketch file after the library has been migrated and republished. Updates instances that are stuck on the pre-migration library version and sets the appropriate color mode.

Both instance flows (Fix in library / Update sketches) also clean up loose `Support color` bindings that live directly on layers (frames, text, etc.), share one support-replacement choice, and let you scope the work to the selection, current page, or whole file.

## Install guide
1. Download this repository.
2. In Figma, go to **Plugins** -> **Development** -> **Import plugin from manifest...**
3. Select `manifest.json` from this folder.
4. The plugin is now available in Figma under **Plugins**.


## Architecture

Each migration (color, and future ones such as typography) is a self-contained module that plugs into a shared harness.

```
src/
  core/        types + harness (messaging, registry, message router)
  migrations/
    color/     the color migration (operations exposed as a MigrationModule)
  main.ts      startPlugin([colorMigration])
ui/
  core/        bridge (messaging) + shell (migration picker, nav, busy overlay)
  migrations/
    color/     the color UI controller
  main.ts      initBridge(); initShell([createColorController()])
```

Backend messages use one generic envelope, `{ type: 'run', domain, operation, args }` (plus a shared `focus-node`). The harness router dispatches `run` to the matching module's operation; results come back as an `OperationResultPayload` tagged with the domain. The UI shell renders the picker from the registered controllers and routes results to the active one.

### Adding a migration

1. Backend: add `src/migrations/<name>/index.ts` exporting a `MigrationModule` (`id`, `title`, `description`, `operations`), and register it in `startPlugin([...])` in `src/main.ts`.
2. UI: add `ui/migrations/<name>/controller.ts` exposing the controller contract (`id`, `title`, `description`, `icon`, `rootId`, `enter`, `onProgress`, `onResult`) plus its markup in `ui/index.html` (a `migration-root` with a `data-go-to-migrations` back button), and register it in `ui/main.ts`.

No central union or switch needs editing — both sides resolve migrations through their registries.
