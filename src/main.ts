// Plugin entry point. Registers the available migration modules and boots the
// generic harness; everything migration-specific lives in its own module.
import { startPlugin } from './core/harness';
import { colorMigration } from './migrations/color';

startPlugin([colorMigration]);
