// Generic plugin shell: messaging, error wrapping, the migration registry, and
// the message router. Migration modules depend on this; it depends on none of
// them, so new migrations plug in without touching the harness.
import type {
  MigrationModule,
  OperationProgressPayload,
  OperationResultPayload,
  PluginRequest,
  UiMessage,
} from './types';

let registry: MigrationModule[] = [];

export function getMigrations(): MigrationModule[] {
  return registry;
}

export function postToUi(message: UiMessage) {
  figma.ui.postMessage(message);
}

// Skip per-batch progress posts for small workloads — the UI flash is more
// distracting than informative. Status messages without a total always post.
const PROGRESS_THRESHOLD = 200;

export function postOperationProgress(payload: OperationProgressPayload) {
  if (typeof payload.total === 'number' && payload.total < PROGRESS_THRESHOLD) {
    return;
  }
  postToUi({ type: 'operation-progress', payload });
}

export function asErrorResult(operation: string, error: unknown): OperationResultPayload {
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

async function runOperation(
  domain: string,
  operation: string,
  callback: () => Promise<OperationResultPayload>,
) {
  const payload = await callback().catch((error) => asErrorResult(operation, error));
  postToUi({ type: 'operation-result', payload: { ...payload, domain } });
}

async function focusNode(nodeId: string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
    return;
  }
  // Walk up to the owning page so we can switch to it before scrolling — the
  // node might live on another page.
  let cursor: BaseNode | null = node.parent;
  while (cursor && cursor.type !== 'PAGE') {
    cursor = cursor.parent;
  }
  if (cursor && cursor.type === 'PAGE' && cursor.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(cursor);
  }
  figma.currentPage.selection = [node as SceneNode];
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
}

// Boot the plugin: register migrations, show the UI, and route messages.
export function startPlugin(modules: MigrationModule[]) {
  registry = modules;
  figma.showUI(__html__, { width: 480, height: 460, themeColors: true });

  figma.ui.onmessage = async (msg: PluginRequest) => {
    if (msg.type === 'focus-node') {
      await focusNode(msg.nodeId);
      return;
    }
    if (msg.type === 'run') {
      const module = registry.find((m) => m.id === msg.domain);
      const operation = module && module.operations[msg.operation];
      if (!operation) {
        return;
      }
      await runOperation(msg.domain, msg.operation, () => operation(msg.args));
    }
  };
}
