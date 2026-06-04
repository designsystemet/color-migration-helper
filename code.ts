type Operation =
  | 'check-prime-status'
  | 'prime-variables'
  | 'scan-unsupported-variants'
  | 'apply-unsupported-variants'
  | 'load-color-modes'
  | 'scan-missing-instances'
  | 'apply-missing-instances'
  | 'scan-library-stuck-instances'
  | 'apply-library-stuck-instances';

type FixScope = 'selection' | 'page' | 'file';

type PluginMessage =
  | { type: 'check-prime-status' }
  | { type: 'prime-variables' }
  | { type: 'scan-unsupported-variants' }
  | { type: 'apply-unsupported-variants' }
  | { type: 'load-color-modes' }
  | { type: 'scan-missing-instances'; scope: FixScope; supportModeId: string | null }
  | { type: 'apply-missing-instances' }
  | { type: 'scan-library-stuck-instances'; scope: FixScope }
  | { type: 'apply-library-stuck-instances'; supportFallbackModeId: string | null };

type UiMessage =
  | { type: 'operation-progress'; payload: OperationProgressPayload }
  | { type: 'operation-result'; payload: OperationResultPayload };

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type OperationProgressPayload = {
  operation: Operation;
  message: string;
  processed?: number;
  total?: number;
};

type OperationResultPayload = {
  createdAt: string;
  operation: Operation;
  status: 'success' | 'noop' | 'error' | 'preview';
  message: string;
  details: JsonValue;
};

type UnsupportedColor =
  | 'neutral'
  | 'support'
  | 'danger'
  | 'info'
  | 'warning'
  | 'success';

type ComponentSetRemovalPlan = {
  componentSetId: string;
  componentSetName: string;
  pageName: string | null;
  variantsToRemove: Array<{
    id: string;
    name: string;
    color: UnsupportedColor;
  }>;
  variantsToRename: Array<{
    id: string;
    from: string;
    to: string;
  }>;
  skippedRenames: Array<{
    id: string;
    name: string;
    reason: string;
  }>;
};

type LibraryStuckInstancePlan = {
  instanceId: string;
  instanceName: string;
  parentName: string | null;
  pageName: string | null;
  oldColorValue: string;
  oldComponentSetKey: string;
  oldComponentSetName: string;
  legacyModeCollectionId: string | null;
  legacyModeCollectionName: string | null;
  legacyModeName: string | null;
  targetColorCollectionId: string | null;
  targetModeId: string | null;
  targetModeName: string | null;
  targetComponentId: string | null;
  targetComponentName: string | null;
  needsSupportModeChoice: boolean;
  status: 'ready' | 'blocked' | 'review';
  reason?: string;
};

type MissingInstancePlan = {
  instanceId: string;
  instanceName: string;
  parentName: string | null;
  pageName: string | null;
  componentSetName: string;
  removedColor: string;
  targetModeName: string | null;
  targetModeId: string | null;
  targetComponentId: string | null;
  targetComponentName: string | null;
  sourceComponentName: string | null;
  nonColorTokens: string[];
  targetPropertyValues?: Record<string, string>;
  status: 'ready' | 'blocked';
  reason?: string;
  targetCandidateCount?: number;
  targetCandidateNames?: string[];
  componentContextType?: 'COMPONENT' | 'COMPONENT_SET';
  componentContextName?: string;
  componentContextSetName?: string;
};

const UNSUPPORTED_COLORS: UnsupportedColor[] = [
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

let pendingUnsupportedVariantPlans: ComponentSetRemovalPlan[] = [];
let pendingColorModeMigrationComponentSetIds: string[] = [];
let pendingMissingInstancePlans: MissingInstancePlan[] = [];
let pendingLibraryStuckInstancePlans: LibraryStuckInstancePlan[] = [];

figma.showUI(__html__, { width: 480, height: 460, themeColors: true });

function postToUi(message: UiMessage) {
  figma.ui.postMessage(message);
}

// Skip per-batch progress posts for small workloads — the UI flash is more
// distracting than informative, and a short run finishes before progress is
// even visible. Status messages without a total (e.g. "Loading...") always
// post so the UI never appears stuck on initial load.
const PROGRESS_THRESHOLD = 200;

function postOperationProgress(payload: OperationProgressPayload) {
  if (typeof payload.total === 'number' && payload.total < PROGRESS_THRESHOLD) {
    return;
  }
  postToUi({
    type: 'operation-progress',
    payload,
  });
}

function asErrorResult(operation: Operation, error: unknown): OperationResultPayload {
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

function isColorVariantPropertyName(propertyName: string) {
  return COLOR_VARIANT_PROPERTY_NAMES.includes(normalizeToken(propertyName));
}

function getColorVariantPropertyValue(node: ComponentNode): string | null {
  const properties = node.variantProperties;
  if (!properties) {
    return null;
  }

  const matchingKey = Object.keys(properties).find(isColorVariantPropertyName);
  return matchingKey ? properties[matchingKey] : null;
}

function getColorVariantPropertyKey(node: ComponentNode): string | null {
  const properties = node.variantProperties;
  if (!properties) {
    return null;
  }

  return Object.keys(properties).find(isColorVariantPropertyName) || null;
}

function isUnsupportedColor(value: string | null): value is UnsupportedColor {
  return UNSUPPORTED_COLORS.includes(String(value).toLowerCase() as UnsupportedColor);
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function isChildrenMixin(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node;
}

function shouldTraverseChildren(node: PageNode | SceneNode) {
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

function collectTopLevelInstances(root: SceneNode, into: InstanceNode[]) {
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

function parseRemovedComponentName(componentName: string): {
  componentSetName: string;
  removedColor: string | null;
  nonColorTokens: string[];
} {
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

function getVariantPropertyOrder(componentSet: ComponentSetNode) {
  // Missing variants only give us the old component name, so we map the old
  // slash-separated tokens back onto the current non-color variant properties.
  const definitions = Object.entries(componentSet.componentPropertyDefinitions)
    .filter(([, definition]) => definition.type === 'VARIANT')
    .map(([key]) => key)
    .filter((key) => !isColorVariantPropertyName(key));

  if (definitions.length > 0) {
    return definitions;
  }

  const firstComponent = componentSet.children.find((child): child is ComponentNode => child.type === 'COMPONENT');
  return firstComponent?.variantProperties
    ? Object.keys(firstComponent.variantProperties).filter((key) => !isColorVariantPropertyName(key))
    : [];
}

function buildTargetPropertyValues(componentSet: ComponentSetNode, tokens: string[]) {
  const propertyOrder = getVariantPropertyOrder(componentSet);

  if (propertyOrder.length !== tokens.length) {
    return null;
  }

  const values: Record<string, string> = {};
  for (let index = 0; index < propertyOrder.length; index += 1) {
    values[propertyOrder[index]] = tokens[index];
  }

  return values;
}

function variantMatchesPropertyValues(component: ComponentNode, targetValues: Record<string, string>) {
  const properties = component.variantProperties;
  if (!properties) {
    return false;
  }

  return Object.entries(targetValues).every(([targetKey, targetValue]) => {
    const matchingKey = Object.keys(properties).find((key) => normalizeToken(key) === normalizeToken(targetKey));
    return matchingKey ? normalizeToken(properties[matchingKey]) === normalizeToken(targetValue) : false;
  });
}

function formatTargetValues(targetValues: Record<string, string> | null) {
  if (!targetValues) {
    return 'none';
  }

  return Object.entries(targetValues).map(([key, value]) => `${key}=${value}`).join(', ');
}

async function getColorCollection(): Promise<VariableCollection | null> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return collections.find((collection) => COLOR_COLLECTION_NAMES.includes(collection.name)) || null;
}

function findModeByName(collection: VariableCollection, modeName: string) {
  return collection.modes.find((mode) => mode.name.toLowerCase() === modeName.toLowerCase()) || null;
}

function findTargetMode(collection: VariableCollection, removedColor: string, supportModeId: string | null) {
  if (removedColor === 'support' && supportModeId) {
    return collection.modes.find((mode) => mode.modeId === supportModeId) || null;
  }

  const exactMode = findModeByName(collection, removedColor);
  if (exactMode) {
    return exactMode;
  }

  return findModeByName(collection, DEFAULT_COLOR_MODE_NAME) || collection.modes[0] || null;
}

function getScopeLoadingMessage(scope: FixScope) {
  if (scope === 'selection') {
    return 'Loading selection...';
  }

  if (scope === 'page') {
    return 'Loading page...';
  }

  return 'Loading file...';
}

function collectDescendantsIncludingInstances(root: SceneNode): SceneNode[] {
  const nodes: SceneNode[] = [];
  const visit = (node: SceneNode) => {
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

function getPageName(node: BaseNode): string | null {
  let current: BaseNode | null = node;

  while (current) {
    if (current.type === 'PAGE') {
      return current.name;
    }

    current = current.parent;
  }

  return null;
}

function getComponentContext(node: BaseNode): {
  type: 'COMPONENT' | 'COMPONENT_SET';
  name: string;
  componentSetName: string | null;
} | null {
  let current = node.parent;

  while (current) {
    if (current.type === 'COMPONENT') {
      const parentSet = current.parent?.type === 'COMPONENT_SET' ? current.parent.name : null;
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

function shouldSkipModeForMissingInstance(plan: MissingInstancePlan) {
  const contextName = plan.componentContextSetName || plan.componentContextName || '';
  const isSkippedContext = SKIP_MISSING_INSTANCE_MODE_CONTEXTS.some((name) => normalizeToken(name) === normalizeToken(contextName));

  // TableColumn has nested cell/header instances that were incorrectly wired to
  // neutral variants but visually overridden to look like main. Swapping is OK,
  // but setting explicit neutral mode would preserve the original wiring bug.
  return isSkippedContext && normalizeToken(plan.removedColor) === 'neutral';
}

function buildVariantNameWithoutColor(node: ComponentNode): string | null {
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

function moveDuplicateRenameTargetsToSkipped(plan: ComponentSetRemovalPlan) {
  const targetCounts: Record<string, number> = {};
  for (const rename of plan.variantsToRename) {
    targetCounts[rename.to] = (targetCounts[rename.to] || 0) + 1;
  }

  const uniqueRenames: ComponentSetRemovalPlan['variantsToRename'] = [];
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

async function checkPrimeStatus(): Promise<OperationResultPayload> {
  const operation: Operation = 'check-prime-status';
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
  let state: 'not-library' | 'needs' | 'ready';
  if (!hasColor && !hasMainColor && !hasSupportColor) {
    state = 'not-library';
  } else if (hasColor && !hasMainColor && prefixedVariableCount === 0) {
    state = 'ready';
  } else {
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

async function primeVariables(): Promise<OperationResultPayload> {
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

  const renamedVariables: JsonValue[] = [];
  const skippedVariables: JsonValue[] = [];
  const total = targetCollection.variableIds.length;
  let renamedCollection: JsonValue = null;

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

async function getAllComponentSets(): Promise<ComponentSetNode[]> {
  await figma.loadAllPagesAsync();

  const componentSets: ComponentSetNode[] = [];
  const visit = (node: PageNode | SceneNode) => {
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

function collectComponentSets(root: PageNode | SceneNode, wantedNames?: Set<string>): ComponentSetNode[] {
  const componentSets: ComponentSetNode[] = [];
  const visit = (node: PageNode | SceneNode) => {
    if (node.type === 'COMPONENT_SET' && (!wantedNames || wantedNames.has(normalizeToken(node.name)))) {
      componentSets.push(node);
    }
    if (shouldTraverseChildren(node)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  visit(root);
  return componentSets;
}

function getMissingComponentSetNames(plans: MissingInstancePlan[]) {
  return new Set(
    plans
      .filter((plan) => plan.componentSetName !== 'Unknown')
      .map((plan) => normalizeToken(plan.componentSetName)),
  );
}

async function findComponentSetsByNames(wantedNames: Set<string>, scope: FixScope): Promise<{
  componentSets: ComponentSetNode[];
  searchedWholeFile: boolean;
}> {
  if (wantedNames.size === 0) {
    return {
      componentSets: [],
      searchedWholeFile: false,
    };
  }

  const currentPageSets = collectComponentSets(figma.currentPage, wantedNames);
  const foundNames = new Set(currentPageSets.map((componentSet) => normalizeToken(componentSet.name)));
  const missingNames = Array.from(wantedNames).filter((name) => !foundNames.has(name));

  if (missingNames.length === 0 && scope !== 'file') {
    return {
      componentSets: currentPageSets,
      searchedWholeFile: false,
    };
  }

  // Loading every page is expensive in large files, so only do it when the
  // target set is not on the current page or the user explicitly scans the file.
  // Keep the current-page results we already have and only scan the other pages.
  await figma.loadAllPagesAsync();
  const allSets: ComponentSetNode[] = [...currentPageSets];
  const seenIds = new Set(currentPageSets.map((componentSet) => componentSet.id));

  for (const page of figma.root.children) {
    if (page.id === figma.currentPage.id) {
      continue;
    }
    for (const componentSet of collectComponentSets(page, wantedNames)) {
      if (!seenIds.has(componentSet.id)) {
        allSets.push(componentSet);
        seenIds.add(componentSet.id);
      }
    }
  }

  return {
    componentSets: allSets,
    searchedWholeFile: true,
  };
}

async function getInstancesForScope(scope: FixScope): Promise<InstanceNode[]> {
  const instances: InstanceNode[] = [];

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

async function loadColorModes(): Promise<OperationResultPayload> {
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

async function scanUnsupportedVariants(): Promise<OperationResultPayload> {
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

  const plans: ComponentSetRemovalPlan[] = [];
  const skippedComponentSets: JsonValue[] = [];
  const colorModeMigrationComponentSetIds: string[] = [];

  for (let index = 0; index < componentSets.length; index += 1) {
    const componentSet = componentSets[index];
    const isColorModeMigrationComponentSet = COLOR_MODE_MIGRATION_COMPONENT_SET_NAMES.some(
      (name) => normalizeToken(name) === normalizeToken(componentSet.name),
    );

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

    const children = componentSet.children.filter((child): child is ComponentNode => child.type === 'COMPONENT');
    const hasColorProperty = children.some((child) => getColorVariantPropertyKey(child) !== null);

    if (hasColorProperty) {
      const plan: ComponentSetRemovalPlan = {
        componentSetId: componentSet.id,
        componentSetName: componentSet.name,
        pageName: getPageName(componentSet),
        variantsToRemove: [],
        variantsToRename: [],
        skippedRenames: [],
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

      if (plan.variantsToRemove.length > 0 || plan.variantsToRename.length > 0 || plan.skippedRenames.length > 0) {
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
      removeCount,
      renameCount,
      skippedRenameCount,
      unsupportedColors: UNSUPPORTED_COLORS,
      plans,
    },
  };
}

async function applyUnsupportedVariantPlans(): Promise<OperationResultPayload> {
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
  const removed: JsonValue[] = [];
  const renamed: JsonValue[] = [];
  const failed: JsonValue[] = [];

  postOperationProgress({
    operation,
    message: 'Removing and updating variants...',
    processed,
    total: totalSteps,
  });

  for (const plan of plans) {
    // Batch the node lookups per plan; mutations (.name= / .remove()) still run
    // sequentially after the batch so they don't race against each other.
    const renameNodes = await Promise.all(
      plan.variantsToRename.map((variant) => figma.getNodeByIdAsync(variant.id).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))),
    );

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
      } else if (result?.type !== 'COMPONENT') {
        failed.push({
          id: variant.id,
          name: variant.from,
          action: 'rename',
          reason: 'Could not find this component.',
        });
      } else {
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

    const removeNodes = await Promise.all(
      plan.variantsToRemove.map((variant) => figma.getNodeByIdAsync(variant.id).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))),
    );

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
      } else if (result?.type !== 'COMPONENT') {
        failed.push({
          id: variant.id,
          name: variant.name,
          color: variant.color,
          action: 'remove',
          reason: 'Could not find this component.',
        });
      } else {
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
    message:
      failed.length > 0
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

async function getColorVariablesByName(colorCollection: VariableCollection) {
  const colorVariables = await figma.variables.getLocalVariablesAsync('COLOR');
  return new Map(
    colorVariables
      .filter((variable) => variable.variableCollectionId === colorCollection.id)
      .map((variable) => [normalizeToken(variable.name), variable]),
  );
}

async function getComponentSetsByIds(ids: string[]) {
  const componentSets: ComponentSetNode[] = [];

  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node?.type === 'COMPONENT_SET') {
      componentSets.push(node);
    }
  }

  return componentSets;
}

function getColorModeForComponent(component: ComponentNode, colorCollection: VariableCollection) {
  const color = getColorVariantPropertyValue(component);
  if (!color || !SEMANTIC_COLOR_GROUPS.includes(normalizeToken(color))) {
    return null;
  }

  return findModeByName(colorCollection, color);
}

function getPaintMigrationTarget(paint: Paint, colorVariablesByName: Map<string, Variable>) {
  if (paint.type !== 'SOLID') {
    return null;
  }

  const variableId = paint.boundVariables?.color?.id;
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

async function setPaintsOnNode(node: SceneNode, propertyName: 'fills' | 'strokes', paints: ReadonlyArray<Paint>) {
  if (propertyName === 'fills' && 'setFillsAsync' in node) {
    await node.setFillsAsync(paints);
    return;
  }

  if (propertyName === 'strokes' && 'setStrokesAsync' in node) {
    await node.setStrokesAsync(paints);
  }
}

async function migrateSemanticPaintsOnNode(node: SceneNode, colorVariablesByName: Map<string, Variable>) {
  let migratedPaintCount = 0;
  let failedPaintWriteCount = 0;

  for (const propertyName of ['fills', 'strokes'] as const) {
    const paintNode = node as SceneNode & Partial<MinimalFillsMixin & MinimalStrokesMixin>;
    if (!(propertyName in paintNode)) {
      continue;
    }

    const paints = paintNode[propertyName];
    if (!Array.isArray(paints)) {
      continue;
    }

    const nextPaints: Paint[] = [];
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
      } catch (error) {
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

async function applyColorModeMigration(): Promise<JsonValue> {
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
  const skipped: JsonValue[] = [];
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

function findTargetComponent(componentSets: ComponentSetNode[], componentSetName: string, tokens: string[]): {
  component: ComponentNode | null;
  reason?: string;
  candidateCount: number;
  candidateNames: string[];
  targetPropertyValues: Record<string, string> | null;
} {
  const componentSet = componentSets.find((candidate) => normalizeToken(candidate.name) === normalizeToken(componentSetName));
  if (!componentSet) {
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

  const candidates = componentSet.children.filter(
    (child): child is ComponentNode =>
      child.type === 'COMPONENT' && targetPropertyValues !== null && variantMatchesPropertyValues(child, targetPropertyValues),
  );

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
    reason:
      candidates.length === 0
        ? `Could not find a current variant matching ${formatTargetValues(targetPropertyValues)}.`
        : `Found ${candidates.length} possible current variants matching ${formatTargetValues(targetPropertyValues)}.`,
    candidateCount: candidates.length,
    candidateNames: candidates.slice(0, 10).map((candidate) => candidate.name),
    targetPropertyValues,
  };
}

function getBlockedReason(
  removedColor: string | null,
  targetMode: { modeId: string; name: string } | null,
  targetComponentResult: ReturnType<typeof findTargetComponent> | null,
) {
  const reasons: string[] = [];

  if (!removedColor) {
    reasons.push('Could not read the old color from the variant name.');
  }

  if (!targetMode) {
    reasons.push('Could not find a color mode to apply.');
  }

  if (!targetComponentResult?.component) {
    reasons.push(targetComponentResult?.reason || 'Could not find a matching current variant.');
  }

  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

async function scanMissingInstances(scope: FixScope, supportModeId: string | null): Promise<OperationResultPayload> {
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

  const plans: MissingInstancePlan[] = [];

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
      const removedColor = parsed?.removedColor || null;
      const targetMode = removedColor ? findTargetMode(colorCollection, removedColor, supportModeId) : null;
      const componentContext = getComponentContext(instance);

      plans.push({
        instanceId: instance.id,
        instanceName: instance.name,
        parentName: instance.parent?.name || null,
        pageName: getPageName(instance),
        componentSetName: parsed?.componentSetName || 'Unknown',
        removedColor: removedColor || 'unknown',
        targetModeName: targetMode?.name || null,
        targetModeId: targetMode?.modeId || null,
        targetComponentId: null,
        targetComponentName: null,
        sourceComponentName: mainComponent?.name || null,
        nonColorTokens: parsed?.nonColorTokens || [],
        status: 'blocked',
        reason: getBlockedReason(removedColor, targetMode, null),
        componentContextType: componentContext?.type,
        componentContextName: componentContext?.name,
        componentContextSetName: componentContext?.componentSetName || undefined,
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
    const componentSetLookup = await findComponentSetsByNames(wantedNames, scope);
    const componentSets = componentSetLookup.componentSets;

    for (const plan of plans) {
      const targetComponentResult =
        plan.componentSetName !== 'Unknown'
          ? findTargetComponent(componentSets, plan.componentSetName, plan.nonColorTokens)
          : null;

      const targetComponent = targetComponentResult?.component || null;
      plan.targetComponentId = targetComponent?.id || null;
      plan.targetComponentName = targetComponent?.name || null;
      plan.targetPropertyValues = targetComponentResult?.targetPropertyValues || undefined;
      plan.targetCandidateCount = targetComponentResult?.candidateCount;
      plan.targetCandidateNames = targetComponentResult?.candidateNames;
      // Ready requires all three: a parseable color, a resolved target mode,
      // and exactly one matching variant in the current component set.
      plan.status = plan.removedColor !== 'unknown' && plan.targetModeId && targetComponent ? 'ready' : 'blocked';
      plan.reason = getBlockedReason(
        plan.removedColor === 'unknown' ? null : plan.removedColor,
        plan.targetModeId && plan.targetModeName ? { modeId: plan.targetModeId, name: plan.targetModeName } : null,
        targetComponentResult,
      );
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

async function applyMissingInstancePlans(): Promise<OperationResultPayload> {
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

  const fixed: JsonValue[] = [];
  const failed: JsonValue[] = [];
  let skippedModeCount = 0;

  // Batch instance + target component lookups in parallel; mutations
  // (swapComponent, setExplicitVariableModeForCollection) run sequentially
  // afterwards to avoid races.
  const APPLY_BATCH_SIZE = 50;
  let processed = 0;

  for (let start = 0; start < plans.length; start += APPLY_BATCH_SIZE) {
    const batch = plans.slice(start, start + APPLY_BATCH_SIZE);
    const lookups = await Promise.all(
      batch.map(async (plan) => {
        try {
          const [instance, targetComponent] = await Promise.all([
            figma.getNodeByIdAsync(plan.instanceId),
            plan.targetComponentId ? figma.getNodeByIdAsync(plan.targetComponentId) : Promise.resolve(null),
          ]);
          return { instance, targetComponent, error: null as Error | null };
        } catch (error: unknown) {
          return {
            instance: null,
            targetComponent: null,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }),
    );

    for (let i = 0; i < batch.length; i += 1) {
      const plan = batch[i];
      const { instance, targetComponent, error } = lookups[i];

      try {
        if (error) {
          throw error;
        }

        if (instance?.type !== 'INSTANCE') {
          throw new Error('Could not find this instance.');
        }

        if (targetComponent?.type !== 'COMPONENT') {
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
        } else {
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
      } catch (mutationError: unknown) {
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

type BoundColorHit = {
  variableId: string;
  node: SceneNode;
  paintIndex: number;
  source: 'fill' | 'stroke';
};

// Generic DFS over a subtree, calling `visit` for each fill/stroke that
// carries a bound color variable. Stops at the first visitor result that
// isn't null. Used both for plain ID lookups (apply path) and rich metadata
// dumps (debug path) — returning null from the visitor keeps searching.
async function visitFirstBoundColor<T>(
  node: SceneNode,
  depth: number,
  visit: (hit: BoundColorHit) => Promise<T | null>,
): Promise<T | null> {
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

async function findFirstBoundColorVariableId(node: SceneNode): Promise<string | null> {
  return visitFirstBoundColor(node, 0, async (hit) => hit.variableId);
}

async function findColorCollectionForComponentSet(componentSet: ComponentSetNode): Promise<VariableCollection | null> {
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
    } catch {
      // continue searching
    }
  }
  return null;
}

function findVariantByNonColorProps(componentSet: ComponentSetNode, instance: InstanceNode): ComponentNode | null {
  const targetValues: Record<string, string> = {};
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

function getInstanceColorPropertyValue(instance: InstanceNode): string | null {
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

async function findLegacyColorModeOverride(instance: InstanceNode): Promise<{
  collectionId: string;
  collectionName: string;
  modeName: string;
} | null> {
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
    } catch {
      // continue
    }
  }
  return null;
}

async function scanLibraryStuckInstances(scope: FixScope): Promise<OperationResultPayload> {
  const operation: Operation = 'scan-library-stuck-instances';
  pendingLibraryStuckInstancePlans = [];

  postOperationProgress({ operation, message: getScopeLoadingMessage(scope) });

  const instances = await getInstancesForScope(scope);

  const candidates: Array<{ instance: InstanceNode; colorValue: string; oldComponentSetKey: string; oldComponentSetName: string }> = [];

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
    const oldComponentSet = main.parent as ComponentSetNode;
    // Alert and ValidationMessage intentionally keep their color variant as
    // a severity selector (info / warning / danger / success). Figma's
    // library update path keeps these instances in sync automatically, so
    // we must not include them as migration candidates — otherwise the
    // variant lookup would strip the severity and swap to the default
    // (typically info) and clear any explicit mode.
    if (COLOR_MODE_MIGRATION_COMPONENT_SET_NAMES.some(
      (name) => normalizeToken(name) === normalizeToken(oldComponentSet.name),
    )) {
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

  const uniqueKeys = new Set<string>();
  for (const candidate of candidates) {
    uniqueKeys.add(candidate.oldComponentSetKey);
  }

  // Import all needed component sets in parallel. Each import triggers a
  // round-trip to Figma's main thread, so running them sequentially scales
  // badly on files with many unique component sets.
  const importResults = await Promise.all(
    Array.from(uniqueKeys).map(async (key) => {
      try {
        const newSet = await figma.importComponentSetByKeyAsync(key);
        const collection = await findColorCollectionForComponentSet(newSet);
        return { key, newSet, collection, error: null as string | null };
      } catch (error) {
        return {
          key,
          newSet: null,
          collection: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const newComponentSetByKey = new Map<string, ComponentSetNode>();
  const colorCollectionByKey = new Map<string, VariableCollection>();
  const importErrorByKey = new Map<string, string>();
  let fallbackColorCollection: VariableCollection | null = null;
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

  const plans: LibraryStuckInstancePlan[] = [];
  for (const candidate of candidates) {
    const instance = candidate.instance;
    const legacy = await findLegacyColorModeOverride(instance);

    const plan: LibraryStuckInstancePlan = {
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

    let desiredModeName: string | null = null;
    if (legacy) {
      desiredModeName = legacy.modeName;
    } else if (normalizeToken(candidate.colorValue) === 'neutral') {
      desiredModeName = NEUTRAL_MODE_NAME;
    } else if (normalizeToken(candidate.colorValue) === 'main') {
      desiredModeName = null;
    } else if (normalizeToken(candidate.colorValue) === 'support') {
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
      const mode = colorCollection.modes.find((m) => normalizeToken(m.name) === normalizeToken(desiredModeName as string));
      if (mode) {
        plan.targetModeName = mode.name;
        plan.targetModeId = mode.modeId;
        plan.status = 'ready';
      } else {
        plan.status = 'review';
        plan.reason = `Mode "${desiredModeName}" does not exist in the new Color collection — set it manually after update.`;
      }
    } else {
      plan.status = 'ready';
    }

    plans.push(plan);
  }

  pendingLibraryStuckInstancePlans = plans;

  const readyCount = plans.filter((p) => p.status === 'ready').length;
  const reviewCount = plans.filter((p) => p.status === 'review').length;
  const blockedCount = plans.filter((p) => p.status === 'blocked').length;
  const supportFallbackCount = plans.filter((p) => p.needsSupportModeChoice).length;

  const availableColorModes: JsonValue[] = fallbackColorCollection
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
      plans: plans as unknown as JsonValue,
    },
  };
}

async function applyLibraryStuckInstancePlans(supportFallbackModeId: string | null): Promise<OperationResultPayload> {
  const operation: Operation = 'apply-library-stuck-instances';
  const plans = pendingLibraryStuckInstancePlans;

  let fixedCount = 0;
  let failedCount = 0;
  const failures: Array<{ instanceId: string; instanceName: string; reason: string }> = [];

  const applicablePlans = plans.filter((p) => p.status !== 'blocked');

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

      const instanceNode = instance as InstanceNode;

      instanceNode.swapComponent(targetVariant as ComponentNode);

      if (plan.legacyModeCollectionId) {
        try {
          const legacyCollection = await figma.variables.getVariableCollectionByIdAsync(plan.legacyModeCollectionId);
          if (legacyCollection) {
            instanceNode.clearExplicitVariableModeForCollection(legacyCollection);
          }
        } catch {
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

      fixedCount += 1;
    } catch (error) {
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

  return {
    createdAt: new Date().toISOString(),
    operation,
    status: failedCount > 0 ? 'error' : 'success',
    message: `Updated ${fixedCount} instance${fixedCount === 1 ? '' : 's'}${failedCount > 0 ? `, failed ${failedCount}` : ''}.`,
    details: {
      fixedCount,
      failedCount,
      failures: failures as unknown as JsonValue,
    },
  };
}


async function runOperation(operation: Operation, callback: () => Promise<OperationResultPayload>) {
  postToUi({
    type: 'operation-result',
    payload: await callback().catch((error) => asErrorResult(operation, error)),
  });
}

figma.ui.onmessage = async (msg: PluginMessage) => {
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
    await runOperation('apply-library-stuck-instances', () => applyLibraryStuckInstancePlans(msg.supportFallbackModeId));
  }
};
