type Operation =
  | 'prime-variables'
  | 'scan-unsupported-variants'
  | 'apply-unsupported-variants'
  | 'load-color-modes'
  | 'scan-missing-instances'
  | 'apply-missing-instances';

type FixScope = 'selection' | 'page' | 'file';

type PluginMessage =
  | { type: 'prime-variables' }
  | { type: 'scan-unsupported-variants' }
  | { type: 'apply-unsupported-variants' }
  | { type: 'load-color-modes' }
  | { type: 'scan-missing-instances'; scope: FixScope; supportModeId: string | null }
  | { type: 'apply-missing-instances' };

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

figma.showUI(__html__, { width: 480, height: 460, themeColors: true });

function nowMs() {
  return Date.now();
}

function durationMs(startMs: number) {
  return Date.now() - startMs;
}

function logTiming(label: string, startMs: number, details?: Record<string, unknown>) {
  // Keep timing instrumentation available while avoiding noisy plugin-console logs.
  // const suffix = details ? ` ${JSON.stringify(details)}` : '';
  // console.log(`[Color migration] ${label}: ${durationMs(startMs)}ms${suffix}`);
  void label;
  void startMs;
  void details;
}

function postToUi(message: UiMessage) {
  figma.ui.postMessage(message);
}

function postOperationProgress(payload: OperationProgressPayload) {
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
  // Most scans stop at instances for performance. The special paint migration
  // has its own traversal because it intentionally edits nested instance layers.
  return node.type !== 'INSTANCE' && isChildrenMixin(node);
}

function parseRemovedComponentName(componentName: string): {
  componentSetName: string;
  removedColor: string | null;
  nonColorTokens: string[];
} {
  const parts = componentName.split('/').map((part) => part.trim()).filter(Boolean);
  const [componentSetName = componentName, ...variantTokens] = parts;
  const removedColor = variantTokens.find((token) => isUnsupportedColor(normalizeToken(token))) || null;

  return {
    componentSetName,
    removedColor,
    nonColorTokens: variantTokens.filter((token) => normalizeToken(token) !== normalizeToken(removedColor || '')),
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

function collectSceneNodes(root: PageNode | SceneNode): SceneNode[] {
  const nodes: SceneNode[] = [];
  const visit = (node: PageNode | SceneNode) => {
    if (node.type !== 'PAGE') {
      nodes.push(node);
    }

    if (shouldTraverseChildren(node)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  visit(root);
  return nodes;
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

async function primeVariables(): Promise<OperationResultPayload> {
  const operation = 'prime-variables';
  const sourceCollectionName = 'Main color';
  const targetCollectionName = 'Color';
  const variablePrefix = 'color/main/';

  postOperationProgress({
    operation,
    message: 'Reading local variable collections...',
  });

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const mainColorCollections = collections.filter((collection) => collection.name === sourceCollectionName);
  const colorCollections = collections.filter((collection) => collection.name === targetCollectionName);

  if (mainColorCollections.length > 1) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'error',
      message: `Found ${mainColorCollections.length} "${sourceCollectionName}" collections. Rename manually before priming.`,
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
      message: `Both "${sourceCollectionName}" and "${targetCollectionName}" exist. Skipping to avoid changing the wrong collection.`,
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
      message: `No "${sourceCollectionName}" or "${targetCollectionName}" collection found.`,
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
        reason: 'Variable not found',
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
        message: 'Renaming variables...',
        processed: index + 1,
        total,
      });
    }
  }

  const changed = renamedCollection !== null || renamedVariables.length > 0;
  return {
    createdAt: new Date().toISOString(),
    operation,
    status: changed ? 'success' : 'noop',
    message: changed
      ? `Primed variables: renamed ${renamedVariables.length} variable${renamedVariables.length === 1 ? '' : 's'}.`
      : `Already primed. No "${variablePrefix}" variable names found in "${targetCollection.name}".`,
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
  await figma.loadAllPagesAsync();
  const allSets: ComponentSetNode[] = [];
  const allFoundIds = new Set<string>();

  for (const page of figma.root.children) {
    for (const componentSet of collectComponentSets(page, wantedNames)) {
      if (!allFoundIds.has(componentSet.id)) {
        allSets.push(componentSet);
        allFoundIds.add(componentSet.id);
      }
    }
  }

  return {
    componentSets: allSets,
    searchedWholeFile: true,
  };
}

async function getNodesForScope(scope: FixScope): Promise<SceneNode[]> {
  if (scope === 'selection') {
    const nodes: SceneNode[] = [];
    const visit = (node: SceneNode) => {
      nodes.push(node);

      if (shouldTraverseChildren(node)) {
        for (const child of node.children) {
          visit(child);
        }
      }
    };

    for (const node of figma.currentPage.selection) {
      visit(node);
    }

    return nodes;
  }

  if (scope === 'page') {
    await figma.currentPage.loadAsync();
    return collectSceneNodes(figma.currentPage);
  }

  await figma.loadAllPagesAsync();
  return figma.root.children.flatMap((page) => collectSceneNodes(page));
}

async function loadColorModes(): Promise<OperationResultPayload> {
  const operation = 'load-color-modes';
  const collection = await getColorCollection();

  if (!collection) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'error',
      message: 'No Color or Main color collection found.',
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
    message: 'Loading pages...',
  });

  const componentSets = await getAllComponentSets();

  postOperationProgress({
    operation,
    message: 'Scanning component sets...',
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
        message: 'Scanning component sets...',
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
      message: 'No unsupported color variants found.',
      details: {
        scannedComponentSetCount: componentSets.length,
        skippedComponentSets,
        alertMigrationCount: colorModeMigrationCount,
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
      alertMigrationCount: colorModeMigrationCount,
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
      message: 'No pending unsupported variant scan. Run scan first.',
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
    message: 'Applying unsupported variant cleanup...',
    processed,
    total: totalSteps,
  });

  for (const plan of plans) {
    for (const variant of plan.variantsToRename) {
      try {
        const node = await figma.getNodeByIdAsync(variant.id);
        if (node?.type !== 'COMPONENT') {
          failed.push({
            id: variant.id,
            name: variant.from,
            action: 'rename',
            reason: 'Component no longer exists.',
          });
        } else {
          node.name = variant.to;
          renamed.push({
            id: variant.id,
            from: variant.from,
            to: variant.to,
            componentSetName: plan.componentSetName,
          });
        }
      } catch (error) {
        failed.push({
          id: variant.id,
          name: variant.from,
          action: 'rename',
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      processed += 1;
      postOperationProgress({
        operation,
        message: 'Applying unsupported variant cleanup...',
        processed,
        total: totalSteps,
      });
    }

    for (const variant of plan.variantsToRemove) {
      try {
        const node = await figma.getNodeByIdAsync(variant.id);
        if (node?.type !== 'COMPONENT') {
          failed.push({
            id: variant.id,
            name: variant.name,
            color: variant.color,
            action: 'remove',
            reason: 'Component no longer exists.',
          });
        } else {
          node.remove();
          removed.push({
            id: variant.id,
            name: variant.name,
            color: variant.color,
            componentSetName: plan.componentSetName,
          });
        }
      } catch (error) {
        failed.push({
          id: variant.id,
          name: variant.name,
          color: variant.color,
          action: 'remove',
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      processed += 1;
      postOperationProgress({
        operation,
        message: 'Applying unsupported variant cleanup...',
        processed,
        total: totalSteps,
      });
    }
  }

  const colorModeMigration = await applyColorModeMigration();
  pendingUnsupportedVariantPlans = [];
  pendingColorModeMigrationComponentSetIds = [];

  const status = failed.length > 0 ? 'error' : 'success';
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
      alertMigration: colorModeMigration,
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
      } catch {
        // Figma may reject writes on some nested instance layers. Keep the rest
        // of the migration moving and expose the count in the result payload.
        failedPaintWriteCount += changedPaintCount;
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
      skipped: [{ reason: 'No Color or Main color collection found.' }],
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
      reason: `component set "${componentSetName}" could not be found`,
      candidateCount: 0,
      candidateNames: [],
      targetPropertyValues: null,
    };
  }

  const targetPropertyValues = buildTargetPropertyValues(componentSet, tokens);
  if (!targetPropertyValues && componentSet.children.length !== 1) {
    return {
      component: null,
      reason: `could not map tokens "${tokens.join(', ')}" to current variant properties`,
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
        ? `no target variants matched ${formatTargetValues(targetPropertyValues)}`
        : `${candidates.length} target variants matched ${formatTargetValues(targetPropertyValues)}`,
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
    reasons.push('old color could not be parsed from source component name');
  }

  if (!targetMode) {
    reasons.push('target mode could not be resolved');
  }

  if (!targetComponentResult?.component) {
    reasons.push(targetComponentResult?.reason || 'target variant could not be matched');
  }

  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

async function scanMissingInstances(scope: FixScope, supportModeId: string | null): Promise<OperationResultPayload> {
  const operation = 'scan-missing-instances';
  const scanStartMs = nowMs();
  let getColorCollectionMs = 0;
  let getScopeNodesMs = 0;
  let filterInstancesMs = 0;
  let getComponentSetsMs = 0;
  let getMainComponentMs = 0;
  let parseMs = 0;
  let findTargetModeMs = 0;
  let findTargetComponentMs = 0;
  let createPlanMs = 0;
  let searchedWholeFileForComponentSets = false;

  // console.log(`[Color migration] Scan missing instances started ${JSON.stringify({ scope, supportModeId })}`);
  pendingMissingInstancePlans = [];

  postOperationProgress({
    operation,
    message: 'Loading color modes...',
  });

  const colorCollectionStartMs = nowMs();
  const colorCollection = await getColorCollection();
  getColorCollectionMs += durationMs(colorCollectionStartMs);
  logTiming('Loaded color collection', colorCollectionStartMs, {
    found: Boolean(colorCollection),
    name: colorCollection?.name || null,
    modeCount: colorCollection?.modes.length || 0,
  });

  if (!colorCollection) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'error',
      message: 'No Color or Main color collection found.',
      details: {
        collectionNames: COLOR_COLLECTION_NAMES,
      },
    };
  }

  postOperationProgress({
    operation,
    message: 'Loading scope...',
  });

  const scopeNodesStartMs = nowMs();
  const nodes = await getNodesForScope(scope);
  getScopeNodesMs += durationMs(scopeNodesStartMs);
  logTiming('Loaded scope nodes', scopeNodesStartMs, {
    nodeCount: nodes.length,
  });

  const filterInstancesStartMs = nowMs();
  const instances = nodes.filter((node): node is InstanceNode => node.type === 'INSTANCE');
  filterInstancesMs += durationMs(filterInstancesStartMs);
  logTiming('Filtered instances', filterInstancesStartMs, {
    instanceCount: instances.length,
  });

  const plans: MissingInstancePlan[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    const mainComponentStartMs = nowMs();
    const mainComponent = await instance.getMainComponentAsync();
    getMainComponentMs += durationMs(mainComponentStartMs);
    // Removed local variants still resolve to a detached local component with
    // no parent. A hard missing component can also return null.
    const isMissing = !mainComponent || (mainComponent.remote === false && !mainComponent.parent);

    if (isMissing) {
      const parseStartMs = nowMs();
      const parsed = mainComponent ? parseRemovedComponentName(mainComponent.name) : null;
      const removedColor = parsed?.removedColor || null;
      parseMs += durationMs(parseStartMs);

      const targetModeStartMs = nowMs();
      const targetMode = removedColor ? findTargetMode(colorCollection, removedColor, supportModeId) : null;
      findTargetModeMs += durationMs(targetModeStartMs);

      const createPlanStartMs = nowMs();
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
      createPlanMs += durationMs(createPlanStartMs);
    }

    if ((index + 1) % 10 === 0 || index + 1 === instances.length) {
      postOperationProgress({
        operation,
        message: 'Scanning missing instances...',
        processed: index + 1,
        total: instances.length,
      });
    }

    if ((index + 1) % 100 === 0 || index + 1 === instances.length) {
      // console.log(`[Color migration] Scan missing instances progress ${JSON.stringify({
      //   processed: index + 1,
      //   total: instances.length,
      //   missingFound: plans.length,
      //   elapsedMs: durationMs(scanStartMs),
      //   getMainComponentMs,
      //   findTargetComponentMs,
      // })}`);
    }
  }

  pendingMissingInstancePlans = plans;

  if (plans.length > 0) {
    const wantedNames = getMissingComponentSetNames(plans);
    const componentSetsStartMs = nowMs();
    const componentSetLookup = await findComponentSetsByNames(wantedNames, scope);
    const componentSets = componentSetLookup.componentSets;
    searchedWholeFileForComponentSets = componentSetLookup.searchedWholeFile;
    getComponentSetsMs += durationMs(componentSetsStartMs);
    logTiming('Loaded target component sets', componentSetsStartMs, {
      wantedComponentSetCount: wantedNames.size,
      componentSetCount: componentSets.length,
      searchedWholeFile: searchedWholeFileForComponentSets,
    });

    for (const plan of plans) {
      const targetComponentStartMs = nowMs();
      const targetComponentResult =
        plan.componentSetName !== 'Unknown'
          ? findTargetComponent(componentSets, plan.componentSetName, plan.nonColorTokens)
          : null;
      findTargetComponentMs += durationMs(targetComponentStartMs);

      const targetComponent = targetComponentResult?.component || null;
      plan.targetComponentId = targetComponent?.id || null;
      plan.targetComponentName = targetComponent?.name || null;
      plan.targetPropertyValues = targetComponentResult?.targetPropertyValues || undefined;
      plan.targetCandidateCount = targetComponentResult?.candidateCount;
      plan.targetCandidateNames = targetComponentResult?.candidateNames;
      plan.status = plan.removedColor !== 'unknown' && plan.targetModeId && targetComponent ? 'ready' : 'blocked';
      plan.reason = getBlockedReason(
        plan.removedColor === 'unknown' ? null : plan.removedColor,
        plan.targetModeId && plan.targetModeName ? { modeId: plan.targetModeId, name: plan.targetModeName } : null,
        targetComponentResult,
      );
    }
  }

  const finalizeStartMs = nowMs();
  const readyCount = plans.filter((plan) => plan.status === 'ready').length;
  const blockedCount = plans.length - readyCount;
  const finalizeMs = durationMs(finalizeStartMs);

  const timing = {
    totalMs: durationMs(scanStartMs),
    getColorCollectionMs,
    getScopeNodesMs,
    filterInstancesMs,
    getComponentSetsMs,
    getMainComponentMs,
    parseMs,
    findTargetModeMs,
    findTargetComponentMs,
    createPlanMs,
    finalizeMs,
    searchedWholeFileForComponentSets,
  };

  // console.log(`[Color migration] Scan missing instances finished ${JSON.stringify({
  //   scope,
  //   nodeCount: nodes.length,
  //   instanceCount: instances.length,
  //   missingCount: plans.length,
  //   readyCount,
  //   blockedCount,
  //   timing,
  // })}`);

  if (plans.length === 0) {
    return {
      createdAt: new Date().toISOString(),
      operation,
      status: 'noop',
      message: 'No missing instances found.',
      details: {
        scope,
        scannedInstanceCount: instances.length,
        timing,
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
      timing,
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
      message: 'No Color or Main color collection found.',
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
      message: 'No ready missing instance fixes. Run scan first.',
      details: {},
    };
  }

  const fixed: JsonValue[] = [];
  const failed: JsonValue[] = [];
  let skippedModeCount = 0;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];

    try {
      const instance = await figma.getNodeByIdAsync(plan.instanceId);
      const targetComponent = plan.targetComponentId ? await figma.getNodeByIdAsync(plan.targetComponentId) : null;

      if (instance?.type !== 'INSTANCE') {
        throw new Error('Instance no longer exists.');
      }

      if (targetComponent?.type !== 'COMPONENT') {
        throw new Error('Target component no longer exists.');
      }

      const modeId = plan.targetModeId;
      if (!modeId) {
        throw new Error('Missing target mode.');
      }

      instance.swapComponent(targetComponent);
      const shouldSkipMode = shouldSkipModeForMissingInstance(plan);
      if (shouldSkipMode) {
        skippedModeCount += 1;
      } else {
        const setExplicitVariableModeForCollection = instance.setExplicitVariableModeForCollection.bind(instance);
        setExplicitVariableModeForCollection(colorCollection, modeId);
      }

      fixed.push({
        instanceId: plan.instanceId,
        instanceName: plan.instanceName,
        targetComponentName: plan.targetComponentName,
        targetModeName: shouldSkipMode ? null : plan.targetModeName,
        skippedMode: shouldSkipMode,
        skippedModeReason: shouldSkipMode ? 'Skipped neutral mode inside TableColumn.' : null,
      });
    } catch (error) {
      failed.push({
        instanceId: plan.instanceId,
        instanceName: plan.instanceName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    postOperationProgress({
      operation,
      message: 'Fixing missing instances...',
      processed: index + 1,
      total: plans.length,
    });
  }

  pendingMissingInstancePlans = [];

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

async function runOperation(operation: Operation, callback: () => Promise<OperationResultPayload>) {
  postToUi({
    type: 'operation-result',
    payload: await callback().catch((error) => asErrorResult(operation, error)),
  });
}

figma.ui.onmessage = async (msg: PluginMessage) => {
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
  }
};
