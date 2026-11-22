import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bridge = readFileSync(join(root, 'src/composio_bridge.py'), 'utf8');
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
      args: ['-c', bridge],
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
