// Shared, migration-agnostic types for the plugin harness.

export type FixScope = 'selection' | 'page' | 'file';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OperationProgressPayload = {
  domain?: string;
  operation: string;
  message: string;
  processed?: number;
  total?: number;
};

export type OperationResultPayload = {
  createdAt: string;
  // Set by the harness when posting; operations may omit it.
  domain?: string;
  operation: string;
  status: 'success' | 'noop' | 'error' | 'preview';
  message: string;
  details: JsonValue;
};

export type UiMessage =
  | { type: 'operation-progress'; payload: OperationProgressPayload }
  | { type: 'operation-result'; payload: OperationResultPayload };

// Messages the UI sends to the plugin. `run` is the generic envelope that the
// router dispatches to a migration module; `focus-node` is a shared utility.
export type PluginRequest =
  | { type: 'run'; domain: string; operation: string; args?: unknown }
  | { type: 'focus-node'; nodeId: string };

// A migration (color, typography, …) plugs into the harness by exposing
// metadata for the landing page and a map of named operations.
export type MigrationOperation = (args: unknown) => Promise<OperationResultPayload>;

export type MigrationModule = {
  id: string;
  title: string;
  description: string;
  operations: Record<string, MigrationOperation>;
};
