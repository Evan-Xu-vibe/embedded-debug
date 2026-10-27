import * as vscode from 'vscode';
import { LiveWatchModel, LiveWatchNode, SavedWatchNode } from '../live-watch-model';
import { liveWatchRefreshInterval } from '../../live-watch-utils';
import { LiveWatchFormat } from '../../live-watch-format';

export { LiveWatchNode as LiveVariableNode } from '../live-watch-model';

interface SessionState {
    session: vscode.DebugSession;
    available: boolean;
    enabled: boolean;
    running: boolean;
}

const WATCH_LIST_STATE = 'livewatch.watchTree';

export class LiveWatchTreeProvider implements vscode.TreeDataProvider<LiveWatchNode>,
    vscode.TreeDragAndDropController<LiveWatchNode>, vscode.Disposable {
    public readonly dragMimeTypes = ['application/vnd.cortex-debug.live-watch'];
    public readonly dropMimeTypes = this.dragMimeTypes;
    private readonly changes = new vscode.EventEmitter<LiveWatchNode | undefined>();
    public readonly onDidChangeTreeData = this.changes.event;
    public readonly model = new LiveWatchModel();
    private readonly sessions = new Map<string, SessionState>();
    private active: SessionState | undefined;
    private view: vscode.TreeView<LiveWatchNode> | undefined;
    private timer: NodeJS.Timeout | undefined;
    private revision = 0;
    private refreshing = false;
    private pending = false;
    private cacheDirty = true;
    private visible = true;
    private disposed = false;
    private refreshFailed = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        const saved = context.workspaceState.get<SavedWatchNode>(WATCH_LIST_STATE);
        if (saved) { this.model.restore(saved); }
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('cortex-debug.liveWatchRefreshRate')) { this.refresh(); }
        }));
    }

    public attachView(view: vscode.TreeView<LiveWatchNode>) {
        this.view = view;
        this.visible = view.visible;
        this.updateState();
    }

    public setVisible(visible: boolean) {
        this.visible = visible;
        this.invalidate();
        if (visible && this.automaticRefresh()) { this.refresh(); }
    }

    public dispose() {
        this.disposed = true;
        this.invalidate();
        this.changes.dispose();
    }

    private invalidate() {
        this.revision++;
        this.pending = false;
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = undefined;
    }

    private automaticRefresh(): boolean {
        return !!this.active?.available && (this.active.enabled || !this.active.running);
    }

    private updateState() {
        const state = this.active;
        vscode.commands.executeCommand('setContext', 'cortex-debug:liveWatchAvailable', !!state?.available);
        vscode.commands.executeCommand('setContext', 'cortex-debug:liveWatchEnabled', state?.enabled ?? true);
        vscode.commands.executeCommand('setContext', 'cortex-debug:liveWatchHasExpressions', this.model.roots.length > 0);
        if (this.view) {
            this.view.description = state?.session.name;
            this.view.message = !state
                ? 'Start a Cortex-Debug session with liveWatch.enabled to read global/static expressions.'
                : !state.available
                        ? 'Waiting for the Live GDB connection. Check liveWatch.enabled and the Debug Console.'
                        : !state.running
                                ? 'Target paused · global/static values'
                                : state.enabled ? 'Target running · live updates on' : 'Live updates off · values frozen';
        }
    }

    public saveState() {
        this.context.workspaceState.update('livewatch.version', 2);
        this.context.workspaceState.update(WATCH_LIST_STATE, this.model.save());
    }

    public selectSession(session = vscode.debug.activeDebugSession) {
        const next = session?.type === 'cortex-debug' ? this.sessions.get(session.id) : undefined;
        if (next === this.active) { return; }
        this.invalidate();
        this.active = next;
        this.cacheDirty = true;
        this.model.reset();
        this.updateState();
        this.fire();
        if (this.automaticRefresh()) { this.refresh(); }
    }

    public debugSessionStarted(session: vscode.DebugSession) {
        if (!this.sessions.has(session.id)) {
            this.sessions.set(session.id, { session, available: false, enabled: true, running: false });
        }
        this.selectSession();
        session.customRequest('get-live-watch-state').then((state) => {
            this.liveStateChanged(session, !!state.available);
        }, () => { /* Readiness is also delivered by the adapter event. */ });
    }

    public liveStateChanged(session: vscode.DebugSession, available: boolean) {
        const state = this.sessions.get(session.id);
        if (!state || this.disposed) { return; }
        state.available = available;
        if (this.active !== state) { return; }
        this.invalidate();
        this.updateState();
        if (!available) {
            this.model.reset();
            this.fire();
        } else if (this.automaticRefresh()) {
            this.refresh();
        }
    }

    public debugSessionTerminated(session: vscode.DebugSession) {
        const state = this.sessions.get(session.id);
        this.sessions.delete(session.id);
        if (this.active === state) {
            this.invalidate();
            this.active = undefined;
            this.model.reset();
            this.updateState();
            this.fire();
        }
    }

    public debugStopped(session: vscode.DebugSession) {
        this.setRunning(session, false);
    }

    public debugContinued(session: vscode.DebugSession) {
        this.setRunning(session, true);
    }

    private setRunning(session: vscode.DebugSession, running: boolean) {
        const state = this.sessions.get(session.id);
        if (!state) { return; }
        state.running = running;
        if (this.active === state) {
            this.invalidate();
            this.updateState();
            if (this.automaticRefresh()) { this.refresh(); }
        }
    }

    public setEnabled(enabled: boolean) {
        if (!this.active) { return; }
        this.active.enabled = enabled;
        this.invalidate();
        this.updateState();
        if (enabled) { this.refresh(); }
    }

    // One polling loop; all expression and child reads finish before the next pass.
    public refresh(_session?: vscode.DebugSession): void {
        if (this.disposed || !this.visible || !this.active?.available || (!this.model.roots.length && !this.cacheDirty)) {
            this.fire();
            return;
        }
        if (this.refreshing) {
            this.pending = true;
            return;
        }
        this.invalidate();
        const revision = this.revision;
        const state = this.active;
        const valid = () => !this.disposed && revision === this.revision && state === this.active;
        this.refreshing = true;
        const start = Date.now();
        const clearCache = this.cacheDirty;
        this.cacheDirty = false;
        const read = async () => {
            if (clearCache) {
                await state.session.customRequest('liveCacheRefresh', { deleteAll: true });
            }
            if (valid()) { await this.model.refresh(state.session, valid); }
            if (valid() && this.refreshFailed) {
                this.refreshFailed = false;
                this.updateState();
            }
        };
        read().catch((error) => {
            if (valid()) {
                this.cacheDirty = true;
                this.refreshFailed = true;
                if (this.view) { this.view.message = `Live Watch refresh failed: ${String(error)}`; }
            }
        }).finally(() => {
            this.refreshing = false;
            if (valid()) { this.fire(); }
            if (this.disposed) { return; }
            if (this.pending) {
                this.pending = false;
                this.refresh();
            } else if (valid() && this.visible && state.enabled && state.running && this.model.roots.length) {
                const config = vscode.workspace.getConfiguration('cortex-debug');
                const interval = liveWatchRefreshInterval(
                    state.session.configuration.liveWatch?.samplesPerSecond,
                    config.get<number>('liveWatchRefreshRate', 300));
                this.timer = setTimeout(() => {
                    this.timer = undefined;
                    this.refresh();
                }, Math.max(0, interval - (Date.now() - start)));
            }
        });
    }

    private changed() {
        this.invalidate();
        this.cacheDirty = true;
        this.saveState();
        this.updateState();
        this.fire();
        if (this.automaticRefresh()) { this.refresh(); }
    }

    public addWatchExpr(expression: string, _session?: vscode.DebugSession) {
        if (this.model.add(expression)) { this.changed(); }
    }

    public removeWatchExpr(node: LiveWatchNode) {
        if (this.model.remove(node)) { this.changed(); }
    }

    public removeAll() {
        this.model.roots = [];
        this.changed();
    }

    public setFormat(node: LiveWatchNode, format?: LiveWatchFormat) {
        if (!this.model.setFormat(node, format)) { return; }
        this.invalidate();
        this.saveState();
        this.fire();
        // A format choice is an explicit one-shot read even with live updates off.
        this.refresh();
    }

    public async editNode(node: LiveWatchNode) {
        if (!this.model.roots.includes(node)) { return; }
        const value = await vscode.window.showInputBox({
            value: node.expression, prompt: 'Watch expression (global/static scope)', ignoreFocusOut: true,
            validateInput: (expression) => !expression.trim()
                ? 'Enter an expression'
                : this.model.roots.some((other) => other !== node && other.expression === expression.trim())
                    ? 'This expression is already watched'
                    : undefined
        });
        if (value !== undefined && this.model.edit(node, value)) { this.changed(); }
    }

    public moveUpNode(node: LiveWatchNode) {
        if (this.model.move(node, -1)) { this.changed(); }
    }

    public moveDownNode(node: LiveWatchNode) {
        if (this.model.move(node, 1)) { this.changed(); }
    }

    public expandChildren(node: LiveWatchNode) {
        node.expanded = true;
        this.saveState();
        if (this.automaticRefresh()) { this.refresh(); }
    }

    public fire() {
        if (!this.disposed) { this.changes.fire(undefined); }
    }

    public getTreeItem(node: LiveWatchNode): vscode.TreeItem {
        const label = `${node.name}: ${node.value}`;
        const item = new vscode.TreeItem({
            label,
            highlights: node.changed ? [[node.name.length + 2, label.length]] : undefined
        }, node.reference || node.children.length
            ? node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.contextValue = node.parent ? 'field' : 'expression';
        item.description = node.format;
        item.tooltip = `${node.expression}\n${node.type}\n${node.value}`;
        item.accessibilityInformation = { label, role: 'treeitem' };
        return item;
    }

    public handleDrag(source: readonly LiveWatchNode[], transfer: vscode.DataTransfer) {
        transfer.set(this.dragMimeTypes[0], new vscode.DataTransferItem(source.filter((node) => this.model.roots.includes(node))));
    }

    public handleDrop(target: LiveWatchNode | undefined, transfer: vscode.DataTransfer) {
        const source = transfer.get(this.dragMimeTypes[0])?.value as LiveWatchNode[] | undefined;
        if (!Array.isArray(source) || !source.length || (target && !this.model.roots.includes(target)) || source.includes(target)) { return; }
        const nodes = source.filter((node) => this.model.roots.includes(node));
        if (!nodes.length) { return; }
        const remaining = this.model.roots.filter((node) => !nodes.includes(node));
        remaining.splice(target ? remaining.indexOf(target) : remaining.length, 0, ...nodes);
        this.model.roots = remaining;
        this.changed();
    }

    public getChildren(node?: LiveWatchNode): LiveWatchNode[] {
        return node ? node.children : this.model.roots;
    }

    public getParent(node: LiveWatchNode): LiveWatchNode | undefined {
        return node.parent;
    }
}
