import { postOperationProgress } from '../../core/harness';
import type {
  FixScope,
  JsonValue,
  MigrationModule,
  OperationResultPayload,
} from '../../core/types';

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
  willCollapseToSingleComponent: boolean;
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

// A loose color-variable binding on a non-instance node (frame, text, vector,
// etc.) that still points at a legacy color collection and should be rebound
// to the post-migration Color collection.
type LegacyColorRebindPlan = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  pageName: string | null;
  bindingCount: number;
  matchedCount: number;
  unmatchedNames: string[];
  legacyModeCollectionId: string | null;
  legacyModeCollectionName: string | null;
  legacyModeName: string | null;
  targetColorCollectionId: string | null;
  targetModeId: string | null;
  targetModeName: string | null;
  // True for review items that only lack a mode: a user-picked fallback mode
  // makes them cleanable.
  needsSupportModeChoice: boolean;
  status: 'ready' | 'review';
  reason?: string;
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
// Older components used both "color" and "color mode" as the variant property
// that selected neutral/support/etc. Treat both as the same migration axis.
const COLOR_VARIANT_PROPERTY_NAMES = ['color', 'color mode'];
// Left untouched by the migration: these keep their color variants and their
// hardcoded Semantic (severity) color bindings as-is. They are skipped in both
// the variant-removal scan and the stuck-instance scan.
const PRESERVED_COMPONENT_SET_NAMES = ['Alert', 'ValidationMessage'];
const SEMANTIC_COLOR_GROUPS = ['info', 'warning', 'danger', 'success'];
const SKIP_MISSING_INSTANCE_MODE_CONTEXTS = ['TableColumn'];

let pendingUnsupportedVariantPlans: ComponentSetRemovalPlan[] = [];
let pendingMissingInstancePlans: MissingInstancePlan[] = [];
// Scope of the last missing-instance scan, so the apply step can re-walk the
// same area for the nested-instance fixing pass. null = no scan run yet.
let pendingMissingInstanceScope: FixScope | null = null;
// Nested broken instances found by the last scan. Seeds the apply step's
// nested-fix pass (affected top instances + target names) so it does not have
// to re-walk the whole file just to rediscover them.
let pendingNestedSwapped: NestedSwappedInstance[] = [];
let pendingLibraryStuckInstancePlans: LibraryStuckInstancePlan[] = [];
let pendingLegacyColorRebindPlans: LegacyColorRebindPlan[] = [];

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

  // No same-named mode: fall back to the collection's own default mode rather
  // than a hardcoded name (users may rename their default mode). modes[0] is a
  // last-resort guard in case the default can't be resolved.
  return collection.modes.find((mode) => mode.modeId === collection.defaultModeId)
    || collection.modes[0]
    || null;
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
  const operation ='check-prime-status';
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

type ComponentTargets = {
  componentSets: ComponentSetNode[];
  standaloneComponents: ComponentNode[];
};

// Walk the tree and collect both ComponentSets and standalone Components
// whose names match. A "standalone" Component is one whose parent is not a
// ComponentSet — these arise from Step 2's collapse path (single-variant
// component sets are converted to standalone components named after the
// original set).
function collectComponentTargets(root: PageNode | SceneNode, wantedNames?: Set<string>): ComponentTargets {
  const componentSets: ComponentSetNode[] = [];
  const standaloneComponents: ComponentNode[] = [];
  const visit = (node: PageNode | SceneNode) => {
    if (node.type === 'COMPONENT_SET') {
      if (!wantedNames || wantedNames.has(normalizeToken(node.name))) {
        componentSets.push(node);
      }
    } else if (node.type === 'COMPONENT') {
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

function getMissingComponentSetNames(plans: MissingInstancePlan[]) {
  return new Set(
    plans
      .filter((plan) => plan.componentSetName !== 'Unknown')
      .map((plan) => normalizeToken(plan.componentSetName)),
  );
}

async function findComponentTargetsByNames(wantedNames: Set<string>, scope: FixScope): Promise<ComponentTargets & {
  searchedWholeFile: boolean;
}> {
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
  const allSets: ComponentSetNode[] = [...currentPage.componentSets];
  const allStandalone: ComponentNode[] = [...currentPage.standaloneComponents];
  const seenIds = new Set<string>([
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

// A nested instance (one living inside another instance) whose pinned main
// component no longer resolves to a live variant. This happens when the
// migration deletes the local variant the nested instance points to (e.g. an
// Avatar pinned to the removed `support` variant inside an AvatarStack). There
// is no swap override in this case — the breakage is variant deletion — so the
// only reliable signal is the resolved main-component state. Our normal scans
// stop at instance boundaries (for performance), so they never see these.
type NestedSwappedInstance = {
  nodeId: string;
  nodeName: string;
  topInstanceId: string;
  topInstanceName: string | null;
  pageName: string | null;
  // Distance from the top instance — used to fix shallowest-first so an outer
  // swap can repair/replace inner ones before we try them.
  depth: number;
  oldComponentName: string | null;
  oldComponentSetName: string | null;
  // Why it is broken: its pinned main component is gone (missing) or is a
  // removed local variant (detached-local).
  mainState: 'missing' | 'detached-local';
};

// Read-only overview: locate nested instances whose pinned variant was deleted
// by the migration. Detection is by resolved main-component state, NOT by swap
// overrides — these instances were never swapped, so `.overrides` does not list
// them (and deep ones don't appear there at all). We therefore walk into
// instance subtrees and check each instance's main.
//
// To stay bounded we only descend into instances whose main is local
// (remote === false) or already broken: a clean remote instance's internals
// come from the migrated library and cannot hold a deleted *local* variant.
// Does not mutate anything.
const NESTED_SWAPPED_MAX_NODES = 50000;

async function collectNestedSwappedInstances(topInstances: InstanceNode[]): Promise<NestedSwappedInstance[]> {
  const found: NestedSwappedInstance[] = [];
  const reportedNodeIds = new Set<string>();
  let walked = 0;

  const visit = async (node: SceneNode, top: InstanceNode, depth: number): Promise<void> => {
    if (walked > NESTED_SWAPPED_MAX_NODES) {
      return;
    }
    walked += 1;

    let descend = true;

    // Skip the root (depth 0): top-level instances are handled by the main
    // scans. We only report instances nested inside them.
    if (node.type === 'INSTANCE' && depth > 0) {
      let main: ComponentNode | null = null;
      try {
        main = await node.getMainComponentAsync();
      } catch {
        main = null;
      }

      let mainState: NestedSwappedInstance['mainState'] | 'ok';
      if (!main) {
        mainState = 'missing';
      } else if (main.remote === false && !main.parent) {
        mainState = 'detached-local';
      } else {
        mainState = 'ok';
      }

      if ((mainState === 'missing' || mainState === 'detached-local') && !reportedNodeIds.has(node.id)) {
        reportedNodeIds.add(node.id);
        const oldComponentSetName = main && main.parent && main.parent.type === 'COMPONENT_SET'
          ? main.parent.name
          : null;
        found.push({
          nodeId: node.id,
          nodeName: node.name,
          topInstanceId: top.id,
          topInstanceName: top.name,
          pageName: getPageName(node),
          depth,
          oldComponentName: main ? main.name : null,
          oldComponentSetName,
          mainState,
        });
      }

      // A clean remote instance's subtree comes from the migrated library and
      // cannot contain a deleted local variant — no need to pay to walk it.
      if (main && main.remote === true) {
        descend = false;
      }
    }

    if (descend && 'children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        await visit(child, top, depth + 1);
      }
    }
  };

  for (const top of topInstances) {
    await visit(top, top, 0);
  }

  return found;
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
  // Component sets Figma reports as being in an error state — tracked
  // separately so the scan summary can name them for the user to fix.
  const errorComponentSetNames: string[] = [];

  for (let index = 0; index < componentSets.length; index += 1) {
    const componentSet = componentSets[index];

    // Alert and ValidationMessage keep their color variants and their hardcoded
    // Semantic (severity) color bindings. Leave them completely untouched.
    if (PRESERVED_COMPONENT_SET_NAMES.some(
      (name) => normalizeToken(name) === normalizeToken(componentSet.name),
    )) {
      skippedComponentSets.push({
        id: componentSet.id,
        name: componentSet.name,
        reason: 'Alert and ValidationMessage keep their color variants — left unchanged.',
      });
      continue;
    }

    const children = componentSet.children.filter((child): child is ComponentNode => child.type === 'COMPONENT');

    // A component set in a Figma error state (e.g. conflicting/duplicate
    // variant combinations) throws on any variantProperties access with
    // "Component set for node has existing errors". Reading it here would
    // otherwise abort the entire scan, so isolate the failure to this one set:
    // record it as skipped and move on.
    let hasColorProperty: boolean;
    try {
      hasColorProperty = children.some((child) => getColorVariantPropertyKey(child) !== null);
    } catch {
      errorComponentSetNames.push(componentSet.name);
      skippedComponentSets.push({
        id: componentSet.id,
        name: componentSet.name,
        reason: 'Component set has existing errors in Figma (e.g. conflicting variants) — fix it and rescan.',
      });
      continue;
    }

    if (hasColorProperty) {
      const plan: ComponentSetRemovalPlan = {
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

  const removeCount = plans.reduce((sum, plan) => sum + plan.variantsToRemove.length, 0);
  const renameCount = plans.reduce((sum, plan) => sum + plan.variantsToRename.length, 0);
  const skippedRenameCount = plans.reduce((sum, plan) => sum + plan.skippedRenames.length, 0);

  if (removeCount === 0 && renameCount === 0) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'noop',
      message: 'No old color variants found.',
      details: {
        scannedComponentSetCount: componentSets.length,
        skippedComponentSets,
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
    message: `Found ${removeCount} variant${removeCount === 1 ? '' : 's'} to remove and ${renameCount} variant${renameCount === 1 ? '' : 's'} to rename.`,
    details: {
      scannedComponentSetCount: componentSets.length,
      affectedComponentSetCount: plans.length,
      skippedComponentSets,
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
async function collapseSingleVariantComponentSet(plan: ComponentSetRemovalPlan): Promise<void> {
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
  } catch {
    // already gone
  }
}

async function applyUnsupportedVariantPlans(): Promise<OperationResultPayload> {
  const operation = 'apply-unsupported-variants';
  const plans = pendingUnsupportedVariantPlans;

  if (plans.length === 0) {
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

    if (plan.willCollapseToSingleComponent) {
      try {
        await collapseSingleVariantComponentSet(plan);
      } catch (error) {
        failed.push({
          id: plan.componentSetId,
          name: plan.componentSetName,
          action: 'collapse',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  pendingUnsupportedVariantPlans = [];

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
        : `Removed ${removed.length} variant${removed.length === 1 ? '' : 's'} and renamed ${renamed.length}.`,
    details: {
      removedCount: removed.length,
      renamedCount: renamed.length,
      failedCount: failed.length,
      removed,
      renamed,
      failed,
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

function findTargetComponent(lookup: ComponentTargets, componentSetName: string, tokens: string[]): {
  component: ComponentNode | null;
  reason?: string;
  candidateCount: number;
  candidateNames: string[];
  targetPropertyValues: Record<string, string> | null;
} {
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
  pendingMissingInstanceScope = scope;

  if (plans.length > 0) {
    const wantedNames = getMissingComponentSetNames(plans);
    const targetLookup = await findComponentTargetsByNames(wantedNames, scope);

    for (const plan of plans) {
      const targetComponentResult =
        plan.componentSetName !== 'Unknown'
          ? findTargetComponent(targetLookup, plan.componentSetName, plan.nonColorTokens)
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

  // Support cleanup is folded into this flow: also scan loose Support color
  // bindings on non-instance layers in the same scope. The support fallback
  // chosen here applies to both instances and these layers.
  const loose = await collectLegacyColorRebindPlans(scope, colorCollection);
  const looseHasWork = loose.readyCount + loose.reviewCount > 0;
  const looseCleanable = loose.readyCount + loose.supportFallbackCount;
  const looseNeedsReviewOnly = loose.reviewCount - loose.supportFallbackCount;
  const looseSuffix = looseHasWork
    ? ` Plus ${looseCleanable} support layer${looseCleanable === 1 ? '' : 's'} to clean up${looseNeedsReviewOnly > 0 ? ` (${looseNeedsReviewOnly} need review)` : ''}.`
    : '';

  // Walk for broken nested instances over the same scope and store the result
  // as a seed for the apply step (so it does not re-walk the whole file). Not
  // surfaced in the scan result — the apply step fixes them.
  pendingNestedSwapped = await collectNestedSwappedInstances(instances);

  if (plans.length === 0 && !looseHasWork) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'noop',
      message: 'No missing instances or support color layers found.',
      details: {
        scope,
        scannedInstanceCount: instances.length,
      },
    };
  }

  const hasApplicableWork = readyCount > 0 || looseCleanable > 0;

  return {
    createdAt: new Date().toISOString(),
    operation,
    // 'error' only when there are missing instances but nothing can be applied.
    status: hasApplicableWork || plans.length === 0 ? 'preview' : 'error',
    message: plans.length === 0
      ? `No missing instances found.${looseSuffix}`
      : `Found ${plans.length} missing instance${plans.length === 1 ? '' : 's'}: ${readyCount} ready, ${blockedCount} blocked.${looseSuffix}`,
    details: {
      scope,
      scannedInstanceCount: instances.length,
      readyCount,
      blockedCount,
      supportLayerReadyCount: loose.readyCount,
      supportLayerFallbackCount: loose.supportFallbackCount,
      supportLayerReviewCount: loose.reviewCount,
      plans,
    },
  };
}

// Mirror of shouldSkipModeForMissingInstance for instances nested inside other
// instances. getComponentContext finds no component ancestor across instance
// boundaries, so check ancestor names directly: leave neutral mode unset when
// the nested instance sits inside a context we intentionally skip (TableColumn).
function nestedShouldSkipNeutralMode(node: SceneNode, removedColor: string): boolean {
  if (normalizeToken(removedColor) !== 'neutral') {
    return false;
  }
  let current: BaseNode | null = node.parent;
  while (current) {
    if (SKIP_MISSING_INSTANCE_MODE_CONTEXTS.some((name) => normalizeToken(name) === normalizeToken(current!.name))) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

type NestedFixResult = {
  fixedCount: number;
  failedCount: number;
  blockedCount: number;
  skippedModeCount: number;
  fixed: JsonValue[];
  failed: JsonValue[];
};

// Fix instances nested inside other instances whose pinned variant was removed.
// Uses the same target-resolution as top-level missing instances (parse old
// name → match current variant → swap → set mode), but applies it per top
// instance in shallowest-first passes: swapping an outer instance re-materializes
// its subtree (often repairing inner ones and always changing their node ids),
// so we re-walk after each pass until nothing fixable remains. Read at apply
// time, not from a stored plan, because those ids go stale after each swap.
async function applyNestedMissingInstanceFixes(
  scope: FixScope,
  supportModeId: string | null,
  colorCollection: VariableCollection,
  seed: NestedSwappedInstance[],
): Promise<NestedFixResult> {
  const operation = 'apply-missing-instances';
  const fixed: JsonValue[] = [];
  const failed: JsonValue[] = [];
  const blockedNodeIds = new Set<string>();
  let skippedModeCount = 0;

  // Seed from the scan's overview when available (the common path); only re-walk
  // the whole scope if we have no seed.
  let seedList = seed;
  if (seedList.length === 0) {
    const topInstances = await getInstancesForScope(scope);
    seedList = await collectNestedSwappedInstances(topInstances);
  }
  if (seedList.length === 0) {
    return { fixedCount: 0, failedCount: 0, blockedCount: 0, skippedModeCount: 0, fixed, failed };
  }

  const affectedTopIds = Array.from(new Set(seedList.map((item) => item.topInstanceId)));

  // Build the target-component lookup ONCE and reuse it across every pass and
  // top instance. This was the dominant cost on whole-file runs — the lookup
  // can walk all pages, and we were rebuilding it per pass per top instance.
  // The target component sets do not change during apply, so caching is safe.
  const allWantedNames = new Set<string>();
  for (const item of seedList) {
    if (item.oldComponentName) {
      allWantedNames.add(normalizeToken(parseRemovedComponentName(item.oldComponentName).componentSetName));
    }
  }
  const lookup = await findComponentTargetsByNames(allWantedNames, scope);
  const MAX_PASSES = 6;

  for (let t = 0; t < affectedTopIds.length; t += 1) {
    const topId = affectedTopIds[t];
    let pass = 0;

    postOperationProgress({
      operation,
      message: 'Updating nested instances...',
      processed: t,
      total: affectedTopIds.length,
    });

    while (pass < MAX_PASSES) {
      const topNode = await figma.getNodeByIdAsync(topId);
      if (!topNode || topNode.type !== 'INSTANCE') {
        break;
      }

      const broken = (await collectNestedSwappedInstances([topNode]))
        .filter((item) => !blockedNodeIds.has(item.nodeId));
      if (broken.length === 0) {
        break;
      }

      // Shallowest first: an outer swap can repair/replace inner ones.
      broken.sort((a, b) => a.depth - b.depth);

      let fixedThisPass = 0;
      for (const item of broken) {
        const node = await figma.getNodeByIdAsync(item.nodeId);
        if (!node || node.type !== 'INSTANCE') {
          // Gone this pass — its id changed because an ancestor was swapped.
          // It will reappear (or be resolved) on the next pass's fresh walk.
          continue;
        }

        const parsed = item.oldComponentName ? parseRemovedComponentName(item.oldComponentName) : null;
        const removedColor = parsed?.removedColor || null;
        const targetResult = parsed
          ? findTargetComponent(lookup, parsed.componentSetName, parsed.nonColorTokens)
          : null;
        const targetComponent = targetResult?.component || null;
        const mode = removedColor ? findTargetMode(colorCollection, removedColor, supportModeId) : null;

        if (!parsed || !removedColor || !targetComponent || !mode) {
          blockedNodeIds.add(item.nodeId);
          failed.push({
            nodeId: item.nodeId,
            nodeName: item.nodeName,
            topInstanceName: item.topInstanceName,
            reason: targetResult?.reason || 'Could not resolve a target variant or color mode.',
          });
          continue;
        }

        try {
          const instanceNode = node;
          instanceNode.swapComponent(targetComponent);

          const skipMode = nestedShouldSkipNeutralMode(instanceNode, removedColor);
          if (skipMode) {
            skippedModeCount += 1;
          } else {
            const setExplicitVariableModeForCollection = instanceNode.setExplicitVariableModeForCollection.bind(instanceNode);
            setExplicitVariableModeForCollection(colorCollection, mode.modeId);
          }

          fixed.push({
            nodeId: item.nodeId,
            nodeName: item.nodeName,
            topInstanceName: item.topInstanceName,
            targetComponentName: targetComponent.name,
            targetModeName: skipMode ? null : mode.name,
          });
          fixedThisPass += 1;
        } catch (error) {
          blockedNodeIds.add(item.nodeId);
          failed.push({
            nodeId: item.nodeId,
            nodeName: item.nodeName,
            topInstanceName: item.topInstanceName,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (fixedThisPass === 0) {
        break;
      }
      pass += 1;
    }
  }

  return {
    fixedCount: fixed.length,
    failedCount: failed.length,
    blockedCount: blockedNodeIds.size,
    skippedModeCount,
    fixed,
    failed,
  };
}

async function applyMissingInstancePlans(supportModeId: string | null): Promise<OperationResultPayload> {
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
  // null scope means no scan has run this session — that's the real "apply
  // before scan" case. After any scan we proceed even with no ready top-level
  // plans, because the nested-instance fix re-walks the scope itself.
  if (plans.length === 0 && pendingLegacyColorRebindPlans.length === 0 && pendingMissingInstanceScope === null) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'noop',
      message: 'Scan instances before applying changes.',
      details: {},
    };
  }

  const nestedScope = pendingMissingInstanceScope;

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

  // Fix instances nested inside other instances (not reachable by the top-level
  // scan). Run after the top-level apply so masters are already updated, then
  // swapping a nested instance pulls a correct subtree. Re-walks the scope.
  postOperationProgress({ operation, message: 'Updating nested instances...' });
  const nested: NestedFixResult = nestedScope
    ? await applyNestedMissingInstanceFixes(nestedScope, supportModeId, colorCollection, pendingNestedSwapped)
    : { fixedCount: 0, failedCount: 0, blockedCount: 0, skippedModeCount: 0, fixed: [], failed: [] };
  pendingMissingInstanceScope = null;
  pendingNestedSwapped = [];

  // Folded-in support cleanup: rebind loose Support color layers found during
  // scan, using the same support fallback mode chosen for the instances.
  const cleanup = await applyLegacyColorRebindPlans(supportModeId);

  if (fixed.length > 0 || nested.fixedCount > 0 || cleanup.reboundCount > 0 || cleanup.modeSetCount > 0) {
    figma.commitUndo();
  }

  const cleanupSuffix = cleanup.nodeFixedCount > 0
    ? ` Cleaned up ${cleanup.reboundCount} support binding${cleanup.reboundCount === 1 ? '' : 's'} on ${cleanup.nodeFixedCount} layer${cleanup.nodeFixedCount === 1 ? '' : 's'}.`
    : '';
  const nestedSuffix = nested.fixedCount > 0 || nested.failedCount > 0
    ? ` Fixed ${nested.fixedCount} nested instance${nested.fixedCount === 1 ? '' : 's'}${nested.failedCount > 0 ? `, ${nested.failedCount} could not be resolved` : ''}.`
    : '';

  return {
    createdAt: new Date().toISOString(),
    operation,
    status: failed.length + cleanup.failedCount > 0 ? 'error' : 'success',
    message: `Fixed ${fixed.length} missing instance${fixed.length === 1 ? '' : 's'}${failed.length > 0 ? `, failed ${failed.length}` : ''}.${nestedSuffix}${cleanupSuffix}`,
    details: {
      fixedCount: fixed.length,
      failedCount: failed.length,
      skippedModeCount,
      nestedFixedCount: nested.fixedCount,
      nestedFailedCount: nested.failedCount,
      nestedSkippedModeCount: nested.skippedModeCount,
      supportLayerFixedCount: cleanup.nodeFixedCount,
      supportBindingReboundCount: cleanup.reboundCount,
      supportLayerFailedCount: cleanup.failedCount,
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
// isn't null — returning null from the visitor keeps searching.
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

async function findLegacyColorModeOverride(node: SceneNode): Promise<{
  collectionId: string;
  collectionName: string;
  modeName: string;
} | null> {
  const explicit = node.explicitVariableModes || {};
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
  const operation ='scan-library-stuck-instances';
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
    // variant lookup would strip the severity and swap to the default.
    if (PRESERVED_COMPONENT_SET_NAMES.some(
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
    } else if (SEMANTIC_COLOR_GROUPS.includes(normalizeToken(candidate.colorValue))) {
      // info/warning/danger/success used to be selected by the color variant;
      // post-migration they resolve through a same-named mode in the new Color
      // collection. Mirror findTargetMode/getColorModeForComponent so a stuck
      // instance (e.g. a color=danger button) gets its severity mode set.
      desiredModeName = candidate.colorValue;
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
  const instanceSupportFallbackCount = plans.filter((p) => p.needsSupportModeChoice).length;

  // Fold in loose Support color cleanup over the same scope, using the Color
  // collection discovered while importing the stuck component sets. Without a
  // discovered collection (e.g. no stuck instances) we can't resolve targets.
  let looseScan: LegacyColorRebindScan = {
    plans: [], scannedNodeCount: 0, readyCount: 0, reviewCount: 0, supportFallbackCount: 0, reboundBindingCount: 0,
  };
  if (fallbackColorCollection) {
    looseScan = await collectLegacyColorRebindPlans(scope, fallbackColorCollection);
  } else {
    pendingLegacyColorRebindPlans = [];
  }
  const looseCleanable = looseScan.readyCount + looseScan.supportFallbackCount;
  const looseNeedsReviewOnly = looseScan.reviewCount - looseScan.supportFallbackCount;
  const looseSuffix = looseScan.readyCount + looseScan.reviewCount > 0
    ? ` Plus ${looseCleanable} support layer${looseCleanable === 1 ? '' : 's'} to clean up${looseNeedsReviewOnly > 0 ? ` (${looseNeedsReviewOnly} need review)` : ''}.`
    : '';

  // The fallback dropdown is needed if either instances or loose layers lack a
  // mode; the single choice is applied to both.
  const supportFallbackCount = instanceSupportFallbackCount + looseScan.supportFallbackCount;

  const availableColorModes: JsonValue[] = fallbackColorCollection
    ? fallbackColorCollection.modes.map((m) => ({ modeId: m.modeId, name: m.name }))
    : [];

  const hasAnyWork = readyCount + reviewCount > 0 || looseCleanable > 0;

  return {
    createdAt: new Date().toISOString(),
    operation,
    status: hasAnyWork ? 'preview' : 'noop',
    message: hasAnyWork
      ? `Scanned ${instances.length} instances. ${readyCount} can be updated, ${reviewCount} need review, ${blockedCount} blocked.${looseSuffix}`
      : `Scanned ${instances.length} instances. No stuck library instances or support color layers found.`,
    details: {
      scannedInstanceCount: instances.length,
      candidateCount: candidates.length,
      readyCount,
      reviewCount,
      blockedCount,
      supportFallbackCount,
      supportLayerReadyCount: looseScan.readyCount,
      supportLayerFallbackCount: looseScan.supportFallbackCount,
      supportLayerReviewCount: looseScan.reviewCount,
      availableColorModes,
      plans: plans as unknown as JsonValue,
    },
  };
}

async function buildNewColorVariableMap(collectionId: string): Promise<Map<string, Variable>> {
  const map = new Map<string, Variable>();
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

type RebindStats = { rebound: number; skipped: number; failed: number };

type LegacyColorCategory = 'main' | 'support' | 'neutral';

// Matches legacy color variable names like "color/main/base-default" and keeps
// the category group, so support bindings (the ones that depend on a mode) can
// be told apart. The capture groups are [category, flat-name-for-new-Color].
const LEGACY_COLOR_VARIABLE_CATEGORY_PATTERN = /^color\/(main|support|neutral)\/(.+)$/;

// Decide whether a bound variable is a legacy color reference, and if so which
// category it belongs to and the flat name to look up in the new Color
// collection. Mirrors the qualifies-as-legacy rule used across the migration:
//   - name matches color/(main|support|neutral)/* (catches Semantic-collection
//     bindings to legacy-named variables), OR
//   - it lives in a legacy color collection (Main color / Support color).
function classifyLegacyColorVariable(
  variableName: string,
  collectionName: string | null,
): { category: LegacyColorCategory; lookupName: string } | null {
  const match = variableName.match(LEGACY_COLOR_VARIABLE_CATEGORY_PATTERN);
  if (match) {
    return { category: match[1] as LegacyColorCategory, lookupName: match[2] };
  }
  if (collectionName && LEGACY_COLOR_COLLECTION_NAMES.indexOf(collectionName) !== -1) {
    return {
      category: collectionName === 'Support color' ? 'support' : 'main',
      lookupName: variableName,
    };
  }
  return null;
}

type LegacyPaintTarget = {
  oldVariableName: string;
  category: LegacyColorCategory;
  newVariable: Variable | null;
};

// Resolve a single paint to its legacy-rebind target (or null when the paint
// isn't a legacy color binding). Shared by the subtree rebind, the loose-node
// scan, and the loose-node apply so detection stays single-sourced.
async function resolveLegacyColorPaintTarget(
  paint: Paint,
  newColorVariableMap: Map<string, Variable>,
  variableCache: Map<string, Variable | null>,
  collectionCache: Map<string, VariableCollection | null>,
): Promise<LegacyPaintTarget | null> {
  // Only SolidPaint has boundVariables.color; gradients/images bind different
  // fields and aren't relevant to color-variable rebinding.
  if (!paint || paint.type !== 'SOLID') {
    return null;
  }
  const variableId = paint.boundVariables && paint.boundVariables.color
    ? paint.boundVariables.color.id
    : null;
  if (!variableId) {
    return null;
  }

  let variable = variableCache.get(variableId);
  if (variable === undefined) {
    try {
      variable = await figma.variables.getVariableByIdAsync(variableId);
    } catch {
      variable = null;
    }
    variableCache.set(variableId, variable === undefined ? null : variable);
  }
  if (!variable) {
    return null;
  }

  let collection = collectionCache.get(variable.variableCollectionId);
  if (collection === undefined) {
    try {
      collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    } catch {
      collection = null;
    }
    collectionCache.set(variable.variableCollectionId, collection === undefined ? null : collection);
  }

  const classified = classifyLegacyColorVariable(variable.name, collection ? collection.name : null);
  if (!classified) {
    return null;
  }

  return {
    oldVariableName: variable.name,
    category: classified.category,
    newVariable: newColorVariableMap.get(normalizeToken(classified.lookupName)) || null,
  };
}

// Walk a subtree (including into nested instances) and replace any
// fill/stroke boundVariables.color binding that points to a legacy color
// variable with the matching new Color-collection variable. A binding
// qualifies as "legacy" if:
//   - its collection is Main color, Support color, or Neutral color, OR
//   - its name matches color/(main|support|neutral)/* — catches Semantic-
//     collection bindings to legacy-named variables (the neutral case).
async function rebindLegacyColorBindingsInSubtree(
  node: SceneNode,
  newColorVariableMap: Map<string, Variable>,
  variableCache: Map<string, Variable | null>,
  collectionCache: Map<string, VariableCollection | null>,
): Promise<RebindStats> {
  const stats: RebindStats = { rebound: 0, skipped: 0, failed: 0 };

  async function evaluatePaints(paints: ReadonlyArray<Paint>): Promise<Paint[] | null> {
    let mutated = false;
    const next: Paint[] = paints.slice();
    for (let i = 0; i < next.length; i += 1) {
      const target = await resolveLegacyColorPaintTarget(next[i], newColorVariableMap, variableCache, collectionCache);
      if (!target) {
        continue;
      }
      if (!target.newVariable) {
        stats.skipped += 1;
        continue;
      }

      try {
        // resolveLegacyColorPaintTarget only returns a target for SolidPaint.
        next[i] = figma.variables.setBoundVariableForPaint(next[i] as SolidPaint, 'color', target.newVariable);
        mutated = true;
        stats.rebound += 1;
      } catch {
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

async function applyLibraryStuckInstancePlans(supportFallbackModeId: string | null, rebindLegacyVariables: boolean): Promise<OperationResultPayload> {
  const operation ='apply-library-stuck-instances';
  const plans = pendingLibraryStuckInstancePlans;

  let fixedCount = 0;
  let failedCount = 0;
  let totalRebound = 0;
  let totalRebindSkipped = 0;
  let totalRebindFailed = 0;
  const failures: Array<{ instanceId: string; instanceName: string; reason: string }> = [];

  const applicablePlans = plans.filter((p) => p.status !== 'blocked');

  // Pre-build the name→variable map for the new Color collection so we only
  // do the variableIds walk once across all instances. Keyed by the
  // collection ID found during scan — assumes all plans share the same
  // target Color collection (true for a single-library migration).
  const colorVariableMaps = new Map<string, Map<string, Variable>>();
  const rebindVariableCache = new Map<string, Variable | null>();
  const rebindCollectionCache = new Map<string, VariableCollection | null>();

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

      if (rebindLegacyVariables && plan.targetColorCollectionId) {
        let variableMap = colorVariableMaps.get(plan.targetColorCollectionId);
        if (!variableMap) {
          variableMap = await buildNewColorVariableMap(plan.targetColorCollectionId);
          colorVariableMaps.set(plan.targetColorCollectionId, variableMap);
        }
        const stats = await rebindLegacyColorBindingsInSubtree(
          instanceNode,
          variableMap,
          rebindVariableCache,
          rebindCollectionCache,
        );
        totalRebound += stats.rebound;
        totalRebindSkipped += stats.skipped;
        totalRebindFailed += stats.failed;
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

  pendingLibraryStuckInstancePlans = [];

  // Folded-in support cleanup for loose layers found during scan, using the
  // same support fallback mode chosen for the instances.
  const cleanup = await applyLegacyColorRebindPlans(supportFallbackModeId);

  if (fixedCount > 0 || cleanup.reboundCount > 0 || cleanup.modeSetCount > 0) {
    figma.commitUndo();
  }

  const rebindSuffix = rebindLegacyVariables && totalRebound + totalRebindSkipped + totalRebindFailed > 0
    ? ` Rebound ${totalRebound} legacy color binding${totalRebound === 1 ? '' : 's'}${totalRebindSkipped > 0 ? `, ${totalRebindSkipped} unmatched` : ''}${totalRebindFailed > 0 ? `, ${totalRebindFailed} failed` : ''}.`
    : '';
  const cleanupSuffix = cleanup.nodeFixedCount > 0
    ? ` Cleaned up ${cleanup.reboundCount} support binding${cleanup.reboundCount === 1 ? '' : 's'} on ${cleanup.nodeFixedCount} layer${cleanup.nodeFixedCount === 1 ? '' : 's'}.`
    : '';

  return {
    createdAt: new Date().toISOString(),
    operation,
    status: failedCount + cleanup.failedCount > 0 ? 'error' : 'success',
    message: `Updated ${fixedCount} instance${fixedCount === 1 ? '' : 's'}${failedCount > 0 ? `, failed ${failedCount}` : ''}.${rebindSuffix}${cleanupSuffix}`,
    details: {
      fixedCount,
      failedCount,
      reboundCount: totalRebound,
      rebindSkippedCount: totalRebindSkipped,
      rebindFailedCount: totalRebindFailed,
      supportLayerFixedCount: cleanup.nodeFixedCount,
      supportBindingReboundCount: cleanup.reboundCount,
      supportLayerFailedCount: cleanup.failedCount,
      failures: failures as unknown as JsonValue,
    },
  };
}


// Top-level scene nodes to walk for a loose-binding sweep. Unlike the instance
// scans, this returns page-level roots so we can recurse over plain layers.
async function getRebindScopeRoots(scope: FixScope): Promise<SceneNode[]> {
  if (scope === 'selection') {
    return figma.currentPage.selection.slice();
  }
  if (scope === 'page') {
    await figma.currentPage.loadAsync();
    return [...figma.currentPage.children];
  }
  await figma.loadAllPagesAsync();
  const roots: SceneNode[] = [];
  for (const page of figma.root.children) {
    for (const child of page.children) {
      roots.push(child);
    }
  }
  return roots;
}

// Collect (without mutating) every Support color binding on a node's own
// fills/strokes. Does not recurse — the caller walks the tree. Only the
// Support color collection is being removed in the migration; neutral and
// main bindings still resolve (main is renamed in place, neutral stays), so
// they are intentionally left alone.
async function inspectNodeLegacyBindings(
  node: SceneNode,
  newColorVariableMap: Map<string, Variable>,
  variableCache: Map<string, Variable | null>,
  collectionCache: Map<string, VariableCollection | null>,
): Promise<LegacyPaintTarget[]> {
  const bindings: LegacyPaintTarget[] = [];
  for (const propertyName of ['fills', 'strokes'] as const) {
    const paintNode = node as SceneNode & Partial<MinimalFillsMixin & MinimalStrokesMixin>;
    const paints = paintNode[propertyName];
    if (!(propertyName in paintNode) || !Array.isArray(paints)) {
      continue;
    }
    for (const paint of paints) {
      const target = await resolveLegacyColorPaintTarget(paint, newColorVariableMap, variableCache, collectionCache);
      if (target && target.category === 'support') {
        bindings.push(target);
      }
    }
  }
  return bindings;
}

// Rebind only this node's own Support color fills/strokes (no recursion). Used
// by the loose-node apply, where the plan already lists each node individually.
async function rebindLegacyColorPaintsOnNodeOnly(
  node: SceneNode,
  newColorVariableMap: Map<string, Variable>,
  variableCache: Map<string, Variable | null>,
  collectionCache: Map<string, VariableCollection | null>,
): Promise<RebindStats> {
  const stats: RebindStats = { rebound: 0, skipped: 0, failed: 0 };
  for (const propertyName of ['fills', 'strokes'] as const) {
    const paintNode = node as SceneNode & Partial<MinimalFillsMixin & MinimalStrokesMixin>;
    const paints = paintNode[propertyName];
    if (!(propertyName in paintNode) || !Array.isArray(paints)) {
      continue;
    }
    const next: Paint[] = paints.slice();
    let mutated = false;
    for (let i = 0; i < next.length; i += 1) {
      const target = await resolveLegacyColorPaintTarget(next[i], newColorVariableMap, variableCache, collectionCache);
      if (!target || target.category !== 'support') {
        continue;
      }
      if (!target.newVariable) {
        stats.skipped += 1;
        continue;
      }
      try {
        next[i] = figma.variables.setBoundVariableForPaint(next[i] as SolidPaint, 'color', target.newVariable);
        mutated = true;
        stats.rebound += 1;
      } catch {
        stats.failed += 1;
      }
    }
    if (mutated) {
      try {
        await setPaintsOnNode(node, propertyName, next);
      } catch {
        // Figma may reject the write on some nodes; count those we attempted.
        stats.failed += 1;
      }
    }
  }
  return stats;
}

type VariableModeNode = SceneNode & {
  setExplicitVariableModeForCollection: (collection: VariableCollection, modeId: string) => void;
  clearExplicitVariableModeForCollection: (collection: VariableCollection) => void;
};

type LegacyColorRebindScan = {
  plans: LegacyColorRebindPlan[];
  scannedNodeCount: number;
  readyCount: number;
  reviewCount: number;
  supportFallbackCount: number;
  reboundBindingCount: number;
};

// Walk a scope for loose Support color bindings on non-instance layers and
// build the rebind plans. Stores them in pendingLegacyColorRebindPlans so a
// later apply can act on them. Folded into the instance scan flows so support
// cleanup is part of the same feature rather than a separate panel.
async function collectLegacyColorRebindPlans(
  scope: FixScope,
  colorCollection: VariableCollection,
): Promise<LegacyColorRebindScan> {
  pendingLegacyColorRebindPlans = [];
  // buildNewColorVariableMap walks the collection's variableIds, so it works
  // for a remote (library) Color collection in sketch files too.
  const newColorVariableMap = await buildNewColorVariableMap(colorCollection.id);
  const roots = await getRebindScopeRoots(scope);
  const variableCache = new Map<string, Variable | null>();
  const collectionCache = new Map<string, VariableCollection | null>();
  const plans: LegacyColorRebindPlan[] = [];
  let scannedNodeCount = 0;

  const visit = async (node: SceneNode): Promise<void> => {
    // Skip instances entirely: their internal bindings are overrides handled
    // by the instance flows, and walking into them file-wide would force Figma
    // to materialize every instance subtree (the perf trap elsewhere avoided).
    if (node.type === 'INSTANCE') {
      return;
    }

    scannedNodeCount += 1;
    // inspectNodeLegacyBindings only returns Support color bindings.
    const bindings = await inspectNodeLegacyBindings(node, newColorVariableMap, variableCache, collectionCache);
    if (bindings.length > 0) {
      const matched = bindings.filter((binding) => binding.newVariable);
      const unmatchedNames = bindings.filter((binding) => !binding.newVariable).map((binding) => binding.oldVariableName);

      const legacy = await findLegacyColorModeOverride(node);
      let targetModeId: string | null = null;
      let targetModeName: string | null = null;
      if (legacy) {
        const mode = colorCollection.modes.find((m) => normalizeToken(m.name) === normalizeToken(legacy.modeName));
        if (mode) {
          targetModeId = mode.modeId;
          targetModeName = mode.name;
        }
      }

      let status: 'ready' | 'review' = 'ready';
      let reason: string | undefined;
      let needsSupportModeChoice = false;
      if (matched.length === 0) {
        status = 'review';
        reason = 'No matching variables found in the new Color collection.';
      } else if (!legacy) {
        // Support color resolved through a mode in the old Support color
        // collection. With no explicit mode to preserve, we can't infer the
        // brand — surface it so the user picks a fallback mode in the UI.
        status = 'review';
        needsSupportModeChoice = true;
        reason = 'Support color binding without an explicit mode — pick a fallback color below to clean it up.';
      }

      plans.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        pageName: getPageName(node),
        bindingCount: bindings.length,
        matchedCount: matched.length,
        unmatchedNames: unmatchedNames.slice(0, 5),
        legacyModeCollectionId: legacy ? legacy.collectionId : null,
        legacyModeCollectionName: legacy ? legacy.collectionName : null,
        legacyModeName: legacy ? legacy.modeName : null,
        targetColorCollectionId: colorCollection.id,
        targetModeId,
        targetModeName,
        needsSupportModeChoice,
        status,
        reason,
      });
    }

    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        await visit(child);
      }
    }
  };

  for (const root of roots) {
    await visit(root);
  }

  pendingLegacyColorRebindPlans = plans;

  return {
    plans,
    scannedNodeCount,
    readyCount: plans.filter((plan) => plan.status === 'ready').length,
    reviewCount: plans.filter((plan) => plan.status === 'review').length,
    supportFallbackCount: plans.filter((plan) => plan.needsSupportModeChoice).length,
    reboundBindingCount: plans
      .filter((plan) => plan.status === 'ready')
      .reduce((sum, plan) => sum + plan.matchedCount, 0),
  };
}

type LegacyColorRebindResult = {
  reboundCount: number;
  skippedCount: number;
  failedPaintCount: number;
  modeSetCount: number;
  nodeFixedCount: number;
  failedCount: number;
};

// Apply the pending loose-layer support cleanup using a shared support fallback
// mode. Self-contained: derives the target Color collection from the plans, so
// it works for both local (library file) and remote (sketch file) collections.
// Returns counts so the caller can fold them into its own result.
async function applyLegacyColorRebindPlans(
  supportFallbackModeId: string | null,
): Promise<LegacyColorRebindResult> {
  const empty: LegacyColorRebindResult = {
    reboundCount: 0, skippedCount: 0, failedPaintCount: 0, modeSetCount: 0, nodeFixedCount: 0, failedCount: 0,
  };

  // Ready plans clean up on their own. Support-without-mode plans become
  // cleanable once the user picks a fallback mode (applied to all of them).
  const plans = pendingLegacyColorRebindPlans.filter(
    (plan) => plan.status === 'ready' || (plan.needsSupportModeChoice && supportFallbackModeId),
  );
  pendingLegacyColorRebindPlans = [];
  const collectionId = plans[0] ? plans[0].targetColorCollectionId : null;
  if (plans.length === 0 || !collectionId) {
    return empty;
  }

  const colorCollection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!colorCollection) {
    return empty;
  }

  const newColorVariableMap = await buildNewColorVariableMap(collectionId);
  const variableCache = new Map<string, Variable | null>();
  const collectionCache = new Map<string, VariableCollection | null>();

  let reboundCount = 0;
  let skippedCount = 0;
  let failedPaintCount = 0;
  let modeSetCount = 0;
  let nodeFixedCount = 0;
  let failedCount = 0;

  for (const plan of plans) {
    try {
      const node = await figma.getNodeByIdAsync(plan.nodeId);
      if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT') {
        throw new Error('Layer no longer exists.');
      }
      const sceneNode = node as SceneNode;

      const stats = await rebindLegacyColorPaintsOnNodeOnly(sceneNode, newColorVariableMap, variableCache, collectionCache);
      reboundCount += stats.rebound;
      skippedCount += stats.skipped;
      failedPaintCount += stats.failed;

      // Ready plans preserve their own legacy mode; support-without-mode plans
      // take the user-picked fallback.
      const effectiveModeId = plan.needsSupportModeChoice ? supportFallbackModeId : plan.targetModeId;
      if (effectiveModeId && 'setExplicitVariableModeForCollection' in sceneNode) {
        try {
          (sceneNode as VariableModeNode).setExplicitVariableModeForCollection(colorCollection, effectiveModeId);
          modeSetCount += 1;
        } catch {
          // best-effort — leave the mode unset if Figma rejects it
        }
      }

      if (plan.legacyModeCollectionId && 'clearExplicitVariableModeForCollection' in sceneNode) {
        try {
          const legacyCollection = await figma.variables.getVariableCollectionByIdAsync(plan.legacyModeCollectionId);
          if (legacyCollection) {
            (sceneNode as VariableModeNode).clearExplicitVariableModeForCollection(legacyCollection);
          }
        } catch {
          // best-effort
        }
      }

      if (stats.rebound > 0) {
        nodeFixedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  return { reboundCount, skippedCount, failedPaintCount, modeSetCount, nodeFixedCount, failedCount };
}

export const colorMigration: MigrationModule = {
  id: 'color',
  title: 'Color migration',
  description: 'Migrate color variants and modes, and clean up Support color variables.',
  operations: {
    'check-prime-status': () => checkPrimeStatus(),
    'prime-variables': () => primeVariables(),
    'scan-unsupported-variants': () => scanUnsupportedVariants(),
    'apply-unsupported-variants': () => applyUnsupportedVariantPlans(),
    'load-color-modes': () => loadColorModes(),
    'scan-missing-instances': (args) => {
      const a = (args || {}) as { scope: FixScope; supportModeId: string | null };
      return scanMissingInstances(a.scope, a.supportModeId);
    },
    'apply-missing-instances': (args) => {
      const a = (args || {}) as { supportModeId: string | null };
      return applyMissingInstancePlans(a.supportModeId);
    },
    'scan-library-stuck-instances': (args) => {
      const a = (args || {}) as { scope: FixScope };
      return scanLibraryStuckInstances(a.scope);
    },
    'apply-library-stuck-instances': (args) => {
      const a = (args || {}) as { supportFallbackModeId: string | null; rebindLegacyVariables: boolean };
      return applyLibraryStuckInstancePlans(a.supportFallbackModeId, a.rebindLegacyVariables);
    },
  },
};
