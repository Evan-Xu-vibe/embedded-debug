import * as assert from 'assert';
import * as Module from 'module';

// A narrow VS Code API double exercises the real provider outside an extension host.
const contexts = new Map<string, unknown>();
const api: any = {
    EventEmitter: class {
        public event = () => ({ dispose: () => { } });
        public fire() { }
        public dispose() { }
    },
    TreeItem: class {
        constructor(public label, public collapsibleState) { }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    commands: {
        executeCommand: (_command, key, value) => {
            contexts.set(key, value);
            return Promise.resolve();
        }
    },
    debug: { activeDebugSession: undefined },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback): unknown => fallback }),
        onDidChangeConfiguration: () => ({ dispose: () => { } })
    },
    window: { showInputBox: () => Promise.resolve(undefined) }
};
const loader = Module as any;
const originalLoad = loader._load;
const providerPath = require.resolve('../../src/frontend/views/live-watch');
const previousModule = require.cache[providerPath];
let Provider: typeof import('../../src/frontend/views/live-watch').LiveWatchTreeProvider;
try {
    delete require.cache[providerPath];
    loader._load = function (name, ...args): unknown {
        const result: unknown = name === 'vscode' ? api : originalLoad.call(this, name, ...args);
        return result;
    };
    const loaded: typeof import('../../src/frontend/views/live-watch') = originalLoad.call(
        loader, providerPath, module);
    Provider = loaded.LiveWatchTreeProvider;
} finally {
    loader._load = originalLoad;
    if (previousModule) {
        require.cache[providerPath] = previousModule;
    } else {
        delete require.cache[providerPath];
    }
}

async function flush() {
    for (let i = 0; i < 30; i++) {
        await Promise.resolve();
    }
}

function makeSession(id = 'one') {
    const calls: { command: string; args: any }[] = [];
    const session: any = {
        id, name: id, type: 'cortex-debug', configuration: { liveWatch: { enabled: true, samplesPerSecond: 4 } },
        customRequest: (command, args) => {
            calls.push({ command, args });
            if (command === 'get-live-watch-state') { return Promise.resolve({ available: true }); }
            if (command === 'liveEvaluate') { return Promise.resolve({ result: id, variablesReference: 0 }); }
            return Promise.resolve({});
        }
    };
    return { session, calls };
}

suite('Live Watch panel lifecycle', () => {
    let provider: InstanceType<typeof Provider>;
    let saved: Map<string, any>;

    setup(() => {
        contexts.clear();
        saved = new Map();
        provider = new Provider({
            workspaceState: {
                get: (key): unknown => saved.get(key),
                update: (key, value) => {
                    saved.set(key, value);
                    return Promise.resolve();
                }
            }, subscriptions: []
        } as any);
        provider.attachView({ visible: true } as any);
    });

    teardown(() => {
        provider.dispose();
        api.debug.activeDebugSession = undefined;
    });

    test('Polls only while running and enabled; supports one manual refresh while disabled', async () => {
        const { session, calls } = makeSession();
        api.debug.activeDebugSession = session;
        provider.debugSessionStarted(session);
        provider.addWatchExpr('counter');
        provider.debugContinued(session);
        await flush();
        assert.equal(provider.model.roots[0].value, 'one');
        assert.ok((provider as any).timer);
        provider.setEnabled(false);
        assert.equal((provider as any).timer, undefined);
        assert.equal(contexts.get('cortex-debug:liveWatchEnabled'), false);
        const before = calls.filter((call) => call.command === 'liveEvaluate').length;
        provider.refresh();
        await flush();
        assert.equal(calls.filter((call) => call.command === 'liveEvaluate').length, before + 1);
        assert.equal((provider as any).timer, undefined);
        provider.setEnabled(true);
        await flush();
        assert.ok((provider as any).timer);
        provider.debugStopped(session);
        await flush();
        assert.equal((provider as any).timer, undefined);
    });

    test('Can add, persist and edit the list before a debug session exists', () => {
        provider.addWatchExpr('counter');
        assert.equal(saved.get('livewatch.watchTree').children[0].expr, 'counter');
        assert.equal(contexts.get('cortex-debug:liveWatchHasExpressions'), true);
        provider.removeAll();
        assert.deepEqual(saved.get('livewatch.watchTree').children, []);
        assert.equal(contexts.get('cortex-debug:liveWatchHasExpressions'), false);
    });

    test('Drag and drop persists top-level order without nesting expressions', () => {
        provider.addWatchExpr('first');
        provider.addWatchExpr('second');
        const [first, second] = provider.model.roots;
        provider.handleDrop(first, { get: () => ({ value: [second] }) } as any);
        assert.deepEqual(provider.model.roots.map((node) => node.expression), ['second', 'first']);
        const persisted = saved.get('livewatch.watchTree') as { children: { expr: string }[] };
        assert.deepEqual(persisted.children.map((node) => node.expr), ['second', 'first']);
    });

    test('Stops hidden-panel polling and resumes when the view is shown', async () => {
        const { session, calls } = makeSession();
        api.debug.activeDebugSession = session;
        provider.debugSessionStarted(session);
        provider.addWatchExpr('counter');
        provider.debugContinued(session);
        await flush();
        provider.setVisible(false);
        assert.equal((provider as any).timer, undefined);
        const before = calls.length;
        provider.refresh();
        await flush();
        assert.equal(calls.length, before);
        provider.setVisible(true);
        await flush();
        assert.ok((provider as any).timer);
    });

    test('Disabling during an in-flight refresh ignores its late value and queued refresh', async () => {
        const { session } = makeSession();
        api.debug.activeDebugSession = session;
        provider.debugSessionStarted(session);
        provider.addWatchExpr('counter');
        provider.debugContinued(session);
        await flush();
        let finish: (result: any) => void;
        session.customRequest = () => new Promise((resolve) => {
            finish = resolve;
        });
        provider.refresh();
        provider.refresh();
        provider.setEnabled(false);
        finish({ result: 'stale', variablesReference: 0 });
        await flush();
        assert.equal(provider.model.roots[0].value, 'one');
        assert.equal((provider as any).timer, undefined);
        assert.equal((provider as any).pending, false);
    });

    test('Switches sessions without publishing the previous session response', async () => {
        const first = makeSession('one');
        const second = makeSession('two');
        api.debug.activeDebugSession = first.session;
        provider.debugSessionStarted(first.session);
        provider.addWatchExpr('counter');
        await flush();
        let finish: (result: any) => void;
        first.session.customRequest = () => new Promise((resolve) => {
            finish = resolve;
        });
        provider.refresh();
        provider.debugSessionStarted(second.session);
        api.debug.activeDebugSession = second.session;
        provider.selectSession(second.session);
        await flush();
        finish({ result: 'stale', variablesReference: 0 });
        await flush();
        assert.equal(provider.model.roots[0].value, 'two');
        provider.debugSessionTerminated(first.session);
        assert.equal(provider.model.roots[0].value, 'two');
    });

    test('Live GDB failure stops polling and clears runtime values', async () => {
        const { session } = makeSession();
        api.debug.activeDebugSession = session;
        provider.debugSessionStarted(session);
        provider.addWatchExpr('counter');
        provider.debugContinued(session);
        await flush();
        provider.liveStateChanged(session, false);
        assert.equal((provider as any).timer, undefined);
        assert.equal(provider.model.roots[0].value, 'not available');
        assert.equal(contexts.get('cortex-debug:liveWatchAvailable'), false);
    });

    test('Selecting Binary while updates are off reads once and leaves the switch off', async () => {
        const { session, calls } = makeSession();
        api.debug.activeDebugSession = session;
        provider.debugSessionStarted(session);
        provider.addWatchExpr('flags');
        provider.debugContinued(session);
        await flush();
        provider.setEnabled(false);
        const before = calls.filter((call) => call.command === 'liveEvaluate').length;
        provider.setFormat(provider.model.roots[0], 'binary');
        await flush();
        const evaluations = calls.filter((call) => call.command === 'liveEvaluate');
        assert.equal(evaluations.length, before + 1);
        assert.equal(evaluations[evaluations.length - 1].args.liveWatchFormat, 'binary');
        assert.equal(contexts.get('cortex-debug:liveWatchEnabled'), false);
        assert.equal((provider as any).timer, undefined);
        assert.equal(saved.get('livewatch.watchTree').children[0].format, 'binary');
        assert.equal(provider.getTreeItem(provider.model.roots[0]).description, 'binary');
    });
});
