import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { LiveWatchNode } from '../live-watch-model';
import { isLiveWatchFormat } from '../../live-watch-format';
import { LiveWatchTreeProvider, LiveWatchViewState } from './live-watch';

function serialize(node: LiveWatchNode): object {
    return {
        id: node.id, name: node.name, expression: node.expression, value: node.value, type: node.type,
        format: node.format, changed: node.changed, expanded: node.expanded, root: !node.parent,
        hasChildren: !!node.reference || node.children.length > 0, children: node.children.map(serialize)
    };
}

export class LiveWatchWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private view: vscode.WebviewView | undefined;
    private viewState: LiveWatchViewState = { visible: false };
    private selectedId: string | undefined;
    private ready = false;
    private pendingEdit: { id?: string; expression: string } | undefined;
    private readonly subscriptions: vscode.Disposable[];
    private viewSubscriptions: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext, private readonly provider: LiveWatchTreeProvider) {
        provider.attachView(this.viewState);
        this.subscriptions = [
            provider.onDidChangeTreeData(() => { this.render(); }),
            provider.onDidRequestEdit((node) => { this.beginEdit(node); })
        ];
    }

    public dispose() {
        this.viewSubscriptions.forEach((subscription) => {
            subscription.dispose();
        });
        this.subscriptions.forEach((subscription) => {
            subscription.dispose();
        });
    }

    private findNode(id: string): LiveWatchNode | undefined {
        const find = (nodes: LiveWatchNode[]): LiveWatchNode | undefined => {
            for (const node of nodes) {
                if (node.id === id) { return node; }
                const child = find(node.children);
                if (child) { return child; }
            }
            return undefined;
        };
        return find(this.provider.model.roots);
    }

    public resolveNode(argument?: { id?: string; liveWatchNodeId?: string }): LiveWatchNode | undefined {
        const id = argument?.liveWatchNodeId ?? argument?.id ?? this.selectedId;
        return typeof id === 'string' ? this.findNode(id) : undefined;
    }

    public beginEdit(node?: LiveWatchNode) {
        if (node?.parent) { return; }
        this.pendingEdit = { id: node?.id, expression: node?.expression || '' };
        if (this.view) { this.view.show(false); }
        vscode.commands.executeCommand('cortex-debug.liveWatch.focus');
        this.sendPendingEdit();
    }

    private sendPendingEdit() {
        if (this.view && this.ready && this.pendingEdit) {
            this.view.webview.postMessage({ type: 'edit', ...this.pendingEdit });
            this.pendingEdit = undefined;
        }
    }

    public resolveWebviewView(view: vscode.WebviewView) {
        this.viewSubscriptions.forEach((subscription) => {
            subscription.dispose();
        });
        this.viewSubscriptions = [];
        this.view = view;
        this.ready = false;
        this.viewState = { visible: view.visible };
        const resources = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
        view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
        const css = view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'live-watch.css'));
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'live-watch.js'));
        const nonce = randomBytes(16).toString('hex');
        view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css.toString()}"></head><body>
<div id="status" role="status"></div><div id="watch" role="tree" aria-label="Live Watch expressions" tabindex="0"></div>
<script nonce="${nonce}" src="${script.toString()}"></script></body></html>`;
        this.provider.attachView(this.viewState);
        this.viewSubscriptions.push(
            view.webview.onDidReceiveMessage((message) => { this.receive(message); }),
            view.onDidChangeVisibility(() => {
                this.viewState.visible = view.visible;
                this.provider.setVisible(view.visible);
                this.render();
            }),
            view.onDidDispose(() => {
                this.provider.setVisible(false);
                this.view = undefined;
                this.ready = false;
            })
        );
        this.render();
    }

    private render() {
        if (!this.view) { return; }
        this.view.description = this.viewState.description;
        this.view.webview.postMessage({
            type: 'state', status: this.viewState.message || '', nodes: this.provider.model.roots.map(serialize)
        });
    }

    private receive(message: any) {
        if (!message || typeof message.type !== 'string') { return; }
        const node = typeof message.id === 'string' ? this.findNode(message.id) : undefined;
        switch (message.type) {
            case 'ready':
                this.ready = true;
                this.render();
                this.sendPendingEdit();
                break;
            case 'select':
                this.selectedId = node?.id;
                break;
            case 'commit': {
                if (typeof message.expression !== 'string' || (message.id !== undefined && typeof message.id !== 'string')) { return; }
                const result = this.provider.commitExpression(message.id, message.expression);
                this.selectedId = result.id ?? this.selectedId;
                this.view?.webview.postMessage({ type: 'editResult', request: message.request, ...result });
                break;
            }
            case 'remove':
                if (node) { this.provider.removeWatchExpr(node); }
                break;
            case 'expand':
                if (node) { this.provider.expandChildren(node); }
                break;
            case 'collapse':
                if (node) {
                    node.expanded = false;
                    this.provider.saveState();
                    this.provider.fire();
                }
                break;
            case 'reorder':
                if (node && (message.target === undefined || this.findNode(message.target))) {
                    this.provider.reorder([node], message.target ? this.findNode(message.target) : undefined);
                }
                break;
            case 'format':
                if (node && (message.format === undefined || isLiveWatchFormat(message.format))) {
                    this.provider.setFormat(node, message.format);
                }
                break;
        }
    }
}
