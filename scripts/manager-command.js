// Default skips permission prompts (owner decision 2026-10-11); AGENT_CMD_CLAUDE wins verbatim.
// Print only to the calling script; diagnostics never contain command contents.
import { managerCommand, launchWarnings } from '../launch-config.js';
for (const warning of launchWarnings()) console.error(`[launch] ${warning}`);
process.stdout.write(managerCommand());
