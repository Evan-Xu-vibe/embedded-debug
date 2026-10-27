import * as assert from 'assert';
import * as Module from 'module';
import { LiveWatchNode } from '../../src/frontend/live-watch-model';

class ApiEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    public event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => {
            this.listeners.delete(listener);
        } };
    };

    public fire(value: T) {
        this.listeners.forEach((listener) => {
            listener(value);
        });
    }

    public dispose() { this.listeners.clear(); }
}

const focusCommands: string[] = [];
const api = {
    EventEmitter: ApiEmitter,
    workspace: {
        onDidChangeConfiguration: () => ({ dispose: () => { } }),
        getConfiguration: () => ({ get: (_key, fallback): unknown => fallback })
    },
    debug: { activeDebugSession: undefined },
    commands: { executeCommand: (command) => {
        focusCommands.push(command);
        return Promise.resolve();
    } },
    Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.map(String).join('/') }) },
    window: { showInputBox: () => assert.fail('Live Watch must never open a popup editor') }
};
const loader = Module as any;
const originalLoad = loader._load;
const paths = [require.resolve('../../src/frontend/views/live-watch'), require.resolve('../../src/frontend/views/live-watch-webview')];
const previous = paths.map((path) => require.cache[path]);
let Controller: typeof import('../../src/frontend/views/live-watch').LiveWatchTreeProvider;
let Webview: typeof import('../../src/frontend/views/live-watch-webview').LiveWatchWebviewProvider;
try {
    paths.forEach((path) => {
        delete require.cache[path];
    });
    loader._load = function (name, ...args): unknown {
        const result: unknown = name === 'vscode' ? api : originalLoad.call(this, name, ...args);
        return result;
    };
    const controllerModule: typeof import('../../src/frontend/views/live-watch') = originalLoad.call(loader, paths[0], module);
    const webviewModule: typeof import('../../src/frontend/views/live-watch-webview') = originalLoad.call(loader, paths[1], module);
    Controller = controllerModule.LiveWatchTreeProvider;
    Webview = webviewModule.LiveWatchWebviewProvider;
} finally {
    loader._load = originalLoad;
    paths.forEach((path, index) => {
        if (previous[index]) {
            require.cache[path] = previous[index];
        } else {
            delete require.cache[path];
        }
    });
}

suite('Live Watch inline webview bridge', () => {
    let controller: InstanceType<typeof Controller>;
    let bridge: InstanceType<typeof Webview>;
    let receive: (message: any) => void;
    let messages: any[];
    let view: any;

    setup(() => {
        messages = [];
        focusCommands.length = 0;
        const context: any = {
            extensionUri: 'file:///extension', subscriptions: [],
            workspaceState: { get: () => undefined, update: () => Promise.resolve() }
        };
        controller = new Controller(context);
        bridge = new Webview(context, controller);
        view = {
            visible: true,
            show: () => { },
            webview: {
                cspSource: 'https://test.invalid',
                asWebviewUri: (uri): unknown => uri,
                postMessage: (message) => {
                    messages.push(message);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage: (listener) => {
                    receive = listener;
                    return { dispose: () => { } };
                }
            },
            onDidChangeVisibility: () => ({ dispose: () => { } }),
            onDidDispose: () => ({ dispose: () => { } })
        };
    });

    teardown(() => {
        bridge.dispose();
        controller.dispose();
    });

    test('Queues Add until the sidebar is created and its script is ready', () => {
        bridge.beginEdit();
        assert.ok(focusCommands.includes('cortex-debug.liveWatch.focus'));
        bridge.resolveWebviewView(view);
        assert.ok(!messages.some((message) => message.type === 'edit'));
        receive({ type: 'ready' });
        assert.deepEqual(messages.find((message) => message.type === 'edit'), { type: 'edit', id: undefined, expression: '' });
        assert.match(view.webview.html, /live-watch\.js/);
        assert.match(view.webview.html, /Content-Security-Policy/);
    });

    test('Inline commits save expressions and return validation errors in the row', () => {
        bridge.resolveWebviewView(view);
        receive({ type: 'commit', request: 1, expression: 'counter' });
        const node = controller.model.roots[0];
        assert.equal(node.expression, 'counter');
        assert.equal(messages[messages.length - 1].id, node.id);
        receive({ type: 'commit', request: 2, expression: 'counter' });
        assert.match(messages[messages.length - 1].error, /already watched/);
        receive({ type: 'commit', request: 3, id: node.id, expression: 'ticks' });
        assert.equal(node.expression, 'ticks');
        assert.equal(messages[messages.length - 1].request, 3);
    });

    test('Native context menus resolve the clicked field independently of selection', () => {
        controller.addWatchExpr('state');
        const root = controller.model.roots[0];
        const child = new LiveWatchNode('flags', 'state.flags', root);
        root.children.push(child);
        bridge.resolveWebviewView(view);
        receive({ type: 'select', id: root.id });
        assert.equal(bridge.resolveNode({ liveWatchNodeId: child.id }), child);
        receive({ type: 'format', id: child.id, format: 'binary' });
        assert.equal(child.format, 'binary');
        assert.equal(root.format, undefined);
        receive({ type: 'remove', id: child.id });
        assert.equal(root.children.length, 1);
    });

    test('Edit commands request an inline editor without invoking showInputBox', () => {
        controller.addWatchExpr('counter');
        bridge.resolveWebviewView(view);
        receive({ type: 'ready' });
        controller.editNode(controller.model.roots[0]);
        const edit = messages.filter((message) => message.type === 'edit').pop();
        assert.equal(edit.expression, 'counter');
        assert.equal(edit.id, controller.model.roots[0].id);
    });
});
