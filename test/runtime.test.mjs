// GrokRuntime against a stand-in `grok agent stdio` and harness: sessions are
// reused, a new model, effort or web search setting opens a new session, a new
// workspace starts a new process there, and the Allow tool changes setting
// reaches an open session from the next mention.
import assert from 'node:assert/strict';
import { GrokRuntime } from '../plugin/plugin.js';

const calls = [];
const spawns = [];
let nextSession = 0;

function fakeHost() {
  const servers = [];
  const host = {
    servers,
    duringPrompt: undefined,
    inTurn: undefined,
    /** What the stand-in Grok asks permission for during a prompt. */
    permissionFor: undefined,
    async spawn(id, { cwd, onStdout }) {
      spawns.push({ id, cwd });
      const out = (message) => queueMicrotask(() => onStdout(`${JSON.stringify(message)}\n`));
      const asked = new Map();
      let nextAsk = 1000;
      return {
        exited: new Promise(() => {}),
        async kill() {},
        async write(line) {
          const message = JSON.parse(line);
          if (message.method === undefined) {
            // The client's answer to a permission request.
            asked.get(message.id)?.(message.result?.outcome);
            return;
          }
          if (message.id === undefined) return;
          calls.push({ method: message.method, params: message.params });
          const reply = (result) => out({ jsonrpc: '2.0', id: message.id, result });
          switch (message.method) {
            case 'initialize': return reply({ protocolVersion: 1 });
            case 'session/new':
              // Like Grok, list the session's MCP tools while opening it.
              await host.servers.at(-1)?.handler({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
              return reply({
              sessionId: `s${++nextSession}`,
              models: {
                currentModelId: 'grok-a',
                availableModels: [{ modelId: 'grok-a' }, { modelId: 'grok-b' }],
              },
            });
            case 'session/prompt': {
              // A Grok that ignores session/cancel and never answers.
              if (host.hang) { host.hung = true; return; }
              const sessionId = message.params.sessionId;
              const update = (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
              if (host.permissionFor) {
                const askId = ++nextAsk;
                const outcome = new Promise((resolve) => asked.set(askId, resolve));
                out({
                  jsonrpc: '2.0', id: askId, method: 'session/request_permission',
                  params: {
                    sessionId,
                    toolCall: host.permissionFor,
                    options: [
                      { optionId: 'allow-once', kind: 'allow_once' },
                      { optionId: 'reject-once', kind: 'reject_once' },
                    ],
                  },
                });
                host.outcome = await outcome;
                if (host.outcome?.optionId === 'reject-once') return reply({ stopReason: 'cancelled' });
              }
              // Tool calls Grok makes while the turn runs.
              if (host.duringPrompt) host.inTurn = await host.duringPrompt();
              update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll read the thread." } });
              update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'use_tool' });
              update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
              return reply({ stopReason: 'end_turn' });
            }
            default: return reply({});
          }
        },
      };
    },
    async serveMcp(handler) {
      const server = { handler, url: 'http://127.0.0.1:1/mcp', headers: [], closed: new Promise(() => {}), async close() {} };
      servers.push(server);
      return server;
    },
  };
  return host;
}

const replies = [];
const harness = {
  async conversation() { return { key: 'thread-1', where: 'a thread' }; },
  tools() {
    return async (message) => message.method === 'tools/list'
      ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'read' }, { name: 'channel_delete' }] } }
      : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } };
  },
  async turnPrompt() { return { text: 'question', cursor: 1, restore() {} }; },
  async reply(_agent, _conversation, text) { replies.push(text); },
};

let saved = { workspace: '/tmp', model: '', allowWrites: false };
const host = fakeHost();
const runtime = new GrokRuntime(host, harness, { current: () => saved });

let stop;
async function mention() {
  let done;
  await runtime.run({
    trigger: { type: 'mention' },
    agent: { key: 'agent-1', name: 'Test Grok' },
    config: { workspace: '/tmp' },
    workingUntil: (promise) => { done = promise; },
    interruptible: (fn) => { stop = fn; },
  });
  return done;
}
const count = (method) => calls.filter((call) => call.method === method).length;
const last = (method) => calls.filter((call) => call.method === method).at(-1);
const configCalls = () => calls.filter((call) => call.method === 'session/set_config_option');
const toolCall = (server) => server.handler({
  jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'channel_delete', arguments: { id: 'x' } },
});

// Each turn deletes a channel through its tool server while it runs.
host.duringPrompt = async () => (await toolCall(host.servers.at(-1))).result.isError;

// First mention: one process in the workspace, one session on the account's
// default model, in ask mode with the Buzz tool profile.
assert.deepEqual(await mention(), { ok: true });
assert.deepEqual(replies, ['hello'], 'only the text after the last tool call is posted');
assert.equal(count('initialize'), 1);
assert.deepEqual(spawns, [{ id: 'grok', cwd: '/tmp' }]);
assert.equal(count('session/new'), 1);
const opened = last('session/new').params;
assert.equal(opened.cwd, '/tmp');
assert.equal(opened._meta.yoloMode, false);
assert.deepEqual(opened._meta.agentProfile.tools, ['search_tool', 'use_tool'], 'no web search by default');
assert.deepEqual(opened.mcpServers.map((server) => server.name), ['buzz']);
assert.equal(configCalls().length, 0, 'the default model and effort are left alone');
assert.equal(host.inTurn, true);

// Writes turned on: same session, and its tool server now allows changes.
saved = { ...saved, allowWrites: true };
await mention();
assert.equal(count('session/new'), 1);
assert.equal(host.inTurn, undefined);

// Once the turn is over, the open server refuses every call, writes included.
const after = await toolCall(host.servers[0]);
assert.equal(after.result.isError, true);
assert.match(after.result.content[0].text, /No Grok turn is running/);

// Writes turned off again: refused in the same open session.
saved = { ...saved, allowWrites: false };
await mention();
assert.equal(count('session/new'), 1);
assert.equal(host.inTurn, true);

// A new model and effort: the old session is closed and a new one opens.
saved = { ...saved, model: 'grok-b', effort: 'low' };
await mention();
assert.equal(count('session/new'), 2);
assert.equal(count('session/close'), 1);
assert.deepEqual(configCalls().map((call) => [call.params.configId, call.params.value]),
  [['model', 'grok-b'], ['reasoning_effort', 'low']]);

// Web search on: another new session, with the web_search tool.
saved = { ...saved, webSearch: true };
await mention();
assert.equal(count('session/new'), 3);
assert.deepEqual(last('session/new').params._meta.agentProfile.tools, ['search_tool', 'use_tool', 'web_search']);

// A new workspace: a new process started there, and a new session.
saved = { ...saved, workspace: '/var' };
await mention();
assert.deepEqual(spawns.at(-1), { id: 'grok', cwd: '/var' });
assert.equal(count('initialize'), 2);
assert.equal(last('session/new').params.cwd, '/var');

// A model the account does not offer is refused with a post.
saved = { ...saved, model: 'grok-z' };
const failed = await mention();
assert.equal(failed.ok, false);
assert.match(replies.at(-1), /Grok model grok-z is unavailable/);

// A relative workspace is refused before anything starts.
saved = { ...saved, model: '', workspace: 'relative/path' };
const sessionsBefore = count('session/new');
assert.equal((await mention()).ok, false);
assert.match(replies.at(-1), /absolute Workspace path/);
assert.equal(count('session/new'), sessionsBefore);

// A Buzz tool call is approved once.
saved = { workspace: '/var', model: '', allowWrites: false };
host.permissionFor = { title: 'buzz__read', rawInput: { variant: 'UseTool', tool_name: 'buzz__read', tool_input: {} } };
assert.deepEqual(await mention(), { ok: true });
assert.deepEqual(host.outcome, { outcome: 'selected', optionId: 'allow-once' });

// A buzz__ name the server never listed is rejected too.
host.permissionFor = { title: 'buzz__wipe', rawInput: { variant: 'UseTool', tool_name: 'buzz__wipe', tool_input: {} } };
assert.equal((await mention()).ok, false);
assert.deepEqual(host.outcome, { outcome: 'selected', optionId: 'reject-once' });
assert.match(replies.at(-1), /Grok tried to use buzz__wipe/);

// Any other tool is rejected; Grok ends the turn, and the post says why.
host.permissionFor = { title: 'Write `/tmp/x`', kind: 'edit', rawInput: { variant: 'Write', file_path: '/tmp/x' }, _meta: { 'x.ai/tool': { name: 'write' } } };
const refused = await mention();
assert.equal(refused.ok, false);
assert.deepEqual(host.outcome, { outcome: 'selected', optionId: 'reject-once' });
assert.match(replies.at(-1), /Grok tried to use write, which this plugin does not allow/);
host.permissionFor = undefined;

// Stop: a tool call that arrives after the owner pressed Stop is refused,
// even with writes allowed.
saved = { workspace: '/var', model: '', allowWrites: true };
host.duringPrompt = async () => {
  await stop();
  return (await toolCall(host.servers.at(-1))).result.content[0].text;
};
const repliesBeforeStop = replies.length;
assert.deepEqual(await mention(), { ok: true, stopped: true });
assert.match(host.inTurn, /No Grok turn is running/);
// Grok still answered end_turn after the cancel: nothing is posted.
assert.equal(replies.length, repliesBeforeStop);

// Stop while Grok ignores the cancel and never answers: the turn ends at
// once as stopped, with no reply and no failure post.
host.duringPrompt = undefined;
host.hang = true;
let hungDone;
await runtime.run({
  trigger: { type: 'mention' },
  agent: { key: 'agent-1', name: 'Test Grok' },
  config: { workspace: '/var' },
  workingUntil: (promise) => { hungDone = promise; },
  interruptible: (fn) => { stop = fn; },
});
while (!host.hung) await new Promise((resolve) => setTimeout(resolve, 1));
await stop();
assert.deepEqual(await Promise.race([hungDone, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000))]), { ok: true, stopped: true });
assert.equal(replies.length, repliesBeforeStop);

runtime.dispose();
console.log('Runtime checks passed');
