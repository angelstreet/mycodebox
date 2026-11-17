// Which names this dashboard answers to (the request's Host header).
//
// The dashboard has no login: a browser request counts as the owner's when its Origin matches its Host. That only
// means something when Host is a name of this box, so a request under any other name is refused before routing.
// Answered: an IP address, `localhost`, a single-label name (the box's short or MagicDNS name), a `*.ts.net` name,
// this machine's hostname, the host of PUBLIC_URL, and the names listed in GHOSTY_ALLOWED_HOSTS (comma separated).
// A request that carries an Authorization header is a token client (lease, integrate): its token decides, not its
// Host, so it is not checked here.
import os from 'node:os';
import net from 'node:net';

// "name:port", "[v6]:port", "name" -> lowercase name without port; '' when there is none.
export function hostNameOf(header) {
  const raw = String(header || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  const colon = raw.lastIndexOf(':');
  const name = colon > -1 && raw.indexOf(':') === colon ? raw.slice(0, colon) : raw;
  return name.replace(/\.$/, '');
}

const urlHost = (value) => { try { return new URL(String(value)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; } };

export function createHostAllow({ env = process.env, hostname = os.hostname() } = {}) {
  const named = new Set();
  const add = (n) => { const v = hostNameOf(n); if (v) named.add(v); };
  add(hostname);
  add(urlHost(env.PUBLIC_URL));
  for (const n of String(env.GHOSTY_ALLOWED_HOSTS || '').split(',')) add(n);
  const allowed = (header) => {
    const name = hostNameOf(header);
    if (!name) return true;                       // no Host header: not a browser
    if (net.isIP(name)) return true;
    if (name === 'localhost' || !name.includes('.')) return true;
    if (name.endsWith('.ts.net')) return true;
    return named.has(name);
  };
  // A request the dashboard should not route: a browser-style request (no Authorization) under an unknown name.
  const refuses = (req) => !req?.headers?.authorization && !allowed(req?.headers?.host);
  return { allowed, refuses, names: () => [...named] };
}
