#!/usr/bin/env node
// Manage the bearer tokens of the central lease service: node scripts/lease-token.js add|revoke|list [name] [--dir D] [--exempt a,b*]
// `add` prints the new token once and stores only its sha256 in <dir>/clients.json (mode 0600). Never logs a token elsewhere.
// --owner: the client may use the owner-only routes (/owner/*, /import, deploy approve); give it to the dashboard side only, never to agent machines.
// --exempt: agent names this client may claim as deploy agents (exact or a trailing * prefix), e.g. manager:deploy,update_core:*
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashToken, readClients } from '../lease-routes.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const dir = flag('--dir') || path.join(process.env.GHOSTY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'ghosty'), 'leases');
const exempt = (flag('--exempt') || '').split(',').map((x) => x.trim()).filter(Boolean);
const owner = args.includes('--owner');
if (owner) args.splice(args.indexOf('--owner'), 1);
const [cmd, name] = args;
const file = path.join(dir, 'clients.json');
const save = (clients) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const bad = (m) => { console.error(m); process.exit(1); };
if (!['add', 'revoke', 'list'].includes(cmd)) bad('usage: lease-token.js add|revoke|list [name] [--dir D] [--exempt agent,prefix*]');
const clients = readClients(file);
if (cmd === 'list') {
  for (const c of clients) console.log(`${c.name}\t${c.created || '-'}\t${c.owner ? 'owner ' : ''}${c.exemptAgents.length ? `exempt: ${c.exemptAgents.join(',')}` : ''}`);
} else {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) bad('a client name is required (letters, digits, . _ -)');
  if (cmd === 'add') {
    if (clients.some((c) => c.name === name)) bad(`client ${name} exists: revoke it first to issue a new token`);
    const token = randomBytes(32).toString('base64url');
    save([...clients, { name, sha256: hashToken(token), created: new Date().toISOString(), exemptAgents: exempt, ...(owner ? { owner: true } : {}) }]);
    console.log(token);
    console.error(`token for ${name} printed once above; only its hash is stored`);
  } else {
    if (!clients.some((c) => c.name === name)) bad(`no client ${name}`);
    save(clients.filter((c) => c.name !== name));
    console.log(`revoked ${name}`);
  }
}
