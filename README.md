# Color migration helper

Figma plugin for migrating Core UI Kit files from color variants to variable modes.

## What it does

The plugin opens on a landing screen with two workflows.

### Update library

Run in the library file. A single state-gated screen checks the variable structure and shows what's needed:

- **Needs preparation** — offers a **Prepare** action that renames the `Main color` collection to `Color` and strips the `color/main/` prefix off its variables.
- **Needs tokens** — the structure is correct but the `Color` collection is missing the new color modes (`info`, `warning`, `danger`, `success`); the user is told to regenerate and publish tokens first.
- **Not a library file** — none of the known color collections exist.
- **Ready** — shows the **Run migration** box. The user must pick which color mode replaces the old `support` variants, then one run does everything over the whole file as a single undo step:
  - removes `neutral`/`support` (and any semantic) color variants from component sets and cleans up variant names;
  - swaps every affected instance — including instances nested inside other instances — to the matching current variant and sets the right color mode;
  - rebinds loose `Support color` bindings that live directly on layers (frames, text, etc.).

  Progress is reported in phases (checking → components → instances). `Alert` and `ValidationMessage` are left untouched (they keep their color variants and hardcoded severity colors). For `TableColumn` cell/header subcomponents the swap runs but the `neutral` color mode is intentionally left unset.

### Update sketches

Run in a sketch file after the library has been migrated and republished. Updates instances stuck on the pre-migration library version and sets the appropriate color mode, and also rebinds loose `Support color` bindings. Lets you scope the work to the selection, current page, or whole file, and (like the library run) asks for the replacement mode for old `support`.

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

### Migration picker

The first screen is a picker that lists one button per registered migration. **It is currently hidden:** while only one migration (color) is registered, `initShell` skips the picker and opens that migration directly, and hides the "back to migrations" button (which would otherwise lead to an empty picker). The picker code is intentionally kept, not removed — as soon as a second migration is registered in `ui/main.ts`, `controllers.length > 1` and the picker (and back button) reappear automatically with no further changes. See `ui/core/shell.ts`.

### Adding a migration

1. Backend: add `src/migrations/<name>/index.ts` exporting a `MigrationModule` (`id`, `title`, `description`, `operations`), and register it in `startPlugin([...])` in `src/main.ts`.
2. UI: add `ui/migrations/<name>/controller.ts` exposing the controller contract (`id`, `title`, `description`, `icon`, `rootId`, `enter`, `onProgress`, `onResult`) plus its markup in `ui/index.html` (a `migration-root` with a `data-go-to-migrations` back button), and register it in `ui/main.ts`.

No central union or switch needs editing — both sides resolve migrations through their registries.
