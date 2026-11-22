import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridge = readFileSync(join(root, 'src/composio_bridge.py'), 'utf8');

// Buzz allows at most 16 arguments of 1024 bytes each per host command, so
// the bridge source travels as whole-line chunks after a one-line loader
// that joins and runs them. It stays readable in the install review.
const LOADER = 'import sys; exec(compile("".join(sys.argv[1:]), "composio_bridge.py", "exec"))';
const MAX_ARG = 1024;
const chunks = [''];
for (const line of bridge.split(/(?<=\n)/)) {
  if (Buffer.byteLength(line) > MAX_ARG) throw new Error(`A bridge line is over ${MAX_ARG} bytes`);
  if (Buffer.byteLength(chunks.at(-1) + line) > MAX_ARG) chunks.push('');
  chunks[chunks.length - 1] += line;
}
const bridgeArgs = ['-c', LOADER, ...chunks];
if (bridgeArgs.length > 16) throw new Error('The bridge needs more than 16 arguments');
const manifest = {
  id: 'carlomanuali.grok',
  name: 'Grok',
  apiVersion: 1,
  description: 'Run Grok in Buzz through the local Grok CLI, with Buzz and optional Composio tools.',
  discovery: { category: 'agents', tags: ['Grok', 'xAI', 'ACP'] },
  host: {
    mcp: true,
    commands: [{
      id: 'composio-bridge',
      program: 'python3',
      args: bridgeArgs,
      maxInputBytes: 65536,
      maxOutputBytes: 1048576,
    }],
    processes: [{
      id: 'grok',
      program: 'grok',
      args: ['--sandbox', 'strict', '--no-memory', 'agent', '--no-leader', 'stdio'],
    }],
  },
};
writeFileSync(join(root, 'plugin/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
