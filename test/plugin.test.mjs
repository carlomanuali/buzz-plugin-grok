import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buzzToolOf, chooseGrokModel, config, DEFAULT_CONFIG, mcpHandler, sessionTools, TurnText } from '../plugin/plugin.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.id, 'carlomanuali.grok');
assert.equal(manifest.host.processes[0].program, 'grok');
// The strict sandbox, no cross-session memory, no shared leader, stdio ACP.
assert.deepEqual(manifest.host.processes[0].args, ['--sandbox', 'strict', '--no-memory', 'agent', '--no-leader', 'stdio']);
assert.ok(!JSON.stringify(manifest).includes('always-approve'));
assert.equal(manifest.host.files, undefined);
assert.deepEqual(DEFAULT_CONFIG, {instructions: '', scope: 'thread', workspace: '', model: '', effort: '', allowWrites: false, webSearch: false});
assert.equal(config({workspace:'/tmp', model:' grok-4.7 '}).model, 'grok-4.7');
assert.equal(config({effort:'high'}).effort, 'high');
assert.equal(config({effort:'turbo'}).effort, '');
// Web search is off unless the owner turns it on.
assert.equal(config({}).webSearch, false);
assert.equal(config({webSearch:'yes'}).webSearch, false);
assert.equal(config({webSearch:true}).webSearch, true);
assert.deepEqual(sessionTools(config({})), ['search_tool', 'use_tool']);
assert.deepEqual(sessionTools(config({webSearch:true})), ['search_tool', 'use_tool', 'web_search']);
const models = {currentModelId:'grok-a',availableModels:[{modelId:'grok-a'},{modelId:'grok-b'}]};
assert.equal(chooseGrokModel(models), undefined);
assert.equal(chooseGrokModel(models, 'grok-a'), undefined);
assert.equal(chooseGrokModel(models, 'grok-b'), 'grok-b');
assert.throws(() => chooseGrokModel(models, 'grok-z'), /unavailable/);

// Approvals: one Buzz MCP call through use_tool, nothing else.
const ask = (toolCall) => ({toolCall,options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'reject'}]});
const useTool = (name) => ({title:name,rawInput:{variant:'UseTool',tool_name:name,tool_input:{}}});
assert.equal(buzzToolOf(ask(useTool('buzz__read'))), 'read');
assert.equal(buzzToolOf(ask(useTool('github__delete_repo'))), undefined);
assert.equal(buzzToolOf(ask(useTool('buzz__read__x'))), undefined);
assert.equal(buzzToolOf(ask({title:'buzz__read',rawInput:{variant:'Bash',command:'buzz__read'}})), undefined);
const approval = new TurnText();
assert.deepEqual(approval.permission(ask(useTool('buzz__composio_connections'))), {outcome:'selected',optionId:'allow'});
assert.deepEqual(approval.permission(ask(useTool('github__delete_repo'))), {outcome:'selected',optionId:'reject'});
assert.equal(approval.refused, 'github__delete_repo');
assert.deepEqual(approval.permission(ask({title:'run',rawInput:{variant:'Bash',command:'rm -rf ~'},_meta:{'x.ai/tool':{name:'run_terminal_command'}}})), {outcome:'selected',optionId:'reject'});
assert.equal(approval.refused, 'run_terminal_command');
// A name that is not a plain tool name is not quoted in the post.
approval.permission(ask({rawInput:{variant:'UseTool',tool_name:'x y <b>'}}));
assert.equal(approval.refused, 'a tool');
assert.deepEqual(approval.permission({toolCall:useTool('buzz__read'),options:[{kind:'allow_once',optionId:'allow'}]}), {outcome:'selected',optionId:'allow'});
assert.deepEqual(approval.permission({toolCall:useTool('other__x'),options:[{kind:'allow_once',optionId:'allow'}]}), {outcome:'cancelled'});
// With the server's advertised list, only listed tools are approved.
const listed = new TurnText(() => true, new Set(['read']));
assert.deepEqual(listed.permission(ask(useTool('buzz__read'))), {outcome:'selected',optionId:'allow'});
assert.deepEqual(listed.permission(ask(useTool('buzz__wipe_everything'))), {outcome:'selected',optionId:'reject'});
// The handler records what tools/list returned, Composio tools included.
const seen = new Set();
await mcpHandler(async (m) => ({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'read'}]}}), {}, () => undefined, false, () => true, seen)({jsonrpc:'2.0',id:5,method:'tools/list'});
assert.deepEqual([...seen], ['read', 'composio_connections', 'composio_search', 'composio_schema', 'composio_execute']);
// After Stop nothing is approved.
const stopped = new TurnText(() => false);
assert.deepEqual(stopped.permission(ask(useTool('buzz__read'))), {outcome:'selected',optionId:'reject'});

// The reply is the text after the last tool call.
const turn = new TurnText();
turn.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:"I'll check."}});
turn.update({sessionUpdate:'tool_call'});
turn.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The answer'}});
turn.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' is 4.'}});
turn.update({sessionUpdate:'tool_call'});
assert.equal(turn.text(), 'The answer is 4.');

const buzz = async (message) => ({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'read'}]}});
let bridgeCalls = 0;
const host = {runCommand: async () => {bridgeCalls++; return JSON.stringify({ok:true,data:{login:'example'}});}};
const handler = mcpHandler(buzz, host, () => undefined);
const call = (name, args = {}) => handler({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
assert.equal((await call('channel_get')).result.isError, undefined);
assert.equal((await call('channel_delete')).result.isError, true);
assert.equal((await call('composio_execute', {slug:'GITHUB_DELETE_A_REPOSITORY'})).result.isError, true);
assert.equal(bridgeCalls, 0);
// Read-only mode runs no Composio action, even one named like a lookup.
assert.equal((await call('composio_execute', {slug:'GITHUB_GET_THE_AUTHENTICATED_USER',arguments:{}})).result.isError, true);
assert.equal(bridgeCalls, 0);
assert.equal((await call('composio_search', {query:'github user'})).result.isError, undefined);
assert.equal(bridgeCalls, 1);
const allowAll = mcpHandler(buzz, host, () => undefined, true);
const callAll = (name, args) => allowAll({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});
assert.equal((await callAll('channel_delete', {id:'x'})).result.isError, undefined);
assert.equal((await callAll('composio_execute', {slug:'GITHUB_GET_THE_AUTHENTICATED_USER',arguments:{}})).result.isError, undefined);
assert.equal(bridgeCalls, 2);
// Outside a running turn no tool call is served, reads included.
const idle = mcpHandler(buzz, host, () => undefined, true, () => false);
assert.equal((await idle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read',arguments:{}}})).result.isError, true);
assert.equal(Array.isArray((await mcpHandler(async (m) => ({jsonrpc:'2.0',id:m.id,result:{tools:[]}}), host, () => undefined, false, () => false)({jsonrpc:'2.0',id:4,method:'tools/list'})).result.tools), true);

const bridge = manifest.host.commands[0];
assert.equal(bridge.program, 'python3');
assert.equal(bridge.args[0], '-c');
// Buzz's manifest rules (plugin-manager valid_program): at most 16 arguments,
// each at most 1024 bytes and free of NUL, for every command and process.
for (const declared of [...manifest.host.commands, ...manifest.host.processes]) {
  assert.ok(declared.args.length <= 16, `${declared.id}: too many arguments`);
  for (const argument of declared.args) {
    assert.ok(Buffer.byteLength(argument) <= 1024, `${declared.id}: an argument is over 1024 bytes`);
    assert.ok(!argument.includes('\0'));
  }
}
// The chunks after the loader are the bridge source, unchanged.
assert.equal(bridge.args.slice(2).join(''), readFileSync(new URL('../src/composio_bridge.py', import.meta.url), 'utf8'));
assert.ok(!/\/Users\/[^/]+\/REPOS/.test(JSON.stringify(manifest)));
assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(manifest)));
const result = spawnSync('python3', bridge.args, {input:'{"operation":"invalid"}',encoding:'utf8'});
assert.equal(result.status, 0);
assert.equal(JSON.parse(result.stdout).ok, false);
// Values the Composio CLI could read as options are refused before it runs.
for (const request of [
  {operation:'search', query:'--help'},
  {operation:'execute', slug:'GITHUB_GET_THE_AUTHENTICATED_USER', arguments:{}, account:'-x'},
  {operation:'execute', slug:'GITHUB_GET_THE_AUTHENTICATED_USER', arguments:{}, account:'  '},
]) {
  const refused = spawnSync('python3', bridge.args, {input:JSON.stringify(request),encoding:'utf8',env:{...process.env,COMPOSIO_BIN:'/bin/false'}});
  const parsed = JSON.parse(refused.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /dash|nonempty/);
}
console.log('Plugin checks passed');
