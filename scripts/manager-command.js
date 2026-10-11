// Print only to the calling script; diagnostics never contain command contents.
import { managerCommand, launchWarnings } from '../launch-config.js';
for (const warning of launchWarnings()) console.error(`[launch] ${warning}`);
process.stdout.write(managerCommand());
