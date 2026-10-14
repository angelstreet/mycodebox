// Pure launch configuration: safe to inspect without starting the server.
export function launchConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    commands: {
      claude: env.AGENT_CMD_CLAUDE ?? 'claude --dangerously-skip-permissions',
      codex: env.AGENT_CMD_CODEX ?? 'codex --dangerously-bypass-approvals-and-sandbox',
      minimax: env.AGENT_CMD_MINIMAX ?? 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode',
      bash: env.AGENT_CMD_BASH ?? '',
    },
  };
}

// Owner decision (2026-10-11): dashboard sessions, resumes and the manager start with permission prompts skipped.
// minimax: the mcode TUI has no CLI flag; its full-permission mode is `permissionMode: bypassPermissions` in ~/.minimax/config.yaml (see INSTALL).
// Known switches that turn off a CLI's permission prompts or sandbox (Claude, Codex, mcode).
const BYPASS_RES = [
  /--(?:allow-)?dangerously-[\w-]+|--(?:yolo|full-auto)\b|--bypass-[\w-]+/,
  /--permission-mode(?:=|\s+)['"]?bypassPermissions\b/,
  /--permission(?:=|\s+)['"]?(?:off|full)\b/,                               // mcode
  /(?:--sandbox|(?:^|\s)-s)(?:=|\s+)?['"]?danger-full-access\b/,
  /(?:--ask-for-approval|-a)(?:=|\s+)['"]?never\b/,
  /(?:^|\s)(?:-c|--config)(?:=|\s+)['"]?approval_policy\s*=\s*\\?['"]?never\b/,   // -c approval_policy=never / ="never"
  /(?:^|\s)(?:-c|--config)(?:=|\s+)['"]?sandbox_mode\s*=\s*\\?['"]?danger-full-access\b/,
  /--approval-mode(?:=|\s+)['"]?full-auto\b/,                                // older Codex CLIs
  /sandbox_permissions\s*=[^\n]*disk-full-(?:write|read-write)-access/,
  /--settings(?:=|\s+)[^\n]*(?:bypassPermissions|"defaultMode"\s*:\s*"bypass|skipDangerousModePermissionPrompt)/,  // inline JSON
];

// True when a command line (or joined argv) carries a known bypass switch. The V2 orchestration adapters use this as a hard guard.
export function hasBypass(cmd) {
  return BYPASS_RES.some((re) => re.test(String(cmd || '')));
}
export const bypassPatterns = () => [...BYPASS_RES];

// Advisory only: the bypass flags are the default now, so only a non-loopback HOST is worth a warning.
export function launchWarnings(env = process.env) {
  const warnings = [];
  if (env.HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.HOST)) {
    warnings.push('HOST overrides loopback; verify private Tailscale binding and access policy.');
  }
  return warnings;
}

export function managerCommand(env = process.env) {
  return `${launchConfig(env).commands.claude} --model opus --remote-control manager -n manager`;
}
