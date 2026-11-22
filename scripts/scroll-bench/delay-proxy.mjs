// A TCP proxy that adds DELAY_MS to every chunk in each direction: a stand-in for the phone -> Tailscale -> codebox path in the scroll
// bench (bench.py). Round trip added = 2 x DELAY_MS. Usage: node delay-proxy.mjs <listen port> <target port> <delay ms>
import net from 'node:net';
const [listen, target, delay] = process.argv.slice(2).map(Number);
net.createServer((a) => {
  const b = net.connect(target, '127.0.0.1');
  const pipe = (from, to) => { from.on('data', (d) => setTimeout(() => { if (!to.destroyed) to.write(d); }, delay)); from.on('close', () => setTimeout(() => to.destroy(), delay)); from.on('error', () => to.destroy()); };
  pipe(a, b); pipe(b, a);
}).listen(listen, '127.0.0.1', () => console.log(`delay-proxy ${listen} -> ${target} +${delay} ms each way`));
