// Pre-accept the "do you trust this folder?" prompt of a coding agent, so a session started from the UI goes straight to work.
//   claude  ~/.claude.json  projects[dir].hasTrustDialogAccepted = true  (merged into the freshest copy, written atomically)
//   codex   ~/.codex/config.toml  [projects."dir"] trust_level = "trusted"
// minimax / bash have no such prompt we know of. Best effort: callers ignore failures.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CLAUDE_FILE = () => process.env.CLAUDE_JSON_FILE || join(homedir(), '.claude.json');
const CODEX_FILE = () => process.env.CODEX_CONFIG_FILE || join(homedir(), '.codex', 'config.toml');

export async function trustClaude(dir, file = CLAUDE_FILE()) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return false; }   // Claude never ran here: nothing to edit
  const cfg = JSON.parse(raw);
  cfg.projects ||= {};
  const cur = cfg.projects[dir];
  if (cur?.hasTrustDialogAccepted === true) return false;
  cfg.projects[dir] = {
    allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
    ...(cur || {}), hasTrustDialogAccepted: true,
  };
  const st = await fs.stat(file);
  const tmp = `${file}.ghosty-${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: st.mode & 0o777 });
  await fs.rename(tmp, file);
  return true;
}

export async function trustCodex(dir, file = CODEX_FILE()) {
  let txt = '';
  try { txt = await fs.readFile(file, 'utf8'); } catch { await fs.mkdir(dirname(file), { recursive: true }); }
  const header = `[projects."${dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  if (txt.includes(header)) return false;
  await fs.writeFile(file, `${txt}${txt && !txt.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`);
  return true;
}

export async function trustFolder(agent, dir) {
  if (agent === 'claude') return trustClaude(dir);
  if (agent === 'codex') return trustCodex(dir);
  return false;
}
