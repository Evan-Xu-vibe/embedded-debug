import * as assert from 'assert';
import { LiveWatchModel } from '../../src/frontend/live-watch-model';

suite('Live Watch expression model', () => {
    test('Adds, edits, removes and reorders expressions without losing saved order', () => {
        const model = new LiveWatchModel();
        const first = model.add(' counter ');
        const second = model.add('state');
        assert.equal(model.add('counter'), undefined);
        assert.equal(model.add(' '), undefined);
        assert.equal(model.move(first, -1), false);
        assert.equal(model.move(second, -1), true);
        assert.equal(model.edit(first, 'state'), false);
        assert.equal(model.edit(first, 'tick'), true);
        const restored = new LiveWatchModel();
        restored.restore(model.save());
        assert.deepEqual(restored.roots.map((node) => node.expression), ['state', 'tick']);
        assert.equal(model.remove(first), true);
        assert.equal(model.remove(first), false);
    });

    test('Reads visible roots and expanded children, preserving identity and change highlights', async () => {
        const model = new LiveWatchModel();
        const root = model.add('state');
        root.expanded = true;
        let value = '1';
        const calls = [];
        const client = {
            customRequest: (command, args) => {
                calls.push(command);
                return Promise.resolve(command === 'liveEvaluate'
                    ? { result: '{...}', type: 'State', variablesReference: 256 }
                    : { variables: [{ name: 'counter', evaluateName: 'state.counter', value, type: 'int', variablesReference: 0 }] });
            }
        };
        await model.refresh(client, () => true);
        const child = root.children[0];
        assert.equal(child.expression, 'state.counter');
        assert.equal(child.parent, root);
        assert.equal(child.changed, false);
        value = '2';
        await model.refresh(client, () => true);
        assert.equal(root.children[0], child);
        assert.equal(child.value, '2');
        assert.equal(child.changed, true);
        root.expanded = false;
        calls.length = 0;
        await model.refresh(client, () => true);
        assert.deepEqual(calls, ['liveEvaluate']);
    });

    test('Ignores an evaluation completing after a session switch or edit', async () => {
        const model = new LiveWatchModel();
        const root = model.add('counter');
        let complete: (result: any) => void;
        let current = true;
        const pending = model.refresh({ customRequest: () => new Promise((resolve) => {
            complete = resolve;
        }) }, () => current);
        current = false;
        model.edit(root, 'tick');
        complete({ result: 'stale', variablesReference: 256 });
        await pending;
        assert.equal(root.expression, 'tick');
        assert.equal(root.value, 'not available');
        assert.equal(root.reference, 0);
    });

    test('Waits for nested expanded children before finishing a refresh', async () => {
        const model = new LiveWatchModel();
        const root = model.add('state');
        root.expanded = true;
        const result = { variables: [{ name: 'nested', value: '{...}', type: 'Inner', variablesReference: 257 }] };
        await model.refresh({
            customRequest: (command) => Promise.resolve(command === 'liveEvaluate'
                ? { result: '{...}', variablesReference: 256 }
                : result)
        }, () => true);
        root.children[0].expanded = true;
        let finish: (result: any) => void;
        let done = false;
        const refresh = model.refresh({
            customRequest: (command, args) => {
                if (command === 'liveEvaluate') { return Promise.resolve({ result: '{...}', variablesReference: 256 }); }
                if (args.variablesReference === 256) { return Promise.resolve(result); }
                return new Promise((resolve) => {
                    finish = resolve;
                });
            }
        }, () => true).then(() => {
            done = true;
        });
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }
        assert.equal(done, false);
        finish({ variables: [{ name: 'value', value: '7', variablesReference: 0 }] });
        await refresh;
        assert.equal(root.children[0].children[0].value, '7');
    });

    test('Keeps other expressions readable after a request fails', async () => {
        const model = new LiveWatchModel();
        const first = model.add('bad');
        const second = model.add('counter');
        await model.refresh({
            customRequest: (_command, args) => args.expression === 'bad'
                ? Promise.reject(new Error('not in scope'))
                : Promise.resolve({ result: '4', variablesReference: 0 })
        }, () => true);
        assert.match(first.value, /not in scope/);
        assert.equal(second.value, '4');
    });

    test('Restores old version-two tree expansion without restoring stale runtime handles', () => {
        const model = new LiveWatchModel();
        model.restore({ name: '', expr: '', expanded: true, children: [
            { name: 'state', expr: 'state', expanded: true, children: [
                { name: 'counter', expr: 'state.counter', expanded: false, children: [] }
            ] }
        ] });
        assert.equal(model.roots[0].expanded, true);
        assert.equal(model.roots[0].children[0].parent, model.roots[0]);
        assert.equal(model.roots[0].reference, 0);
        assert.equal(model.roots[0].value, 'not available');
    });

    test('Persists independent formats and sends choices for roots and child rows', async () => {
        const model = new LiveWatchModel();
        const root = model.add('state');
        root.expanded = true;
        const requests = [];
        const client = {
            customRequest: (command, args) => {
                requests.push({ command, args });
                return Promise.resolve(command === 'liveEvaluate'
                    ? { result: '{...}', variablesReference: 256 }
                    : { variables: [
                            { name: 'flags', value: '5', variablesReference: 0 },
                            { name: 'count', value: '8', variablesReference: 0 }
                        ] });
            }
        };
        await model.refresh(client, () => true);
        assert.equal(model.setFormat(root, 'hexadecimal'), true);
        assert.equal(model.setFormat(root.children[0], 'binary'), true);
        assert.equal(root.children[1].format, undefined);
        const restored = new LiveWatchModel();
        restored.restore(model.save());
        restored.reset();
        assert.equal(restored.roots[0].format, 'hexadecimal');
        assert.equal(restored.roots[0].children[0].format, 'binary');
        requests.length = 0;
        await restored.refresh(client, () => true);
        assert.equal(requests[0].args.liveWatchFormat, 'hexadecimal');
        assert.deepEqual(requests[1].args.liveWatchFormats, { flags: 'binary' });
        assert.equal(restored.setFormat(restored.roots[0].children[0]), true);
        assert.equal(restored.roots[0].children[0].format, undefined);
    });
});
