// UI entry point. Wires the shared bridge + shell and registers the migration
// controllers; the shell renders the picker and routes to the chosen migration.
import { initBridge } from './core/bridge';
import { initShell } from './core/shell';
import { createColorController } from './migrations/color/controller';

initBridge();
initShell([createColorController()]);
