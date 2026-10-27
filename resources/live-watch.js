(() => {
    const vscode = acquireVsCodeApi();
    const tree = document.getElementById('watch');
    const status = document.getElementById('status');
    let nodes = [];
    let visible = [];
    let selected;
    let editor;
    let request = 0;
    let dragging = false;

    function send(type, extra = {}) {
        vscode.postMessage({ type, ...extra });
    }

    function select(id) {
        selected = id;
        for (const row of tree.querySelectorAll('.row')) {
            const active = row.dataset.id === id;
            row.classList.toggle('selected', active);
            row.setAttribute('aria-selected', String(active));
        }
        if (id) {
            tree.setAttribute('aria-activedescendant', `row-${id}`);
        } else {
            tree.removeAttribute('aria-activedescendant');
        }
        send('select', { id });
    }

    function finishEditing() {
        editor = undefined;
        render();
        tree.focus();
    }

    function submit() {
        if (!editor || editor.pending) { return; }
        const expression = editor.input.value.trim();
        if (!expression && !editor.id) {
            finishEditing();
            return;
        }
        editor.pending = true;
        editor.request = ++request;
        editor.input.readOnly = true;
        send('commit', { id: editor.id, expression, request });
    }

    function beginEdit(id, expression = '') {
        if (editor) {
            editor.input.focus();
            return;
        }
        const node = visible.find((entry) => entry.node.id === id)?.node;
        if (id && (!node || !node.root)) { return; }
        let row = id ? document.getElementById(`row-${id}`) : undefined;
        if (!row) {
            tree.querySelector('.empty')?.remove();
            row = document.createElement('div');
            row.className = 'row';
            tree.append(row);
        }
        row.classList.add('editing');
        row.replaceChildren();
        const container = document.createElement('div');
        container.className = 'editor';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = id ? node.expression : expression;
        input.placeholder = 'Expression to watch';
        input.setAttribute('aria-label', id ? 'Edit watch expression' : 'New watch expression');
        input.autocomplete = 'off';
        input.spellcheck = false;
        const error = document.createElement('div');
        error.className = 'error';
        error.id = 'expression-error';
        error.setAttribute('role', 'alert');
        input.setAttribute('aria-describedby', error.id);
        container.append(input, error);
        row.append(container);
        editor = { id, input, error, pending: false };
        input.addEventListener('keydown', (event) => {
            if (event.isComposing) { return; }
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                submit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finishEditing();
            }
        });
        input.addEventListener('blur', () => {
            if (editor?.input === input) { submit(); }
        });
        input.addEventListener('input', () => {
            error.textContent = '';
            input.removeAttribute('aria-invalid');
        });
        row.scrollIntoView({ block: 'nearest' });
        input.focus();
        input.select();
    }

    function toggle(node) {
        if (node.hasChildren) { send(node.expanded ? 'collapse' : 'expand', { id: node.id }); }
    }

    function appendNode(node, depth) {
        visible.push({ node, depth });
        const row = document.createElement('div');
        row.className = 'row';
        row.id = `row-${node.id}`;
        row.dataset.id = node.id;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-label', `${node.name}: ${node.value}`);
        row.title = `${node.expression}\n${node.type || ''}\n${node.value}`;
        row.style.paddingLeft = `${8 + depth * 16}px`;
        row.setAttribute('data-vscode-context', JSON.stringify({
            webviewSection: 'liveWatch', liveWatchNodeId: node.id,
            liveWatchRoot: node.root, preventDefaultContextMenuItems: true
        }));
        if (node.hasChildren) { row.setAttribute('aria-expanded', String(node.expanded)); }
        const twisty = document.createElement('button');
        twisty.className = `twisty${node.expanded ? ' expanded' : ''}`;
        twisty.textContent = node.hasChildren ? '›' : '';
        twisty.tabIndex = -1;
        twisty.setAttribute('aria-label', node.expanded ? 'Collapse' : 'Expand');
        twisty.disabled = !node.hasChildren;
        twisty.addEventListener('click', (event) => {
            event.stopPropagation();
            select(node.id);
            toggle(node);
            tree.focus();
        });
        const text = document.createElement('div');
        text.className = 'text';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${node.name}: `;
        const value = document.createElement('span');
        value.className = `value${node.changed ? ' changed' : ''}`;
        value.textContent = node.value;
        text.append(name, value);
        row.append(twisty, text);
        if (node.format) {
            const format = document.createElement('span');
            format.className = 'format';
            format.textContent = node.format;
            row.append(format);
        }
        if (node.root) {
            const remove = document.createElement('button');
            remove.className = 'remove';
            remove.textContent = '×';
            remove.title = 'Remove Expression (Delete)';
            remove.setAttribute('aria-label', `Remove ${node.name}`);
            remove.tabIndex = -1;
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                send('remove', { id: node.id });
                tree.focus();
            });
            row.append(remove);
            row.draggable = true;
            row.addEventListener('dragstart', (event) => {
                if (editor) {
                    event.preventDefault();
                    return;
                }
                event.dataTransfer.setData('application/x-cortex-livewatch', node.id);
                event.dataTransfer.effectAllowed = 'move';
                dragging = true;
            });
            row.addEventListener('dragend', () => {
                dragging = false;
                render();
            });
            row.addEventListener('dragover', (event) => {
                if (!event.dataTransfer.types.includes('application/x-cortex-livewatch')) { return; }
                event.preventDefault();
                row.classList.add('drop-target');
            });
            row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
            row.addEventListener('drop', (event) => {
                event.preventDefault();
                event.stopPropagation();
                row.classList.remove('drop-target');
                send('reorder', { id: event.dataTransfer.getData('application/x-cortex-livewatch'), target: node.id });
            });
        }
        row.addEventListener('click', () => {
            if (editor) { return; }
            select(node.id);
            tree.focus();
        });
        row.addEventListener('contextmenu', () => select(node.id));
        row.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            if (node.root) {
                beginEdit(node.id);
            } else {
                toggle(node);
            }
        });
        tree.append(row);
        if (node.expanded) { node.children.forEach((child) => appendNode(child, depth + 1)); }
    }

    function render() {
        // Polling must not replace a focused input, its draft text, or its validation message.
        if (editor || dragging) { return; }
        const next = [];
        const collect = (items, depth) => {
            for (const node of items) {
                next.push({ node, depth });
                if (node.expanded) { collect(node.children, depth + 1); }
            }
        };
        collect(nodes, 0);
        const sameStructure = !tree.querySelector('.editing') && next.length > 0 && next.length === visible.length && next.every((entry, index) => {
            const old = visible[index];
            return entry.node.id === old.node.id && entry.depth === old.depth && entry.node.expanded === old.node.expanded
                && entry.node.hasChildren === old.node.hasChildren && entry.node.format === old.node.format;
        });
        if (sameStructure) {
            // Keep row elements alive across value-only updates so polling cannot break double-clicks.
            visible = next;
            for (const { node } of next) {
                const row = document.getElementById(`row-${node.id}`);
                row.querySelector('.name').textContent = `${node.name}: `;
                const value = row.querySelector('.value');
                value.textContent = node.value;
                value.classList.toggle('changed', !!node.changed);
                row.title = `${node.expression}\n${node.type || ''}\n${node.value}`;
                row.setAttribute('aria-label', `${node.name}: ${node.value}`);
            }
            return;
        }
        visible = [];
        tree.replaceChildren();
        nodes.forEach((node) => appendNode(node, 0));
        if (!nodes.length) {
            const empty = document.createElement('button');
            empty.className = 'empty';
            empty.textContent = 'Add Expression';
            empty.addEventListener('click', () => beginEdit());
            tree.append(empty);
        }
        if (!visible.some((entry) => entry.node.id === selected)) { selected = visible[0]?.node.id; }
        select(selected);
    }

    tree.addEventListener('keydown', (event) => {
        if (editor || event.isComposing) { return; }
        const index = visible.findIndex((entry) => entry.node.id === selected);
        const node = visible[index]?.node;
        switch (event.key) {
            case 'F2':
                if (node?.root) { beginEdit(node.id); }
                break;
            case 'Delete':
                if (node?.root) { send('remove', { id: node.id }); }
                break;
            case 'ArrowDown':
            case 'ArrowUp': {
                const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
                if (next) {
                    select(next.node.id);
                    document.getElementById(`row-${next.node.id}`)?.scrollIntoView({ block: 'nearest' });
                }
                break;
            }
            case 'ArrowRight':
                if (node?.hasChildren && !node.expanded) {
                    toggle(node);
                } else if (node?.expanded && visible[index + 1]?.depth > visible[index].depth) {
                    select(visible[index + 1].node.id);
                }
                break;
            case 'ArrowLeft':
                if (node?.expanded) {
                    toggle(node);
                } else if (visible[index]?.depth > 0) {
                    const parent = visible.slice(0, index).reverse().find((entry) => entry.depth === visible[index].depth - 1);
                    if (parent) { select(parent.node.id); }
                }
                break;
            case 'Enter':
                if (node?.root) {
                    beginEdit(node.id);
                } else if (!node) {
                    beginEdit();
                }
                break;
            default:
                return;
        }
        event.preventDefault();
    });
    tree.addEventListener('dblclick', (event) => {
        if (event.target === tree) { beginEdit(); }
    });
    tree.addEventListener('dragover', (event) => {
        if (event.dataTransfer.types.includes('application/x-cortex-livewatch')) { event.preventDefault(); }
    });
    tree.addEventListener('drop', (event) => {
        event.preventDefault();
        send('reorder', { id: event.dataTransfer.getData('application/x-cortex-livewatch') });
    });
    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'state') {
            nodes = message.nodes;
            status.textContent = message.status;
            render();
        } else if (message.type === 'edit') {
            beginEdit(message.id, message.expression);
        } else if (message.type === 'editResult' && editor?.request === message.request) {
            if (message.error) {
                editor.pending = false;
                editor.input.readOnly = false;
                editor.error.textContent = message.error;
                editor.input.setAttribute('aria-invalid', 'true');
                editor.input.focus();
            } else {
                selected = message.id;
                finishEditing();
            }
        }
    });
    send('ready');
})();
