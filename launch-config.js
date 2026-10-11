// Pure launch configuration: safe to inspect without starting the server.
export function launchConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    commands: {
      claude: env.AGENT_CMD_CLAUDE ?? 'claude',
      codex: env.AGENT_CMD_CODEX ?? 'codex',
      minimax: env.AGENT_CMD_MINIMAX ?? 'PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH mcode',
      bash: env.AGENT_CMD_BASH ?? '',
    },
  };
}

// Known switches that turn off a CLI's permission prompts or sandbox (Claude, Codex, mcode).
const BYPASS_RES = [
  /--(?:dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|yolo|full-auto)\b/,
  /--permission-mode(?:=|\s+)['"]?bypassPermissions\b/,
  /--permission(?:=|\s+)['"]?off\b/,                                        // mcode
  /--sandbox(?:=|\s+)['"]?danger-full-access\b/,
  /(?:--ask-for-approval|-a)(?:=|\s+)['"]?never\b/,
  /(?:^|\s)(?:-c|--config)(?:=|\s+)['"]?approval_policy\s*=\s*\\?['"]?never\b/,   // -c approval_policy=never / ="never"
  /(?:^|\s)(?:-c|--config)(?:=|\s+)['"]?sandbox_mode\s*=\s*\\?['"]?danger-full-access\b/,
];

// Advisory only: shell wrappers and external CLI config cannot be certified here.
export function launchWarnings(env = process.env) {
  const warnings = [];
  if (env.HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.HOST)) {
    warnings.push('HOST overrides loopback; verify private Tailscale binding and access policy.');
  }
  for (const key of ['AGENT_CMD_CLAUDE', 'AGENT_CMD_CODEX', 'AGENT_CMD_MINIMAX', 'AGENT_CMD_BASH']) {
    if (BYPASS_RES.some((re) => re.test(env[key] || ''))) {
      warnings.push(`${key} contains a known permission or sandbox bypass; review this explicit override.`);
    }
  }
  return warnings;
}

export function managerCommand(env = process.env) {
  return `${launchConfig(env).commands.claude} --model opus --remote-control manager -n manager`;
}
