# Color migration helper

Figma plugin for migrating Core UI Kit files from color variants to variable modes.

## What It Does

The plugin has three main steps:

1. Prime variables
   - Renames the local variable collection `Main color` to `Color`.
   - Renames variables in that collection from `color/main/*` to `*`.
   - Does nothing if the file is already primed.

2. Variant cleanup
   - Scans all component sets in the file.
   - Removes unsupported color variants: `neutral`, `support`, `danger`, `info`, `warning`, and `success`.
   - Treats both `color` and `color mode` as the color variant property.
   - Renames the remaining variants so the color property is removed from the variant name.
   - Handles `Alert` and `ValidationMessage` as special cases: their color variants are kept, but bound paints are moved from Semantic color variables to Color variables and the correct color mode is set.

3. Missing instance fix
   - Scans selection, current page, or the whole file for instances whose old variant was removed.
   - Finds the matching current component variant by using the old component name and the remaining non-color variant properties.
   - Swaps ready instances to the matching current component.
   - Sets the correct color mode on the fixed instance.
   - Lets the user choose which Color mode should replace the old `support` category.
   - Skips setting explicit `neutral` mode for nested missing instances inside `TableColumn`, because those subcomponents were wired to neutral by mistake and should inherit/default instead.

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
