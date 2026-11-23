// A tool call line in the reader text, one per line between backticks (owner 2026-11-22: consecutive ones are one collapsed group).
// Two writers: the session file (conversation.js: `Bash cd …`) and the pane fallback when no session file is found (server.js
// transcriptOf: `Bash(cd …`, cut at 100 chars so the ")" is often missing). Both are tool lines (owner 2026-11-23).
export const TOOL_LINE = /^`([A-Z][A-Za-z]+|mcp__[\w-]+)(?:[ (][^`]*)?`$/;
export const toolName = (line) => TOOL_LINE.exec(String(line).trim())?.[1] || '';
