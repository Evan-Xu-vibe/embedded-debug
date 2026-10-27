import { DebugProtocol } from '@vscode/debugprotocol';
import { isLiveWatchFormat, LiveWatchFormat } from '../live-watch-format';

export interface LiveWatchClient {
    customRequest(command: string, args?: any): Thenable<any>;
}

export interface SavedWatchNode {
    name: string;
    expr: string;
    expanded: boolean;
    children: SavedWatchNode[];
    format?: LiveWatchFormat;
}

let nextId = 0;

export class LiveWatchNode {
    public readonly id = `live-watch-${++nextId}`;
    public value = 'not available';
    public type = '';
    public reference = 0;
    public expanded = false;
    public changed = false;
    public children: LiveWatchNode[] = [];
    public format: LiveWatchFormat | undefined;

    constructor(public name: string, public expression: string, public parent?: LiveWatchNode) { }

    public reset() {
        this.value = 'not available';
        this.type = '';
        this.reference = 0;
        this.changed = false;
        this.children.forEach((child) => child.reset());
    }

    public save(): SavedWatchNode {
        return {
            name: this.name, expr: this.expression, expanded: this.expanded, format: this.format,
            children: this.children.map((child) => child.save())
        };
    }

    public static restore(saved: SavedWatchNode, parent?: LiveWatchNode): LiveWatchNode {
        const node = new LiveWatchNode(saved.name, saved.expr, parent);
        node.expanded = !!saved.expanded;
        node.format = isLiveWatchFormat(saved.format) ? saved.format : undefined;
        node.children = (saved.children || []).map((child) => LiveWatchNode.restore(child, node));
        return node;
    }
}

// No UI dependencies: request ordering and stale responses can be tested directly.
export class LiveWatchModel {
    public roots: LiveWatchNode[] = [];

    public add(expression: string): LiveWatchNode | undefined {
        expression = expression.trim();
        if (!expression || this.roots.some((node) => node.expression === expression)) { return undefined; }
        const node = new LiveWatchNode(expression, expression);
        this.roots.push(node);
        return node;
    }

    public edit(node: LiveWatchNode, expression: string): boolean {
        expression = expression.trim();
        if (!this.roots.includes(node) || !expression || this.roots.some((n) => n !== node && n.expression === expression)) { return false; }
        node.name = node.expression = expression;
        node.children = [];
        node.reset();
        return true;
    }

    public remove(node: LiveWatchNode): boolean {
        const index = this.roots.indexOf(node);
        if (index < 0) { return false; }
        this.roots.splice(index, 1);
        return true;
    }

    public move(node: LiveWatchNode, offset: number): boolean {
        const index = this.roots.indexOf(node);
        const next = index + offset;
        if (index < 0 || next < 0 || next >= this.roots.length) { return false; }
        this.roots.splice(index, 1);
        this.roots.splice(next, 0, node);
        return true;
    }

    public reset() {
        this.roots.forEach((node) => node.reset());
    }

    public setFormat(node: LiveWatchNode, format?: LiveWatchFormat): boolean {
        const contains = (nodes: LiveWatchNode[]): boolean => nodes.some((entry) => entry === node || contains(entry.children));
        if ((format !== undefined && !isLiveWatchFormat(format)) || !contains(this.roots)) { return false; }
        node.format = format;
        return true;
    }

    public restore(saved: SavedWatchNode) {
        this.roots = (saved.children || []).filter((node) => typeof node.expr === 'string' && node.expr.trim())
            .map((node) => LiveWatchNode.restore(node));
    }

    public save(): SavedWatchNode {
        return { name: '', expr: '', expanded: true, children: this.roots.map((node) => node.save()) };
    }

    private setValue(node: LiveWatchNode, value: string, type: string, reference: number) {
        node.changed = node.value !== 'not available' && node.value !== value;
        node.value = value;
        node.type = type || '';
        node.reference = reference || 0;
        if (!node.reference) { node.children = []; }
    }

    private async refreshChildren(node: LiveWatchNode, client: LiveWatchClient, valid: () => boolean): Promise<void> {
        if (!valid() || !node.expanded || !node.reference) { return; }
        try {
            const liveWatchFormats = Object.fromEntries(node.children.filter((child) => child.format)
                .map((child) => [child.name, child.format]));
            const response = await client.customRequest('liveVariables', { variablesReference: node.reference, liveWatchFormats });
            if (!valid()) { return; }
            const previous = new Map(node.children.map((child) => [child.name, child]));
            node.children = (response?.variables || []).map((variable: DebugProtocol.Variable) => {
                const child = previous.get(variable.name) || new LiveWatchNode(variable.name, variable.name, node);
                child.expression = variable.evaluateName || variable.name;
                this.setValue(child, variable.value, variable.type, variable.variablesReference);
                return child;
            });
            for (const child of node.children) {
                await this.refreshChildren(child, client, valid);
            }
        } catch (error) {
            if (valid()) { node.children = []; }
        }
    }

    public async refresh(client: LiveWatchClient, valid: () => boolean): Promise<void> {
        for (const node of [...this.roots]) {
            if (!valid()) { return; }
            try {
                const result = await client.customRequest('liveEvaluate', {
                    expression: node.expression, context: 'watch', liveWatchFormat: node.format
                });
                if (!valid()) { return; }
                this.setValue(node, result?.result ?? 'not available', result?.type, result?.variablesReference);
                await this.refreshChildren(node, client, valid);
            } catch (error) {
                if (!valid()) { return; }
                this.setValue(node, `<${String(error)}>`, '', 0);
            }
        }
    }
}
