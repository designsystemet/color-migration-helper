# Color migration helper

Figma plugin for migrating Core UI Kit files from color variants to variable modes.

## What It Does

The plugin opens on a landing screen with two workflows:

- **Update library** — for the library file. Runs the three migration steps in order.
- **Update sketches** — for sketch files that use the library after it has been migrated and republished.

### Update library

#### 1. Prepare variables

- Renames the local variable collection `Main color` to `Color`.
- Renames variables in that collection from `color/main/*` to `*`.
- On entry, the plugin automatically inspects the file's variable state and shows one of three states:
  - **Variables are ready** — `Color` exists, `Main color` does not, and no variables still carry the `color/main/` prefix. No action needed.
  - **Needs preparation** — at least one of the above is unmet. The Prepare button is shown.
  - **Not a library file** — none of `Color`, `Main color`, or `Support color` collections exist locally. The user is told to open the library file.
- The check runs every time the user enters the Update library flow.

#### 2. Remove variants

- Scans all component sets in the file.
- Removes unsupported color variants: `neutral`, `support`, `danger`, `info`, `warning`, and `success`.
- Treats both `color` and `color mode` as the color variant property.
- Renames the remaining variants so the color property is removed from the variant name.
- Handles `Alert` and `ValidationMessage` as special cases: their color variants are kept, but bound paints are moved from Semantic color variables to Color variables and the correct color mode is set.
- If a component set has exactly one variant left after removal, the set is converted to a standalone component (Figma does not allow dropping a variant property in place when only one variant remains). The surviving variant is reparented to the set's parent, renamed to the original set name, and the now-empty set is removed.
- After apply, any items that failed (rename / remove / collapse) are listed in a collapsible "Failed" accordion. Clicking a row selects and zooms to that node on the canvas.

#### 3. Fix in library

- Scans selection, current page, or the whole file for instances whose old variant was removed.
- Finds the matching current component variant by using the old component name and the remaining non-color variant properties.
- Falls back to a standalone Component with the same name when no matching ComponentSet exists — this is the path for instances that pointed to a component set Step 2 collapsed.
- Swaps ready instances to the matching current component.
- Sets the correct color mode on the fixed instance.
- Lets the user choose which Color mode should replace the old `support` category.
- Skips setting explicit `neutral` mode for nested missing instances inside `TableColumn`, because those subcomponents were wired to neutral by mistake and should inherit/default instead.

### Update sketches

Use this in a sketch file after the library team has migrated and republished the library. Figma updates instances using default variants automatically, but instances using non-default variants (e.g. `color=neutral`) remain stuck on the pre-migration library snapshot.

- Detects stuck instances: those whose `componentProperties.color` is still defined and whose main component is remote.
- Skips `Alert` and `ValidationMessage` instances — their color variants are intentionally preserved and Figma keeps them in sync automatically.
- For each unique stuck component set: imports the current published version via `importComponentSetByKeyAsync` (the set's key is stable across the migration), then finds the matching variant by the non-color variant properties.
- Discovers the new `Color` collection by probing a bound color variable on a variant in the imported set, then caches it as a fallback for components whose own probe fails.
- Swaps the instance to the new variant.
- Sets the appropriate color mode in the new `Color` collection:
  - If the instance had an explicit mode override in a legacy color collection (`Main color`, `Support color`): preserves the mode by matching its name in the new collection (e.g. `brand2` → `brand2`).
  - If `color=neutral` with no override: sets the `neutral` mode.
  - If `color` is a semantic group (`info`, `warning`, `danger`, `success`): sets the same-named mode in the new collection (e.g. `danger` → `danger`). Flagged for review if that mode doesn't exist.
  - If `color=support` with no override: prompts for a fallback mode (the dropdown is shown only when such instances are found).
  - If `color=main` with no override: leaves the mode unset, letting the collection's default apply.
- Clears any explicit override in the legacy color collection so the (soon orphaned) reference is dropped.
- Shows scan results grouped by status: a collapsible "Ready instances" accordion (each row selects and zooms to the instance when clicked) and a "Needs review" list for items that can't be migrated cleanly.

## Development

Install dependencies:

```bash
npm install
```

Build `code.ts` into `code.js`:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

`code.js` is generated from `code.ts` and is the file loaded by Figma.
