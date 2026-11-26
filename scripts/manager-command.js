// Default skips permission prompts (owner decision 2026-10-11); AGENT_CMD_CLAUDE wins verbatim.
// Print only to the calling script; diagnostics never contain command contents.
// The command runs on the active Claude account (claude-accounts.js); an AGENT_CMD_CLAUDE that picks its own config dir wins.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { managerCommand, launchWarnings } from '../launch-config.js';
import { activeAccount, launchPrefix } from '../claude-accounts.js';
for (const warning of launchWarnings()) console.error(`[launch] ${warning}`);
const cmd = managerCommand();
const stateDir = process.env.GHOSTY_STATE_DIR || join(homedir(), '.local', 'state', 'ghosty');
process.stdout.write(`${/\bCLAUDE_CONFIG_DIR=/.test(cmd) ? '' : launchPrefix(activeAccount(stateDir))}${cmd}`);
