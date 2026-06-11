"use strict";
const UNSUPPORTED_COLORS = [
    'neutral',
    'support',
    'danger',
    'info',
    'warning',
    'success',
];
const COLOR_COLLECTION_NAMES = ['Color', 'Main color'];
// Pre-migration the library exposed separate collections for each color group.
// Sketch files may still have explicit mode overrides referencing these.
const LEGACY_COLOR_COLLECTION_NAMES = ['Main color', 'Support color'];
const NEUTRAL_MODE_NAME = 'neutral';
const DEFAULT_COLOR_MODE_NAME = 'accent';
// Older components used both "color" and "color mode" as the variant property
// that selected neutral/support/etc. Treat both as the same migration axis.
const COLOR_VARIANT_PROPERTY_NAMES = ['color', 'color mode'];
// These keep their color variants, but their paints should move from Semantic
// variables to Color variables and use modes for info/warning/danger/success.
const COLOR_MODE_MIGRATION_COMPONENT_SET_NAMES = ['Alert', 'ValidationMessage'];
const SEMANTIC_COLOR_GROUPS = ['info', 'warning', 'danger', 'success'];
const SKIP_MISSING_INSTANCE_MODE_CONTEXTS = ['TableColumn'];
let pendingUnsupportedVariantPlans = [];
let pendingColorModeMigrationComponentSetIds = [];
let pendingMissingInstancePlans = [];
let pendingLibraryStuckInstancePlans = [];
figma.showUI(__html__, { width: 480, height: 460, themeColors: true });
function postToUi(message) {
    figma.ui.postMessage(message);
}
// Skip per-batch progress posts for small workloads — the UI flash is more
// distracting than informative, and a short run finishes before progress is
// even visible. Status messages without a total (e.g. "Loading...") always
// post so the UI never appears stuck on initial load.
const PROGRESS_THRESHOLD = 200;
function postOperationProgress(payload) {
    if (typeof payload.total === 'number' && payload.total < PROGRESS_THRESHOLD) {
        return;
    }
    postToUi({
        type: 'operation-progress',
        payload,
    });
}
function asErrorResult(operation, error) {
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        details: {
            error: error instanceof Error ? error.stack || error.message : String(error),
        },
    };
}
function isColorVariantPropertyName(propertyName) {
    return COLOR_VARIANT_PROPERTY_NAMES.includes(normalizeToken(propertyName));
}
function getColorVariantPropertyValue(node) {
    const properties = node.variantProperties;
    if (!properties) {
        return null;
    }
    const matchingKey = Object.keys(properties).find(isColorVariantPropertyName);
    return matchingKey ? properties[matchingKey] : null;
}
function getColorVariantPropertyKey(node) {
    const properties = node.variantProperties;
    if (!properties) {
        return null;
    }
    return Object.keys(properties).find(isColorVariantPropertyName) || null;
}
function isUnsupportedColor(value) {
    return UNSUPPORTED_COLORS.includes(String(value).toLowerCase());
}
function normalizeToken(value) {
    return value.trim().toLowerCase();
}
function isChildrenMixin(node) {
    return 'children' in node;
}
function shouldTraverseChildren(node) {
    // Stops walks at instance boundaries. Avoids forcing Figma's dynamic-page
    // loader to synchronize the full descendant tree of every instance, which
    // is the dominant cost in large files. Nested instances are component
    // overrides anyway and cannot be acted on independently.
    //
    // Consequence: callers must always start walks from page-level scene
    // nodes (page children). Starting inside an instance will appear to
    // return nothing because we never recurse through its body.
    return node.type !== 'INSTANCE' && isChildrenMixin(node);
}
function collectTopLevelInstances(root, into) {
    // Walk manually instead of using findAllWithCriteria: in dynamic-page mode
    // findAllWithCriteria has to synchronize every instance's full descendant
    // tree, which is very slow on files with deeply nested instance hierarchies
    // (e.g. Core UI Kit). Stopping at instance boundaries avoids that cost and
    // also skips nested instances we cannot swap independently anyway (they are
    // component overrides, not standalone instances).
    if (root.type === 'INSTANCE') {
        into.push(root);
        return;
    }
    if (!isChildrenMixin(root)) {
        return;
    }
    for (const child of root.children) {
        collectTopLevelInstances(child, into);
    }
}
function parseRemovedComponentName(componentName) {
    const parts = componentName.split('/').map((part) => part.trim()).filter(Boolean);
    const [componentSetName = componentName, ...variantTokens] = parts;
    const removedColor = variantTokens.find((token) => isUnsupportedColor(normalizeToken(token))) || null;
    const nonColorTokens = removedColor
        ? variantTokens.filter((token) => normalizeToken(token) !== normalizeToken(removedColor))
        : variantTokens;
    return {
        componentSetName,
        removedColor,
        nonColorTokens,
    };
}
function getVariantPropertyOrder(componentSet) {
    // Missing variants only give us the old component name, so we map the old
    // slash-separated tokens back onto the current non-color variant properties.
    const definitions = Object.entries(componentSet.componentPropertyDefinitions)
        .filter(([, definition]) => definition.type === 'VARIANT')
        .map(([key]) => key)
        .filter((key) => !isColorVariantPropertyName(key));
    if (definitions.length > 0) {
        return definitions;
    }
    const firstComponent = componentSet.children.find((child) => child.type === 'COMPONENT');
    return (firstComponent === null || firstComponent === void 0 ? void 0 : firstComponent.variantProperties)
        ? Object.keys(firstComponent.variantProperties).filter((key) => !isColorVariantPropertyName(key))
        : [];
}
function buildTargetPropertyValues(componentSet, tokens) {
    const propertyOrder = getVariantPropertyOrder(componentSet);
    if (propertyOrder.length !== tokens.length) {
        return null;
    }
    const values = {};
    for (let index = 0; index < propertyOrder.length; index += 1) {
        values[propertyOrder[index]] = tokens[index];
    }
    return values;
}
function variantMatchesPropertyValues(component, targetValues) {
    const properties = component.variantProperties;
    if (!properties) {
        return false;
    }
    return Object.entries(targetValues).every(([targetKey, targetValue]) => {
        const matchingKey = Object.keys(properties).find((key) => normalizeToken(key) === normalizeToken(targetKey));
        return matchingKey ? normalizeToken(properties[matchingKey]) === normalizeToken(targetValue) : false;
    });
}
function formatTargetValues(targetValues) {
    if (!targetValues) {
        return 'none';
    }
    return Object.entries(targetValues).map(([key, value]) => `${key}=${value}`).join(', ');
}
async function getColorCollection() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    return collections.find((collection) => COLOR_COLLECTION_NAMES.includes(collection.name)) || null;
}
function findModeByName(collection, modeName) {
    return collection.modes.find((mode) => mode.name.toLowerCase() === modeName.toLowerCase()) || null;
}
function findTargetMode(collection, removedColor, supportModeId) {
    if (removedColor === 'support' && supportModeId) {
        return collection.modes.find((mode) => mode.modeId === supportModeId) || null;
    }
    const exactMode = findModeByName(collection, removedColor);
    if (exactMode) {
        return exactMode;
    }
    return findModeByName(collection, DEFAULT_COLOR_MODE_NAME) || collection.modes[0] || null;
}
function getScopeLoadingMessage(scope) {
    if (scope === 'selection') {
        return 'Loading selection...';
    }
    if (scope === 'page') {
        return 'Loading page...';
    }
    return 'Loading file...';
}
function collectDescendantsIncludingInstances(root) {
    const nodes = [];
    const visit = (node) => {
        nodes.push(node);
        if (isChildrenMixin(node)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    };
    visit(root);
    return nodes;
}
function getPageName(node) {
    let current = node;
    while (current) {
        if (current.type === 'PAGE') {
            return current.name;
        }
        current = current.parent;
    }
    return null;
}
function getComponentContext(node) {
    var _a;
    let current = node.parent;
    while (current) {
        if (current.type === 'COMPONENT') {
            const parentSet = ((_a = current.parent) === null || _a === void 0 ? void 0 : _a.type) === 'COMPONENT_SET' ? current.parent.name : null;
            return {
                type: 'COMPONENT',
                name: current.name,
                componentSetName: parentSet,
            };
        }
        if (current.type === 'COMPONENT_SET') {
            return {
                type: 'COMPONENT_SET',
                name: current.name,
                componentSetName: current.name,
            };
        }
        current = current.parent;
    }
    return null;
}
function shouldSkipModeForMissingInstance(plan) {
    const contextName = plan.componentContextSetName || plan.componentContextName || '';
    const isSkippedContext = SKIP_MISSING_INSTANCE_MODE_CONTEXTS.some((name) => normalizeToken(name) === normalizeToken(contextName));
    // TableColumn has nested cell/header instances that were incorrectly wired to
    // neutral variants but visually overridden to look like main. Swapping is OK,
    // but setting explicit neutral mode would preserve the original wiring bug.
    return isSkippedContext && normalizeToken(plan.removedColor) === 'neutral';
}
function buildVariantNameWithoutColor(node) {
    const properties = node.variantProperties;
    const colorKey = getColorVariantPropertyKey(node);
    if (!properties || !colorKey) {
        return null;
    }
    const entries = Object.entries(properties).filter(([key]) => key !== colorKey);
    if (entries.length === 0) {
        return null;
    }
    return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}
function moveDuplicateRenameTargetsToSkipped(plan) {
    const targetCounts = {};
    for (const rename of plan.variantsToRename) {
        targetCounts[rename.to] = (targetCounts[rename.to] || 0) + 1;
    }
    const uniqueRenames = [];
    for (const rename of plan.variantsToRename) {
        if (targetCounts[rename.to] > 1) {
            plan.skippedRenames.push({
                id: rename.id,
                name: rename.from,
                reason: `Removing color would create duplicate variant name "${rename.to}".`,
            });
            continue;
        }
        uniqueRenames.push(rename);
    }
    plan.variantsToRename = uniqueRenames;
}
async function checkPrimeStatus() {
    const operation = 'check-prime-status';
    const sourceCollectionName = 'Main color';
    const supportCollectionName = 'Support color';
    const targetCollectionName = 'Color';
    const variablePrefix = 'color/main/';
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const hasMainColor = collections.some((c) => c.name === sourceCollectionName);
    const hasSupportColor = collections.some((c) => c.name === supportCollectionName);
    const hasColor = collections.some((c) => c.name === targetCollectionName);
    // Look for variables that still carry the legacy prefix in either the
    // pre- or post-rename collection. Both states can exist mid-migration.
    let prefixedVariableCount = 0;
    for (const collection of collections) {
        if (collection.name !== sourceCollectionName && collection.name !== targetCollectionName) {
            continue;
        }
        for (const variableId of collection.variableIds) {
            const variable = await figma.variables.getVariableByIdAsync(variableId);
            if (variable && variable.name.startsWith(variablePrefix)) {
                prefixedVariableCount += 1;
            }
        }
    }
    // Three states:
    // - `not-library`: none of the known color collections exist. Almost
    //   certainly not a Core UI Kit library file.
    // - `ready`: post-migration shape. Color exists, Main color gone, no
    //   variables still carrying the legacy prefix.
    // - `needs`: anything in between — at least one signal of a library
    //   that hasn't been fully prepared.
    let state;
    if (!hasColor && !hasMainColor && !hasSupportColor) {
        state = 'not-library';
    }
    else if (hasColor && !hasMainColor && prefixedVariableCount === 0) {
        state = 'ready';
    }
    else {
        state = 'needs';
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: 'success',
        message: state === 'ready'
            ? 'Variables are already prepared.'
            : state === 'not-library'
                ? 'This file does not appear to be a library file.'
                : 'Variables still need preparation.',
        details: {
            hasMainColor,
            hasColor,
            hasSupportColor,
            prefixedVariableCount,
            state,
        },
    };
}
async function primeVariables() {
    const operation = 'prime-variables';
    const sourceCollectionName = 'Main color';
    const targetCollectionName = 'Color';
    const variablePrefix = 'color/main/';
    postOperationProgress({
        operation,
        message: 'Reading variables...',
    });
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const mainColorCollections = collections.filter((collection) => collection.name === sourceCollectionName);
    const colorCollections = collections.filter((collection) => collection.name === targetCollectionName);
    if (mainColorCollections.length > 1) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'error',
            message: `Found ${mainColorCollections.length} "${sourceCollectionName}" collections. Keep only one before preparing variables.`,
            details: {
                matchingCollections: mainColorCollections.map((collection) => ({
                    id: collection.id,
                    key: collection.key,
                    name: collection.name,
                })),
            },
        };
    }
    if (mainColorCollections.length === 1 && colorCollections.length > 0) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'error',
            message: `Both "${sourceCollectionName}" and "${targetCollectionName}" exist. Keep only the collection you want to update, then try again.`,
            details: {
                mainColorCollection: {
                    id: mainColorCollections[0].id,
                    key: mainColorCollections[0].key,
                    name: mainColorCollections[0].name,
                },
                colorCollections: colorCollections.map((collection) => ({
                    id: collection.id,
                    key: collection.key,
                    name: collection.name,
                })),
            },
        };
    }
    const targetCollection = mainColorCollections[0] || colorCollections[0];
    if (!targetCollection) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'noop',
            message: `Could not find a "${sourceCollectionName}" or "${targetCollectionName}" collection.`,
            details: {
                searchedCollectionNames: [sourceCollectionName, targetCollectionName],
            },
        };
    }
    const renamedVariables = [];
    const skippedVariables = [];
    const total = targetCollection.variableIds.length;
    let renamedCollection = null;
    if (targetCollection.name === sourceCollectionName) {
        renamedCollection = {
            id: targetCollection.id,
            key: targetCollection.key,
            from: sourceCollectionName,
            to: targetCollectionName,
        };
        targetCollection.name = targetCollectionName;
    }
    for (let index = 0; index < targetCollection.variableIds.length; index += 1) {
        const variableId = targetCollection.variableIds[index];
        const variable = await figma.variables.getVariableByIdAsync(variableId);
        if (!variable) {
            skippedVariables.push({
                id: variableId,
                reason: 'Could not find this variable.',
            });
            continue;
        }
        if (variable.name.startsWith(variablePrefix)) {
            const oldName = variable.name;
            const newName = variable.name.slice(variablePrefix.length);
            variable.name = newName;
            renamedVariables.push({
                id: variable.id,
                key: variable.key,
                from: oldName,
                to: newName,
            });
        }
        if ((index + 1) % 10 === 0 || index + 1 === total) {
            postOperationProgress({
                operation,
                message: 'Preparing variables...',
                processed: index + 1,
                total,
            });
        }
    }
    const changed = renamedCollection !== null || renamedVariables.length > 0;
    if (changed) {
        // Close this apply as its own undo step so Cmd+Z reverses just the prime
        // without rolling back later migration steps in the same plugin session.
        figma.commitUndo();
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: changed ? 'success' : 'noop',
        message: changed
            ? `Primed variables: renamed ${renamedVariables.length} variable${renamedVariables.length === 1 ? '' : 's'}.`
            : `Variables are already prepared. No names starting with "${variablePrefix}" were found in "${targetCollection.name}".`,
        details: {
            collection: {
                id: targetCollection.id,
                key: targetCollection.key,
                name: targetCollection.name,
            },
            renamedCollection,
            renamedVariableCount: renamedVariables.length,
            skippedVariableCount: skippedVariables.length,
            renamedVariables,
            skippedVariables,
        },
    };
}
async function getAllComponentSets() {
    await figma.loadAllPagesAsync();
    const componentSets = [];
    const visit = (node) => {
        if (node.type === 'COMPONENT_SET') {
            componentSets.push(node);
        }
        if (shouldTraverseChildren(node)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    };
    for (const page of figma.root.children) {
        visit(page);
    }
    return componentSets;
}
// Walk the tree and collect both ComponentSets and standalone Components
// whose names match. A "standalone" Component is one whose parent is not a
// ComponentSet — these arise from Step 2's collapse path (single-variant
// component sets are converted to standalone components named after the
// original set).
function collectComponentTargets(root, wantedNames) {
    const componentSets = [];
    const standaloneComponents = [];
    const visit = (node) => {
        if (node.type === 'COMPONENT_SET') {
            if (!wantedNames || wantedNames.has(normalizeToken(node.name))) {
                componentSets.push(node);
            }
        }
        else if (node.type === 'COMPONENT') {
            const isStandalone = !node.parent || node.parent.type !== 'COMPONENT_SET';
            if (isStandalone && (!wantedNames || wantedNames.has(normalizeToken(node.name)))) {
                standaloneComponents.push(node);
            }
        }
        if (shouldTraverseChildren(node)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    };
    visit(root);
    return { componentSets, standaloneComponents };
}
function getMissingComponentSetNames(plans) {
    return new Set(plans
        .filter((plan) => plan.componentSetName !== 'Unknown')
        .map((plan) => normalizeToken(plan.componentSetName)));
}
async function findComponentTargetsByNames(wantedNames, scope) {
    if (wantedNames.size === 0) {
        return {
            componentSets: [],
            standaloneComponents: [],
            searchedWholeFile: false,
        };
    }
    const currentPage = collectComponentTargets(figma.currentPage, wantedNames);
    const foundNames = new Set([
        ...currentPage.componentSets.map((node) => normalizeToken(node.name)),
        ...currentPage.standaloneComponents.map((node) => normalizeToken(node.name)),
    ]);
    const missingNames = Array.from(wantedNames).filter((name) => !foundNames.has(name));
    if (missingNames.length === 0 && scope !== 'file') {
        return {
            componentSets: currentPage.componentSets,
            standaloneComponents: currentPage.standaloneComponents,
            searchedWholeFile: false,
        };
    }
    // Loading every page is expensive in large files, so only do it when the
    // target set is not on the current page or the user explicitly scans the file.
    // Keep the current-page results we already have and only scan the other pages.
    await figma.loadAllPagesAsync();
    const allSets = [...currentPage.componentSets];
    const allStandalone = [...currentPage.standaloneComponents];
    const seenIds = new Set([
        ...currentPage.componentSets.map((node) => node.id),
        ...currentPage.standaloneComponents.map((node) => node.id),
    ]);
    for (const page of figma.root.children) {
        if (page.id === figma.currentPage.id) {
            continue;
        }
        const pageTargets = collectComponentTargets(page, wantedNames);
        for (const componentSet of pageTargets.componentSets) {
            if (!seenIds.has(componentSet.id)) {
                allSets.push(componentSet);
                seenIds.add(componentSet.id);
            }
        }
        for (const standalone of pageTargets.standaloneComponents) {
            if (!seenIds.has(standalone.id)) {
                allStandalone.push(standalone);
                seenIds.add(standalone.id);
            }
        }
    }
    return {
        componentSets: allSets,
        standaloneComponents: allStandalone,
        searchedWholeFile: true,
    };
}
async function getInstancesForScope(scope) {
    const instances = [];
    if (scope === 'selection') {
        for (const root of figma.currentPage.selection) {
            collectTopLevelInstances(root, instances);
        }
        return instances;
    }
    if (scope === 'page') {
        await figma.currentPage.loadAsync();
        for (const child of figma.currentPage.children) {
            collectTopLevelInstances(child, instances);
        }
        return instances;
    }
    await figma.loadAllPagesAsync();
    for (const page of figma.root.children) {
        for (const child of page.children) {
            collectTopLevelInstances(child, instances);
        }
    }
    return instances;
}
async function loadColorModes() {
    const operation = 'load-color-modes';
    const collection = await getColorCollection();
    if (!collection) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'error',
            message: 'Could not find a Color or Main color collection.',
            details: {
                collectionNames: COLOR_COLLECTION_NAMES,
            },
        };
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: 'success',
        message: `Loaded ${collection.modes.length} color mode${collection.modes.length === 1 ? '' : 's'}.`,
        details: {
            collection: {
                id: collection.id,
                key: collection.key,
                name: collection.name,
            },
            modes: collection.modes,
            defaultModeId: collection.defaultModeId,
        },
    };
}
async function scanUnsupportedVariants() {
    const operation = 'scan-unsupported-variants';
    pendingUnsupportedVariantPlans = [];
    postOperationProgress({
        operation,
        message: 'Loading file...',
    });
    const componentSets = await getAllComponentSets();
    postOperationProgress({
        operation,
        message: 'Scanning variants...',
        processed: 0,
        total: componentSets.length,
    });
    const plans = [];
    const skippedComponentSets = [];
    const colorModeMigrationComponentSetIds = [];
    // Component sets Figma reports as being in an error state — tracked
    // separately so the scan summary can name them for the user to fix.
    const errorComponentSetNames = [];
    for (let index = 0; index < componentSets.length; index += 1) {
        const componentSet = componentSets[index];
        const isColorModeMigrationComponentSet = COLOR_MODE_MIGRATION_COMPONENT_SET_NAMES.some((name) => normalizeToken(name) === normalizeToken(componentSet.name));
        if (isColorModeMigrationComponentSet) {
            // Alert and ValidationMessage are migrated by rebinding paints instead of
            // deleting their color variants.
            colorModeMigrationComponentSetIds.push(componentSet.id);
            skippedComponentSets.push({
                id: componentSet.id,
                name: componentSet.name,
                reason: 'Handled by color mode migration.',
            });
            continue;
        }
        const children = componentSet.children.filter((child) => child.type === 'COMPONENT');
        // A component set in a Figma error state (e.g. conflicting/duplicate
        // variant combinations) throws on any variantProperties access with
        // "Component set for node has existing errors". Reading it here would
        // otherwise abort the entire scan, so isolate the failure to this one set:
        // record it as skipped and move on.
        let hasColorProperty;
        try {
            hasColorProperty = children.some((child) => getColorVariantPropertyKey(child) !== null);
        }
        catch (_a) {
            errorComponentSetNames.push(componentSet.name);
            skippedComponentSets.push({
                id: componentSet.id,
                name: componentSet.name,
                reason: 'Component set has existing errors in Figma (e.g. conflicting variants) — fix it and rescan.',
            });
            continue;
        }
        if (hasColorProperty) {
            const plan = {
                componentSetId: componentSet.id,
                componentSetName: componentSet.name,
                pageName: getPageName(componentSet),
                variantsToRemove: [],
                variantsToRename: [],
                skippedRenames: [],
                willCollapseToSingleComponent: false,
            };
            for (const child of children) {
                const color = getColorVariantPropertyValue(child);
                const normalizedColor = color ? color.toLowerCase() : null;
                if (isUnsupportedColor(normalizedColor)) {
                    plan.variantsToRemove.push({
                        id: child.id,
                        name: child.name,
                        color: normalizedColor,
                    });
                    continue;
                }
                const newName = buildVariantNameWithoutColor(child);
                if (!newName) {
                    plan.skippedRenames.push({
                        id: child.id,
                        name: child.name,
                        reason: 'Could not build a variant name without color.',
                    });
                    continue;
                }
                if (newName !== child.name) {
                    plan.variantsToRename.push({
                        id: child.id,
                        from: child.name,
                        to: newName,
                    });
                }
            }
            moveDuplicateRenameTargetsToSkipped(plan);
            // If only one variant remains after the removals, Figma will not let
            // us drop the color property in place (every defined variant property
            // requires at least one variant). Flag the set for conversion to a
            // standalone component during apply, and skip the would-be rename of
            // the surviving variant — it will be renamed to the set's name when
            // it's reparented out.
            const remainingVariantCount = children.length - plan.variantsToRemove.length;
            if (remainingVariantCount === 1) {
                plan.willCollapseToSingleComponent = true;
                plan.variantsToRename = [];
                plan.skippedRenames = [];
            }
            if (plan.variantsToRemove.length > 0 || plan.variantsToRename.length > 0 || plan.skippedRenames.length > 0 || plan.willCollapseToSingleComponent) {
                plans.push(plan);
            }
        }
        if ((index + 1) % 10 === 0 || index + 1 === componentSets.length) {
            postOperationProgress({
                operation,
                message: 'Scanning variants...',
                processed: index + 1,
                total: componentSets.length,
            });
        }
    }
    pendingUnsupportedVariantPlans = plans;
    pendingColorModeMigrationComponentSetIds = colorModeMigrationComponentSetIds;
    const removeCount = plans.reduce((sum, plan) => sum + plan.variantsToRemove.length, 0);
    const renameCount = plans.reduce((sum, plan) => sum + plan.variantsToRename.length, 0);
    const skippedRenameCount = plans.reduce((sum, plan) => sum + plan.skippedRenames.length, 0);
    const colorModeMigrationCount = colorModeMigrationComponentSetIds.length;
    if (removeCount === 0 && renameCount === 0 && colorModeMigrationCount === 0) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'noop',
            message: 'No old color variants found.',
            details: {
                scannedComponentSetCount: componentSets.length,
                skippedComponentSets,
                colorModeMigrationCount,
                errorComponentSetCount: errorComponentSetNames.length,
                errorComponentSetNames,
                unsupportedColors: UNSUPPORTED_COLORS,
                plans,
            },
        };
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: 'preview',
        message: `Found ${removeCount} variant${removeCount === 1 ? '' : 's'} to remove, ${renameCount} variant${renameCount === 1 ? '' : 's'} to rename, and ${colorModeMigrationCount} color-mode set${colorModeMigrationCount === 1 ? '' : 's'} to migrate.`,
        details: {
            scannedComponentSetCount: componentSets.length,
            affectedComponentSetCount: plans.length,
            skippedComponentSets,
            colorModeMigrationCount,
            errorComponentSetCount: errorComponentSetNames.length,
            errorComponentSetNames,
            removeCount,
            renameCount,
            skippedRenameCount,
            unsupportedColors: UNSUPPORTED_COLORS,
            plans,
        },
    };
}
// Convert a ComponentSet that has exactly one variant left into a standalone
// component. The variant is reparented to the set's parent (preserving its
// absolute position on the canvas), renamed to the set's name, and the now-
// empty ComponentSet is removed. This handles the case where the only
// remaining variant after color removal would prevent Figma from dropping
// the color property in place.
async function collapseSingleVariantComponentSet(plan) {
    const componentSet = await figma.getNodeByIdAsync(plan.componentSetId);
    if (!componentSet || componentSet.type !== 'COMPONENT_SET') {
        throw new Error('Component set is no longer available.');
    }
    if (componentSet.children.length !== 1) {
        throw new Error(`Expected 1 remaining variant, found ${componentSet.children.length}.`);
    }
    const survivingChild = componentSet.children[0];
    if (survivingChild.type !== 'COMPONENT') {
        throw new Error('Remaining child is not a component.');
    }
    const parent = componentSet.parent;
    if (!parent || !('insertChild' in parent)) {
        throw new Error('Component set has no reparentable parent.');
    }
    // Capture the absolute position of the surviving variant before reparenting.
    // insertChild preserves the local x/y (which are relative to the source
    // parent), so we need to restore the absolute position manually to avoid a
    // visual jump on the canvas.
    const transform = survivingChild.absoluteTransform;
    const absoluteX = transform[0][2];
    const absoluteY = transform[1][2];
    const insertIndex = parent.children.indexOf(componentSet);
    parent.insertChild(insertIndex, survivingChild);
    let parentAbsX = 0;
    let parentAbsY = 0;
    if ('absoluteTransform' in parent) {
        const parentTransform = parent.absoluteTransform;
        parentAbsX = parentTransform[0][2];
        parentAbsY = parentTransform[1][2];
    }
    survivingChild.x = absoluteX - parentAbsX;
    survivingChild.y = absoluteY - parentAbsY;
    survivingChild.name = plan.componentSetName;
    // Figma auto-removes a ComponentSet when its last variant is reparented
    // out — and any access (including `.parent`) on the orphaned reference
    // throws. Try to remove explicitly in case this ever changes; swallow
    // the error from the auto-removed case.
    try {
        componentSet.remove();
    }
    catch (_a) {
        // already gone
    }
}
async function applyUnsupportedVariantPlans() {
    const operation = 'apply-unsupported-variants';
    const plans = pendingUnsupportedVariantPlans;
    if (plans.length === 0 && pendingColorModeMigrationComponentSetIds.length === 0) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'noop',
            message: 'Scan variants before applying changes.',
            details: {},
        };
    }
    const totalSteps = plans.reduce((sum, plan) => sum + plan.variantsToRemove.length + plan.variantsToRename.length, 0);
    let processed = 0;
    const removed = [];
    const renamed = [];
    const failed = [];
    postOperationProgress({
        operation,
        message: 'Removing and updating variants...',
        processed,
        total: totalSteps,
    });
    for (const plan of plans) {
        // Batch the node lookups per plan; mutations (.name= / .remove()) still run
        // sequentially after the batch so they don't race against each other.
        const renameNodes = await Promise.all(plan.variantsToRename.map((variant) => figma.getNodeByIdAsync(variant.id).catch((error) => (error instanceof Error ? error : new Error(String(error))))));
        for (let i = 0; i < plan.variantsToRename.length; i += 1) {
            const variant = plan.variantsToRename[i];
            const result = renameNodes[i];
            if (result instanceof Error) {
                failed.push({
                    id: variant.id,
                    name: variant.from,
                    action: 'rename',
                    reason: result.message,
                });
            }
            else if ((result === null || result === void 0 ? void 0 : result.type) !== 'COMPONENT') {
                failed.push({
                    id: variant.id,
                    name: variant.from,
                    action: 'rename',
                    reason: 'Could not find this component.',
                });
            }
            else {
                result.name = variant.to;
                renamed.push({
                    id: variant.id,
                    from: variant.from,
                    to: variant.to,
                    componentSetName: plan.componentSetName,
                });
            }
            processed += 1;
        }
        postOperationProgress({
            operation,
            message: 'Removing and updating variants...',
            processed,
            total: totalSteps,
        });
        const removeNodes = await Promise.all(plan.variantsToRemove.map((variant) => figma.getNodeByIdAsync(variant.id).catch((error) => (error instanceof Error ? error : new Error(String(error))))));
        for (let i = 0; i < plan.variantsToRemove.length; i += 1) {
            const variant = plan.variantsToRemove[i];
            const result = removeNodes[i];
            if (result instanceof Error) {
                failed.push({
                    id: variant.id,
                    name: variant.name,
                    color: variant.color,
                    action: 'remove',
                    reason: result.message,
                });
            }
            else if ((result === null || result === void 0 ? void 0 : result.type) !== 'COMPONENT') {
                failed.push({
                    id: variant.id,
                    name: variant.name,
                    color: variant.color,
                    action: 'remove',
                    reason: 'Could not find this component.',
                });
            }
            else {
                result.remove();
                removed.push({
                    id: variant.id,
                    name: variant.name,
                    color: variant.color,
                    componentSetName: plan.componentSetName,
                });
            }
            processed += 1;
        }
        postOperationProgress({
            operation,
            message: 'Removing and updating variants...',
            processed,
            total: totalSteps,
        });
        if (plan.willCollapseToSingleComponent) {
            try {
                await collapseSingleVariantComponentSet(plan);
            }
            catch (error) {
                failed.push({
                    id: plan.componentSetId,
                    name: plan.componentSetName,
                    action: 'collapse',
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    const colorModeMigration = await applyColorModeMigration();
    pendingUnsupportedVariantPlans = [];
    pendingColorModeMigrationComponentSetIds = [];
    const status = failed.length > 0 ? 'error' : 'success';
    if (status === 'success') {
        figma.commitUndo();
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status,
        message: failed.length > 0
            ? `Removed ${removed.length}, renamed ${renamed.length}, failed ${failed.length}.`
            : `Removed ${removed.length} variant${removed.length === 1 ? '' : 's'}, renamed ${renamed.length}, and migrated color-mode colors.`,
        details: {
            removedCount: removed.length,
            renamedCount: renamed.length,
            failedCount: failed.length,
            colorModeMigration,
            removed,
            renamed,
            failed,
        },
    };
}
async function getColorVariablesByName(colorCollection) {
    const colorVariables = await figma.variables.getLocalVariablesAsync('COLOR');
    return new Map(colorVariables
        .filter((variable) => variable.variableCollectionId === colorCollection.id)
        .map((variable) => [normalizeToken(variable.name), variable]));
}
async function getComponentSetsByIds(ids) {
    const componentSets = [];
    for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if ((node === null || node === void 0 ? void 0 : node.type) === 'COMPONENT_SET') {
            componentSets.push(node);
        }
    }
    return componentSets;
}
function getColorModeForComponent(component, colorCollection) {
    const color = getColorVariantPropertyValue(component);
    if (!color || !SEMANTIC_COLOR_GROUPS.includes(normalizeToken(color))) {
        return null;
    }
    return findModeByName(colorCollection, color);
}
function getPaintMigrationTarget(paint, colorVariablesByName) {
    var _a, _b;
    if (paint.type !== 'SOLID') {
        return null;
    }
    const variableId = (_b = (_a = paint.boundVariables) === null || _a === void 0 ? void 0 : _a.color) === null || _b === void 0 ? void 0 : _b.id;
    if (!variableId) {
        return null;
    }
    return {
        variableId,
        getTargetVariable: async () => {
            const sourceVariable = await figma.variables.getVariableByIdAsync(variableId);
            if (!sourceVariable) {
                return null;
            }
            const parts = sourceVariable.name.split('/').map((part) => part.trim()).filter(Boolean);
            if (parts.length < 3 || normalizeToken(parts[0]) !== 'color') {
                return null;
            }
            // Example: color/info/background-default should become the Color variable
            // background-default, while the component variant gets mode=info.
            const [, modeName, ...scaleParts] = parts;
            if (!SEMANTIC_COLOR_GROUPS.includes(normalizeToken(modeName))) {
                return null;
            }
            return colorVariablesByName.get(normalizeToken(scaleParts.join('/'))) || null;
        },
    };
}
async function setPaintsOnNode(node, propertyName, paints) {
    if (propertyName === 'fills' && 'setFillsAsync' in node) {
        await node.setFillsAsync(paints);
        return;
    }
    if (propertyName === 'strokes' && 'setStrokesAsync' in node) {
        await node.setStrokesAsync(paints);
    }
}
async function migrateSemanticPaintsOnNode(node, colorVariablesByName) {
    let migratedPaintCount = 0;
    let failedPaintWriteCount = 0;
    for (const propertyName of ['fills', 'strokes']) {
        const paintNode = node;
        if (!(propertyName in paintNode)) {
            continue;
        }
        const paints = paintNode[propertyName];
        if (!Array.isArray(paints)) {
            continue;
        }
        const nextPaints = [];
        let changed = false;
        let changedPaintCount = 0;
        for (const paint of paints) {
            const target = getPaintMigrationTarget(paint, colorVariablesByName);
            if (!target || paint.type !== 'SOLID') {
                nextPaints.push(paint);
                continue;
            }
            const targetVariable = await target.getTargetVariable();
            if (!targetVariable) {
                nextPaints.push(paint);
                continue;
            }
            nextPaints.push(figma.variables.setBoundVariableForPaint(paint, 'color', targetVariable));
            changed = true;
            changedPaintCount += 1;
        }
        if (changed) {
            try {
                await setPaintsOnNode(node, propertyName, nextPaints);
                migratedPaintCount += changedPaintCount;
            }
            catch (error) {
                // Figma may reject writes on some nested instance layers. Keep the rest
                // of the migration moving, surface the count in the result payload, and
                // log per-node details to the plugin console for debugging.
                failedPaintWriteCount += changedPaintCount;
                console.warn('[Color migration] Failed to write paints', {
                    nodeId: node.id,
                    nodeName: node.name,
                    property: propertyName,
                    changedPaintCount,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return {
        migratedPaintCount,
        failedPaintWriteCount,
    };
}
async function applyColorModeMigration() {
    const componentSetIds = pendingColorModeMigrationComponentSetIds;
    if (componentSetIds.length === 0) {
        return {
            migratedComponentSetCount: 0,
            migratedVariantCount: 0,
            migratedPaintCount: 0,
            skipped: [],
        };
    }
    const colorCollection = await getColorCollection();
    if (!colorCollection) {
        return {
            migratedComponentSetCount: 0,
            migratedVariantCount: 0,
            migratedPaintCount: 0,
            skipped: [{ reason: 'Could not find a Color or Main color collection.' }],
        };
    }
    const colorVariablesByName = await getColorVariablesByName(colorCollection);
    const componentSets = await getComponentSetsByIds(componentSetIds);
    const skipped = [];
    let migratedVariantCount = 0;
    let migratedPaintCount = 0;
    let failedPaintWriteCount = 0;
    for (const componentSet of componentSets) {
        for (const component of componentSet.children) {
            if (component.type !== 'COMPONENT') {
                continue;
            }
            const mode = getColorModeForComponent(component, colorCollection);
            if (!mode) {
                skipped.push({
                    componentSetName: componentSet.name,
                    componentName: component.name,
                    reason: 'Could not resolve color mode.',
                });
                continue;
            }
            // These components keep their color variants, but the actual color should
            // resolve through Color modes instead of semantic variables.
            // Bound because Figma's node proxies lose `this` when methods are
            // extracted into local references — calling .bind once keeps the call
            // site readable below.
            const setExplicitVariableModeForCollection = component.setExplicitVariableModeForCollection.bind(component);
            setExplicitVariableModeForCollection(colorCollection, mode.modeId);
            // Unlike the broader scans, this intentionally walks into nested
            // instances so their overridden fills/strokes can be rebound too.
            for (const node of collectDescendantsIncludingInstances(component)) {
                const paintMigration = await migrateSemanticPaintsOnNode(node, colorVariablesByName);
                migratedPaintCount += paintMigration.migratedPaintCount;
                failedPaintWriteCount += paintMigration.failedPaintWriteCount;
            }
            migratedVariantCount += 1;
        }
    }
    return {
        migratedComponentSetCount: componentSets.length,
        migratedVariantCount,
        migratedPaintCount,
        failedPaintWriteCount,
        skipped,
    };
}
function findTargetComponent(lookup, componentSetName, tokens) {
    const componentSet = lookup.componentSets.find((candidate) => normalizeToken(candidate.name) === normalizeToken(componentSetName));
    if (!componentSet) {
        // Fall back to a standalone Component with the same name. This is how
        // a collapsed single-variant set surfaces after Step 2 — the surviving
        // variant has been renamed to the original set's name.
        const standalone = lookup.standaloneComponents.find((candidate) => normalizeToken(candidate.name) === normalizeToken(componentSetName));
        if (standalone) {
            return {
                component: standalone,
                reason: 'matched a standalone component (the set was collapsed during cleanup)',
                candidateCount: 1,
                candidateNames: [standalone.name],
                targetPropertyValues: null,
            };
        }
        return {
            component: null,
            reason: `Could not find the "${componentSetName}" component set.`,
            candidateCount: 0,
            candidateNames: [],
            targetPropertyValues: null,
        };
    }
    const targetPropertyValues = buildTargetPropertyValues(componentSet, tokens);
    if (!targetPropertyValues && componentSet.children.length !== 1) {
        return {
            component: null,
            reason: `Could not match the old variant name to the current variant properties.`,
            candidateCount: 0,
            candidateNames: [],
            targetPropertyValues,
        };
    }
    const candidates = componentSet.children.filter((child) => child.type === 'COMPONENT' && targetPropertyValues !== null && variantMatchesPropertyValues(child, targetPropertyValues));
    if (candidates.length === 1) {
        return {
            component: candidates[0],
            candidateCount: 1,
            candidateNames: [candidates[0].name],
            targetPropertyValues,
        };
    }
    if (candidates.length === 0 && componentSet.children.length === 1 && componentSet.children[0].type === 'COMPONENT') {
        // Fallback for component sets that have collapsed to a single variant after
        // the variant cleanup step. The old slash-separated tokens from the missing
        // instance name no longer match any variant property values (color was the
        // only differentiator), but there is exactly one target left, so the swap
        // is unambiguous. Without this, every missing instance in a now-single-
        // variant set would be marked blocked.
        return {
            component: componentSet.children[0],
            reason: 'matched the only remaining variant',
            candidateCount: 1,
            candidateNames: [componentSet.children[0].name],
            targetPropertyValues,
        };
    }
    return {
        component: null,
        reason: candidates.length === 0
            ? `Could not find a current variant matching ${formatTargetValues(targetPropertyValues)}.`
            : `Found ${candidates.length} possible current variants matching ${formatTargetValues(targetPropertyValues)}.`,
        candidateCount: candidates.length,
        candidateNames: candidates.slice(0, 10).map((candidate) => candidate.name),
        targetPropertyValues,
    };
}
function getBlockedReason(removedColor, targetMode, targetComponentResult) {
    const reasons = [];
    if (!removedColor) {
        reasons.push('Could not read the old color from the variant name.');
    }
    if (!targetMode) {
        reasons.push('Could not find a color mode to apply.');
    }
    if (!(targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.component)) {
        reasons.push((targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.reason) || 'Could not find a matching current variant.');
    }
    return reasons.length > 0 ? reasons.join('; ') : undefined;
}
async function scanMissingInstances(scope, supportModeId) {
    var _a;
    const operation = 'scan-missing-instances';
    pendingMissingInstancePlans = [];
    postOperationProgress({
        operation,
        message: 'Loading color modes...',
    });
    const colorCollection = await getColorCollection();
    if (!colorCollection) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'error',
            message: 'Could not find a Color or Main color collection.',
            details: {
                collectionNames: COLOR_COLLECTION_NAMES,
            },
        };
    }
    postOperationProgress({
        operation,
        message: getScopeLoadingMessage(scope),
    });
    const instances = await getInstancesForScope(scope);
    const plans = [];
    for (let index = 0; index < instances.length; index += 1) {
        const instance = instances[index];
        const mainComponent = await instance.getMainComponentAsync();
        // A removed local variant leaves behind a detached ComponentNode: it still
        // resolves (so mainComponent is not null), is local (remote=false), but has
        // no parent because its ComponentSet child slot was deleted. A hard-missing
        // main component (e.g. removed library) returns null instead. Both count as
        // "missing" for migration purposes.
        const isMissing = !mainComponent || (mainComponent.remote === false && !mainComponent.parent);
        if (isMissing) {
            const parsed = mainComponent ? parseRemovedComponentName(mainComponent.name) : null;
            const removedColor = (parsed === null || parsed === void 0 ? void 0 : parsed.removedColor) || null;
            const targetMode = removedColor ? findTargetMode(colorCollection, removedColor, supportModeId) : null;
            const componentContext = getComponentContext(instance);
            plans.push({
                instanceId: instance.id,
                instanceName: instance.name,
                parentName: ((_a = instance.parent) === null || _a === void 0 ? void 0 : _a.name) || null,
                pageName: getPageName(instance),
                componentSetName: (parsed === null || parsed === void 0 ? void 0 : parsed.componentSetName) || 'Unknown',
                removedColor: removedColor || 'unknown',
                targetModeName: (targetMode === null || targetMode === void 0 ? void 0 : targetMode.name) || null,
                targetModeId: (targetMode === null || targetMode === void 0 ? void 0 : targetMode.modeId) || null,
                targetComponentId: null,
                targetComponentName: null,
                sourceComponentName: (mainComponent === null || mainComponent === void 0 ? void 0 : mainComponent.name) || null,
                nonColorTokens: (parsed === null || parsed === void 0 ? void 0 : parsed.nonColorTokens) || [],
                status: 'blocked',
                reason: getBlockedReason(removedColor, targetMode, null),
                componentContextType: componentContext === null || componentContext === void 0 ? void 0 : componentContext.type,
                componentContextName: componentContext === null || componentContext === void 0 ? void 0 : componentContext.name,
                componentContextSetName: (componentContext === null || componentContext === void 0 ? void 0 : componentContext.componentSetName) || undefined,
            });
        }
        if ((index + 1) % 10 === 0 || index + 1 === instances.length) {
            postOperationProgress({
                operation,
                message: 'Scanning instances...',
                processed: index + 1,
                total: instances.length,
            });
        }
    }
    pendingMissingInstancePlans = plans;
    if (plans.length > 0) {
        const wantedNames = getMissingComponentSetNames(plans);
        const targetLookup = await findComponentTargetsByNames(wantedNames, scope);
        for (const plan of plans) {
            const targetComponentResult = plan.componentSetName !== 'Unknown'
                ? findTargetComponent(targetLookup, plan.componentSetName, plan.nonColorTokens)
                : null;
            const targetComponent = (targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.component) || null;
            plan.targetComponentId = (targetComponent === null || targetComponent === void 0 ? void 0 : targetComponent.id) || null;
            plan.targetComponentName = (targetComponent === null || targetComponent === void 0 ? void 0 : targetComponent.name) || null;
            plan.targetPropertyValues = (targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.targetPropertyValues) || undefined;
            plan.targetCandidateCount = targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.candidateCount;
            plan.targetCandidateNames = targetComponentResult === null || targetComponentResult === void 0 ? void 0 : targetComponentResult.candidateNames;
            // Ready requires all three: a parseable color, a resolved target mode,
            // and exactly one matching variant in the current component set.
            plan.status = plan.removedColor !== 'unknown' && plan.targetModeId && targetComponent ? 'ready' : 'blocked';
            plan.reason = getBlockedReason(plan.removedColor === 'unknown' ? null : plan.removedColor, plan.targetModeId && plan.targetModeName ? { modeId: plan.targetModeId, name: plan.targetModeName } : null, targetComponentResult);
        }
    }
    const readyCount = plans.filter((plan) => plan.status === 'ready').length;
    const blockedCount = plans.length - readyCount;
    if (plans.length === 0) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'noop',
            message: 'No missing instances found.',
            details: {
                scope,
                scannedInstanceCount: instances.length,
            },
        };
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: readyCount > 0 ? 'preview' : 'error',
        message: `Found ${plans.length} missing instance${plans.length === 1 ? '' : 's'}: ${readyCount} ready, ${blockedCount} blocked.`,
        details: {
            scope,
            scannedInstanceCount: instances.length,
            readyCount,
            blockedCount,
            plans,
        },
    };
}
async function applyMissingInstancePlans() {
    const operation = 'apply-missing-instances';
    const colorCollection = await getColorCollection();
    if (!colorCollection) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'error',
            message: 'Could not find a Color or Main color collection.',
            details: {
                collectionNames: COLOR_COLLECTION_NAMES,
            },
        };
    }
    const plans = pendingMissingInstancePlans.filter((plan) => plan.status === 'ready');
    if (plans.length === 0) {
        return {
            createdAt: new Date().toISOString(),
            operation,
            status: 'noop',
            message: 'Scan instances before applying changes.',
            details: {},
        };
    }
    const fixed = [];
    const failed = [];
    let skippedModeCount = 0;
    // Batch instance + target component lookups in parallel; mutations
    // (swapComponent, setExplicitVariableModeForCollection) run sequentially
    // afterwards to avoid races.
    const APPLY_BATCH_SIZE = 50;
    let processed = 0;
    for (let start = 0; start < plans.length; start += APPLY_BATCH_SIZE) {
        const batch = plans.slice(start, start + APPLY_BATCH_SIZE);
        const lookups = await Promise.all(batch.map(async (plan) => {
            try {
                const [instance, targetComponent] = await Promise.all([
                    figma.getNodeByIdAsync(plan.instanceId),
                    plan.targetComponentId ? figma.getNodeByIdAsync(plan.targetComponentId) : Promise.resolve(null),
                ]);
                return { instance, targetComponent, error: null };
            }
            catch (error) {
                return {
                    instance: null,
                    targetComponent: null,
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
        }));
        for (let i = 0; i < batch.length; i += 1) {
            const plan = batch[i];
            const { instance, targetComponent, error } = lookups[i];
            try {
                if (error) {
                    throw error;
                }
                if ((instance === null || instance === void 0 ? void 0 : instance.type) !== 'INSTANCE') {
                    throw new Error('Could not find this instance.');
                }
                if ((targetComponent === null || targetComponent === void 0 ? void 0 : targetComponent.type) !== 'COMPONENT') {
                    throw new Error('Could not find the component to swap to.');
                }
                const modeId = plan.targetModeId;
                if (!modeId) {
                    throw new Error('Could not find the color mode to apply.');
                }
                instance.swapComponent(targetComponent);
                const shouldSkipMode = shouldSkipModeForMissingInstance(plan);
                if (shouldSkipMode) {
                    skippedModeCount += 1;
                }
                else {
                    // Bound because Figma's node proxies lose `this` when extracted
                    // into a local; see also the apply-color-mode-migration path.
                    const setExplicitVariableModeForCollection = instance.setExplicitVariableModeForCollection.bind(instance);
                    setExplicitVariableModeForCollection(colorCollection, modeId);
                }
                fixed.push({
                    instanceId: plan.instanceId,
                    instanceName: plan.instanceName,
                    targetComponentName: plan.targetComponentName,
                    targetModeName: shouldSkipMode ? null : plan.targetModeName,
                    skippedMode: shouldSkipMode,
                    skippedModeReason: shouldSkipMode ? 'Left color mode unchanged for a TableColumn subcomponent.' : null,
                });
            }
            catch (mutationError) {
                failed.push({
                    instanceId: plan.instanceId,
                    instanceName: plan.instanceName,
                    reason: mutationError instanceof Error ? mutationError.message : String(mutationError),
                });
            }
            processed += 1;
        }
        postOperationProgress({
            operation,
            message: 'Updating instances...',
            processed,
            total: plans.length,
        });
    }
    pendingMissingInstancePlans = [];
    if (fixed.length > 0) {
        figma.commitUndo();
    }
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: failed.length > 0 ? 'error' : 'success',
        message: `Fixed ${fixed.length} missing instance${fixed.length === 1 ? '' : 's'}${failed.length > 0 ? `, failed ${failed.length}` : ''}.`,
        details: {
            fixedCount: fixed.length,
            failedCount: failed.length,
            skippedModeCount,
            fixed,
            failed,
        },
    };
}
const COLOR_PROBE_MAX_DEPTH = 6;
// Generic DFS over a subtree, calling `visit` for each fill/stroke that
// carries a bound color variable. Stops at the first visitor result that
// isn't null — returning null from the visitor keeps searching.
async function visitFirstBoundColor(node, depth, visit) {
    if (depth > COLOR_PROBE_MAX_DEPTH) {
        return null;
    }
    if ('fills' in node && Array.isArray(node.fills)) {
        for (let index = 0; index < node.fills.length; index += 1) {
            const fill = node.fills[index];
            const variableId = fill && fill.boundVariables && fill.boundVariables.color
                ? fill.boundVariables.color.id
                : null;
            if (variableId) {
                const result = await visit({ variableId, node, paintIndex: index, source: 'fill' });
                if (result) {
                    return result;
                }
            }
        }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
        for (let index = 0; index < node.strokes.length; index += 1) {
            const stroke = node.strokes[index];
            const variableId = stroke && stroke.boundVariables && stroke.boundVariables.color
                ? stroke.boundVariables.color.id
                : null;
            if (variableId) {
                const result = await visit({ variableId, node, paintIndex: index, source: 'stroke' });
                if (result) {
                    return result;
                }
            }
        }
    }
    if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
            const result = await visitFirstBoundColor(child, depth + 1, visit);
            if (result) {
                return result;
            }
        }
    }
    return null;
}
async function findFirstBoundColorVariableId(node) {
    return visitFirstBoundColor(node, 0, async (hit) => hit.variableId);
}
async function findColorCollectionForComponentSet(componentSet) {
    for (const child of componentSet.children) {
        if (child.type !== 'COMPONENT') {
            continue;
        }
        const variableId = await findFirstBoundColorVariableId(child);
        if (!variableId) {
            continue;
        }
        try {
            const variable = await figma.variables.getVariableByIdAsync(variableId);
            if (!variable) {
                continue;
            }
            const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
            if (collection && COLOR_COLLECTION_NAMES.indexOf(collection.name) !== -1) {
                return collection;
            }
        }
        catch (_a) {
            // continue searching
        }
    }
    return null;
}
function findVariantByNonColorProps(componentSet, instance) {
    const targetValues = {};
    const props = instance.componentProperties;
    for (const propName of Object.keys(props)) {
        const prop = props[propName];
        if (prop.type === 'VARIANT' && !isColorVariantPropertyName(propName)) {
            targetValues[propName] = String(prop.value);
        }
    }
    for (const child of componentSet.children) {
        if (child.type !== 'COMPONENT') {
            continue;
        }
        if (variantMatchesPropertyValues(child, targetValues)) {
            return child;
        }
    }
    return null;
}
function getInstanceColorPropertyValue(instance) {
    const props = instance.componentProperties;
    for (const propName of Object.keys(props)) {
        if (!isColorVariantPropertyName(propName)) {
            continue;
        }
        const prop = props[propName];
        if (prop.type === 'VARIANT') {
            return String(prop.value);
        }
    }
    return null;
}
async function findLegacyColorModeOverride(instance) {
    const explicit = instance.explicitVariableModes || {};
    for (const collectionId of Object.keys(explicit)) {
        const modeId = explicit[collectionId];
        try {
            const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
            if (!collection) {
                continue;
            }
            if (LEGACY_COLOR_COLLECTION_NAMES.indexOf(collection.name) === -1) {
                continue;
            }
            const mode = collection.modes.find((m) => m.modeId === modeId);
            if (!mode) {
                continue;
            }
            return {
                collectionId,
                collectionName: collection.name,
                modeName: mode.name,
            };
        }
        catch (_a) {
            // continue
        }
    }
    return null;
}
async function scanLibraryStuckInstances(scope) {
    const operation = 'scan-library-stuck-instances';
    pendingLibraryStuckInstancePlans = [];
    postOperationProgress({ operation, message: getScopeLoadingMessage(scope) });
    const instances = await getInstancesForScope(scope);
    const candidates = [];
    for (let index = 0; index < instances.length; index += 1) {
        const instance = instances[index];
        const main = await instance.getMainComponentAsync();
        if (!main || !main.remote || !main.parent || main.parent.type !== 'COMPONENT_SET') {
            continue;
        }
        const colorValue = getInstanceColorPropertyValue(instance);
        if (colorValue === null) {
            continue;
        }
        const oldComponentSet = main.parent;
        // Alert and ValidationMessage intentionally keep their color variant as
        // a severity selector (info / warning / danger / success). Figma's
        // library update path keeps these instances in sync automatically, so
        // we must not include them as migration candidates — otherwise the
        // variant lookup would strip the severity and swap to the default.
        if (COLOR_MODE_MIGRATION_COMPONENT_SET_NAMES.some((name) => normalizeToken(name) === normalizeToken(oldComponentSet.name))) {
            continue;
        }
        candidates.push({
            instance,
            colorValue,
            oldComponentSetKey: oldComponentSet.key,
            oldComponentSetName: oldComponentSet.name,
        });
        if ((index + 1) % 10 === 0 || index + 1 === instances.length) {
            postOperationProgress({
                operation,
                message: 'Scanning instances...',
                processed: index + 1,
                total: instances.length,
            });
        }
    }
    const uniqueKeys = new Set();
    for (const candidate of candidates) {
        uniqueKeys.add(candidate.oldComponentSetKey);
    }
    // Import all needed component sets in parallel. Each import triggers a
    // round-trip to Figma's main thread, so running them sequentially scales
    // badly on files with many unique component sets.
    const importResults = await Promise.all(Array.from(uniqueKeys).map(async (key) => {
        try {
            const newSet = await figma.importComponentSetByKeyAsync(key);
            const collection = await findColorCollectionForComponentSet(newSet);
            return { key, newSet, collection, error: null };
        }
        catch (error) {
            return {
                key,
                newSet: null,
                collection: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
    const newComponentSetByKey = new Map();
    const colorCollectionByKey = new Map();
    const importErrorByKey = new Map();
    let fallbackColorCollection = null;
    for (const result of importResults) {
        if (result.error || !result.newSet) {
            if (result.error) {
                importErrorByKey.set(result.key, result.error);
            }
            continue;
        }
        newComponentSetByKey.set(result.key, result.newSet);
        if (result.collection) {
            colorCollectionByKey.set(result.key, result.collection);
            if (!fallbackColorCollection) {
                fallbackColorCollection = result.collection;
            }
        }
    }
    const plans = [];
    for (const candidate of candidates) {
        const instance = candidate.instance;
        const legacy = await findLegacyColorModeOverride(instance);
        const plan = {
            instanceId: instance.id,
            instanceName: instance.name,
            parentName: instance.parent ? instance.parent.name : null,
            pageName: getPageName(instance),
            oldColorValue: candidate.colorValue,
            oldComponentSetKey: candidate.oldComponentSetKey,
            oldComponentSetName: candidate.oldComponentSetName,
            legacyModeCollectionId: legacy ? legacy.collectionId : null,
            legacyModeCollectionName: legacy ? legacy.collectionName : null,
            legacyModeName: legacy ? legacy.modeName : null,
            targetColorCollectionId: null,
            targetModeId: null,
            targetModeName: null,
            targetComponentId: null,
            targetComponentName: null,
            needsSupportModeChoice: false,
            status: 'blocked',
            reason: undefined,
        };
        const newSet = newComponentSetByKey.get(candidate.oldComponentSetKey);
        if (!newSet) {
            const importError = importErrorByKey.get(candidate.oldComponentSetKey);
            plan.reason = importError
                ? `Could not import "${candidate.oldComponentSetName}" from library: ${importError}`
                : `Could not import "${candidate.oldComponentSetName}" from library.`;
            plans.push(plan);
            continue;
        }
        const targetVariant = findVariantByNonColorProps(newSet, instance);
        if (!targetVariant) {
            plan.reason = 'No matching variant in updated component.';
            plans.push(plan);
            continue;
        }
        plan.targetComponentId = targetVariant.id;
        plan.targetComponentName = targetVariant.name;
        const colorCollection = colorCollectionByKey.get(candidate.oldComponentSetKey) || fallbackColorCollection;
        plan.targetColorCollectionId = colorCollection ? colorCollection.id : null;
        let desiredModeName = null;
        if (legacy) {
            desiredModeName = legacy.modeName;
        }
        else if (normalizeToken(candidate.colorValue) === 'neutral') {
            desiredModeName = NEUTRAL_MODE_NAME;
        }
        else if (normalizeToken(candidate.colorValue) === 'main') {
            desiredModeName = null;
        }
        else if (SEMANTIC_COLOR_GROUPS.includes(normalizeToken(candidate.colorValue))) {
            // info/warning/danger/success used to be selected by the color variant;
            // post-migration they resolve through a same-named mode in the new Color
            // collection. Mirror findTargetMode/getColorModeForComponent so a stuck
            // instance (e.g. a color=danger button) gets its severity mode set.
            desiredModeName = candidate.colorValue;
        }
        else if (normalizeToken(candidate.colorValue) === 'support') {
            // Pre-migration the library exposed a separate "Support color"
            // collection for picking which brand-specific color the variant
            // used (brand1, brand2, …). Without an explicit mode override we
            // have no signal to recover the user's intent — the variant value
            // alone tells us only "support, unspecified". Surface this so the
            // user can pick a fallback via the UI dropdown.
            plan.needsSupportModeChoice = true;
            plan.status = 'review';
            plan.reason = 'No explicit support mode set — pick a fallback below to migrate.';
            plans.push(plan);
            continue;
        }
        if (desiredModeName) {
            if (!colorCollection) {
                plan.reason = 'Could not find the new Color collection.';
                plans.push(plan);
                continue;
            }
            const mode = colorCollection.modes.find((m) => normalizeToken(m.name) === normalizeToken(desiredModeName));
            if (mode) {
                plan.targetModeName = mode.name;
                plan.targetModeId = mode.modeId;
                plan.status = 'ready';
            }
            else {
                plan.status = 'review';
                plan.reason = `Mode "${desiredModeName}" does not exist in the new Color collection — set it manually after update.`;
            }
        }
        else {
            plan.status = 'ready';
        }
        plans.push(plan);
    }
    pendingLibraryStuckInstancePlans = plans;
    const readyCount = plans.filter((p) => p.status === 'ready').length;
    const reviewCount = plans.filter((p) => p.status === 'review').length;
    const blockedCount = plans.filter((p) => p.status === 'blocked').length;
    const supportFallbackCount = plans.filter((p) => p.needsSupportModeChoice).length;
    const availableColorModes = fallbackColorCollection
        ? fallbackColorCollection.modes.map((m) => ({ modeId: m.modeId, name: m.name }))
        : [];
    const hasAnyWork = readyCount + reviewCount > 0;
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: hasAnyWork ? 'preview' : 'noop',
        message: hasAnyWork
            ? `Scanned ${instances.length} instances. ${readyCount} can be updated, ${reviewCount} need review, ${blockedCount} blocked.`
            : `Scanned ${instances.length} instances. No stuck library instances found.`,
        details: {
            scannedInstanceCount: instances.length,
            candidateCount: candidates.length,
            readyCount,
            reviewCount,
            blockedCount,
            supportFallbackCount,
            availableColorModes,
            plans: plans,
        },
    };
}
// Match variable names like "color/main/base-default", "color/support/text-default",
// "color/neutral/border-default". The capture group is the new flat name we'll
// look up in the post-migration Color collection.
const LEGACY_COLOR_VARIABLE_NAME_PATTERN = /^color\/(?:main|support|neutral)\/(.+)$/;
function stripLegacyColorPrefix(variableName) {
    const match = variableName.match(LEGACY_COLOR_VARIABLE_NAME_PATTERN);
    return match ? match[1] : null;
}
async function buildNewColorVariableMap(collectionId) {
    const map = new Map();
    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    if (!collection) {
        return map;
    }
    for (const variableId of collection.variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(variableId);
        if (variable) {
            map.set(normalizeToken(variable.name), variable);
        }
    }
    return map;
}
// Walk a subtree (including into nested instances) and replace any
// fill/stroke boundVariables.color binding that points to a legacy color
// variable with the matching new Color-collection variable. A binding
// qualifies as "legacy" if:
//   - its collection is Main color, Support color, or Neutral color, OR
//   - its name matches color/(main|support|neutral)/* — catches Semantic-
//     collection bindings to legacy-named variables (the neutral case).
async function rebindLegacyColorBindingsInSubtree(node, newColorVariableMap, variableCache, collectionCache) {
    const stats = { rebound: 0, skipped: 0, failed: 0 };
    async function evaluatePaints(paints) {
        let mutated = false;
        const next = paints.slice();
        for (let i = 0; i < next.length; i += 1) {
            const paint = next[i];
            // Only SolidPaint has boundVariables.color; gradients/images bind
            // different fields and aren't relevant to color-variable rebinding.
            if (!paint || paint.type !== 'SOLID') {
                continue;
            }
            const variableId = paint.boundVariables && paint.boundVariables.color
                ? paint.boundVariables.color.id
                : null;
            if (!variableId) {
                continue;
            }
            let variable = variableCache.get(variableId);
            if (variable === undefined) {
                try {
                    variable = await figma.variables.getVariableByIdAsync(variableId);
                }
                catch (_a) {
                    variable = null;
                }
                variableCache.set(variableId, variable === undefined ? null : variable);
            }
            if (!variable) {
                continue;
            }
            let collection = collectionCache.get(variable.variableCollectionId);
            if (collection === undefined) {
                try {
                    collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
                }
                catch (_b) {
                    collection = null;
                }
                collectionCache.set(variable.variableCollectionId, collection === undefined ? null : collection);
            }
            const isLegacyCollection = collection
                ? LEGACY_COLOR_COLLECTION_NAMES.indexOf(collection.name) !== -1
                : false;
            const strippedName = stripLegacyColorPrefix(variable.name);
            if (!isLegacyCollection && strippedName === null) {
                continue;
            }
            const lookupName = strippedName !== null ? strippedName : variable.name;
            const newVariable = newColorVariableMap.get(normalizeToken(lookupName));
            if (!newVariable) {
                stats.skipped += 1;
                continue;
            }
            try {
                next[i] = figma.variables.setBoundVariableForPaint(paint, 'color', newVariable);
                mutated = true;
                stats.rebound += 1;
            }
            catch (_c) {
                stats.failed += 1;
            }
        }
        return mutated ? next : null;
    }
    if ('fills' in node && Array.isArray(node.fills)) {
        const updated = await evaluatePaints(node.fills);
        if (updated) {
            node.fills = updated;
        }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
        const updated = await evaluatePaints(node.strokes);
        if (updated) {
            node.strokes = updated;
        }
    }
    if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
            const childStats = await rebindLegacyColorBindingsInSubtree(child, newColorVariableMap, variableCache, collectionCache);
            stats.rebound += childStats.rebound;
            stats.skipped += childStats.skipped;
            stats.failed += childStats.failed;
        }
    }
    return stats;
}
async function applyLibraryStuckInstancePlans(supportFallbackModeId, rebindLegacyVariables) {
    const operation = 'apply-library-stuck-instances';
    const plans = pendingLibraryStuckInstancePlans;
    let fixedCount = 0;
    let failedCount = 0;
    let totalRebound = 0;
    let totalRebindSkipped = 0;
    let totalRebindFailed = 0;
    const failures = [];
    const applicablePlans = plans.filter((p) => p.status !== 'blocked');
    // Pre-build the name→variable map for the new Color collection so we only
    // do the variableIds walk once across all instances. Keyed by the
    // collection ID found during scan — assumes all plans share the same
    // target Color collection (true for a single-library migration).
    const colorVariableMaps = new Map();
    const rebindVariableCache = new Map();
    const rebindCollectionCache = new Map();
    for (let index = 0; index < applicablePlans.length; index += 1) {
        const plan = applicablePlans[index];
        try {
            const instance = await figma.getNodeByIdAsync(plan.instanceId);
            if (!instance || instance.type !== 'INSTANCE') {
                throw new Error('Instance no longer exists.');
            }
            if (!plan.targetComponentId) {
                throw new Error('Target variant missing in plan.');
            }
            const targetVariant = await figma.getNodeByIdAsync(plan.targetComponentId);
            if (!targetVariant || targetVariant.type !== 'COMPONENT') {
                throw new Error('Target variant no longer resolves.');
            }
            const instanceNode = instance;
            instanceNode.swapComponent(targetVariant);
            if (plan.legacyModeCollectionId) {
                try {
                    const legacyCollection = await figma.variables.getVariableCollectionByIdAsync(plan.legacyModeCollectionId);
                    if (legacyCollection) {
                        instanceNode.clearExplicitVariableModeForCollection(legacyCollection);
                    }
                }
                catch (_a) {
                    // ignore — clearing is best-effort
                }
            }
            const effectiveModeId = plan.needsSupportModeChoice && supportFallbackModeId
                ? supportFallbackModeId
                : plan.targetModeId;
            if (effectiveModeId && plan.targetColorCollectionId) {
                const colorCollection = await figma.variables.getVariableCollectionByIdAsync(plan.targetColorCollectionId);
                if (colorCollection) {
                    instanceNode.setExplicitVariableModeForCollection(colorCollection, effectiveModeId);
                }
            }
            if (rebindLegacyVariables && plan.targetColorCollectionId) {
                let variableMap = colorVariableMaps.get(plan.targetColorCollectionId);
                if (!variableMap) {
                    variableMap = await buildNewColorVariableMap(plan.targetColorCollectionId);
                    colorVariableMaps.set(plan.targetColorCollectionId, variableMap);
                }
                const stats = await rebindLegacyColorBindingsInSubtree(instanceNode, variableMap, rebindVariableCache, rebindCollectionCache);
                totalRebound += stats.rebound;
                totalRebindSkipped += stats.skipped;
                totalRebindFailed += stats.failed;
            }
            fixedCount += 1;
        }
        catch (error) {
            failedCount += 1;
            failures.push({
                instanceId: plan.instanceId,
                instanceName: plan.instanceName,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
        if ((index + 1) % 10 === 0 || index + 1 === applicablePlans.length) {
            postOperationProgress({
                operation,
                message: 'Updating instances...',
                processed: index + 1,
                total: applicablePlans.length,
            });
        }
    }
    if (fixedCount > 0) {
        figma.commitUndo();
    }
    pendingLibraryStuckInstancePlans = [];
    const rebindSuffix = rebindLegacyVariables && totalRebound + totalRebindSkipped + totalRebindFailed > 0
        ? ` Rebound ${totalRebound} legacy color binding${totalRebound === 1 ? '' : 's'}${totalRebindSkipped > 0 ? `, ${totalRebindSkipped} unmatched` : ''}${totalRebindFailed > 0 ? `, ${totalRebindFailed} failed` : ''}.`
        : '';
    return {
        createdAt: new Date().toISOString(),
        operation,
        status: failedCount > 0 ? 'error' : 'success',
        message: `Updated ${fixedCount} instance${fixedCount === 1 ? '' : 's'}${failedCount > 0 ? `, failed ${failedCount}` : ''}.${rebindSuffix}`,
        details: {
            fixedCount,
            failedCount,
            reboundCount: totalRebound,
            rebindSkippedCount: totalRebindSkipped,
            rebindFailedCount: totalRebindFailed,
            failures: failures,
        },
    };
}
async function runOperation(operation, callback) {
    postToUi({
        type: 'operation-result',
        payload: await callback().catch((error) => asErrorResult(operation, error)),
    });
}
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'check-prime-status') {
        await runOperation('check-prime-status', checkPrimeStatus);
        return;
    }
    if (msg.type === 'prime-variables') {
        await runOperation('prime-variables', primeVariables);
        return;
    }
    if (msg.type === 'scan-unsupported-variants') {
        await runOperation('scan-unsupported-variants', scanUnsupportedVariants);
        return;
    }
    if (msg.type === 'apply-unsupported-variants') {
        await runOperation('apply-unsupported-variants', applyUnsupportedVariantPlans);
        return;
    }
    if (msg.type === 'load-color-modes') {
        await runOperation('load-color-modes', loadColorModes);
        return;
    }
    if (msg.type === 'scan-missing-instances') {
        await runOperation('scan-missing-instances', () => scanMissingInstances(msg.scope, msg.supportModeId));
        return;
    }
    if (msg.type === 'apply-missing-instances') {
        await runOperation('apply-missing-instances', applyMissingInstancePlans);
        return;
    }
    if (msg.type === 'scan-library-stuck-instances') {
        await runOperation('scan-library-stuck-instances', () => scanLibraryStuckInstances(msg.scope));
        return;
    }
    if (msg.type === 'apply-library-stuck-instances') {
        await runOperation('apply-library-stuck-instances', () => applyLibraryStuckInstancePlans(msg.supportFallbackModeId, msg.rebindLegacyVariables));
        return;
    }
    if (msg.type === 'focus-node') {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
            return;
        }
        // Walk up the parent chain to find the owning page so we can switch
        // to it before scrolling — the node might live on another page.
        let cursor = node.parent;
        while (cursor && cursor.type !== 'PAGE') {
            cursor = cursor.parent;
        }
        if (cursor && cursor.type === 'PAGE' && cursor.id !== figma.currentPage.id) {
            await figma.setCurrentPageAsync(cursor);
        }
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
    }
};
