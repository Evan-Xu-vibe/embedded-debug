import * as assert from 'assert';
import { VariableObject } from '../../src/backend/backend';
import { LiveWatchMonitor, VariablesHandler } from '../../src/live-watch-monitor';

suite('Live Watch monitor', () => {
    test('Clears every top-level var-object even without a sampled change cache', async () => {
        const handler = new VariablesHandler(() => false, () => { });
        const parent = new VariableObject(0, [['name', 'watch_parent'], ['numchild', '1'], ['value', '{...}']]);
        const reference = handler.findOrCreateVariable(parent);
        handler.findOrCreateVariable(new VariableObject(reference, [['name', 'watch_parent.child'], ['numchild', '0'], ['value', '1']]));
        handler.findOrCreateVariable(new VariableObject(0, [['name', 'watch_scalar'], ['numchild', '0'], ['value', '2']]));
        const commands = [];
        await handler.clearCachedVars({
            sendCommand: (command) => {
                commands.push(command);
                return Promise.resolve();
            }
        } as any);
        assert.deepEqual(commands.sort(), ['var-delete watch_parent', 'var-delete watch_scalar']);
        assert.equal(handler.variableHandlesReverse.size, 0);
        assert.equal(handler.variableHandles.get(reference), undefined);
        assert.equal(handler.cachedChangeList, undefined);
    });

    test('Reads new values using liveEvaluate without a background cache sampler', async () => {
        const session: any = { args: {}, sendResponse: () => { } };
        const monitor: any = new LiveWatchMonitor(session);
        let variable: VariableObject;
        let updates = 0;
        monitor.miDebugger = {
            varCreate: (_parent, _expression, name) => {
                variable = new VariableObject(0, [['name', name], ['numchild', '0'], ['type', 'int'], ['value', '1']]);
                return Promise.resolve(variable);
            },
            varUpdate: () => {
                updates++;
                return Promise.resolve({ result: () => [[['name', variable.name], ['in_scope', 'true'], ['value', '2']]] });
            }
        };
        const first: any = {};
        const second: any = {};
        await monitor.evaluateRequest(first, { expression: 'counter', context: 'watch' });
        await monitor.evaluateRequest(second, { expression: 'counter', context: 'watch' });
        assert.equal(first.body.result, '1');
        assert.equal(second.body.result, '2');
        assert.equal(updates, 1);
    });

    test('Notifies the adapter when Live GDB exits', () => {
        let exited: LiveWatchMonitor;
        const session: any = { liveWatchExited: (monitor) => {
            exited = monitor;
        } };
        const monitor: any = new LiveWatchMonitor(session);
        monitor.miDebugger = {};
        monitor.quitEvent();
        assert.equal(exited, monitor);
        assert.equal(monitor.miDebugger, undefined);
    });

    for (const format of ['natural', 'hexadecimal', 'decimal', 'binary', 'octal']) {
        test(`Asks GDB for ${format} without changing the var-object or global radix`, async () => {
            const handler = new VariablesHandler(() => false, () => { });
            const commands = [];
            const variable = new VariableObject(0, [['name', 'watch_flags'], ['numchild', '0'], ['value', '18446744073709551615']]);
            const session: any = { args: {}, sendResponse: () => { } };
            const debuggerApi: any = {
                varCreate: () => Promise.resolve(variable),
                sendCommand: (command) => {
                    commands.push(command);
                    return Promise.resolve({ result: () => '1111111111111111111111111111111111111111111111111111111111111111' });
                }
            };
            const response: any = {};
            await handler.evaluateRequest(response, {
                expression: 'flags', context: 'watch', liveWatchFormat: format
            } as any, debuggerApi, session, true);
            assert.deepEqual(commands, [`var-evaluate-expression -f ${format} "watch_flags"`]);
            assert.equal(response.body.result, '1111111111111111111111111111111111111111111111111111111111111111');
            assert.equal(variable.value, '18446744073709551615');
        });
    }

    test('Formats an array element independently and leaves its sibling unchanged', async () => {
        const handler = new VariablesHandler(() => false, () => { });
        const parent = new VariableObject(0, [['name', 'watch_array'], ['numchild', '2'], ['value', '{...}']]);
        parent.exp = 'flags';
        const reference = handler.findOrCreateVariable(parent);
        const children = [0, 1].map((index) => new VariableObject(reference, [
            ['name', `watch_array.${index}`], ['exp', `${index}`], ['numchild', '0'], ['type', 'int'], ['value', '5']
        ]));
        const commands = [];
        const response: any = {};
        await handler.variablesChildrenRequest(response, {
            variablesReference: reference, liveWatchFormats: { '0': 'binary' }
        } as any, {
            varListChildren: () => Promise.resolve(children),
            sendCommand: (command) => {
                commands.push(command);
                return Promise.resolve({ result: () => '101' });
            }
        } as any, { sendResponse: () => { }, sendErrorResponsePub: () => assert.fail('Expansion failed') } as any);
        assert.deepEqual(commands, ['var-evaluate-expression -f binary "watch_array.0"']);
        assert.equal(response.body.variables[0].value, '101');
        assert.equal(response.body.variables[1].value, '5');
        assert.equal(children[0].value, '5');
    });

    test('Returning to Default restores the original value without changing GDB formatting', async () => {
        const monitor: any = new LiveWatchMonitor({ args: {}, sendResponse: () => { } } as any);
        const commands = [];
        monitor.miDebugger = {
            varCreate: (_parent, _expression, name) => Promise.resolve(new VariableObject(0, [
                ['name', name], ['numchild', '0'], ['type', 'unsigned long long'], ['value', '18446744073709551615']
            ])),
            varUpdate: () => Promise.resolve({ result: () => [] }),
            sendCommand: (command) => {
                commands.push(command);
                return Promise.resolve({ result: () => '0xffffffffffffffff' });
            }
        };
        const hexadecimal: any = {};
        await monitor.evaluateRequest(hexadecimal, { expression: 'counter', context: 'watch', liveWatchFormat: 'hexadecimal' });
        const original: any = {};
        await monitor.evaluateRequest(original, { expression: 'counter', context: 'watch' });
        assert.equal(hexadecimal.body.result, '0xffffffffffffffff');
        assert.equal(original.body.result, '18446744073709551615');
        assert.equal(commands.length, 1);
    });

    test('Rejects unrecognized format strings before issuing a GDB format command', async () => {
        const monitor: any = new LiveWatchMonitor({ args: {}, sendResponse: () => { } } as any);
        monitor.miDebugger = {
            varCreate: (_parent, _expression, name) => Promise.resolve(new VariableObject(0, [
                ['name', name], ['numchild', '0'], ['value', '5']
            ])),
            sendCommand: () => assert.fail('Invalid format reached GDB')
        };
        const response: any = {};
        await monitor.evaluateRequest(response, { expression: 'counter', context: 'watch', liveWatchFormat: 'bogus' });
        assert.match(response.body.result, /Unsupported Live Watch display format/);
    });
});
