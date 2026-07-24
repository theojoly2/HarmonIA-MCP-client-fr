/**
 * SplitManager
 * Gère un arbre récursif de panneaux.
 * Chaque feuille contient une instance d'app.
 */

class SplitManager {
    constructor(rootElement, options = {}) {
        this.rootElement = rootElement;
        this.tree = null;
        this.onEmpty = options.onEmpty || (() => {});
        this.renderers = new Map();
    }

    setTree(tree) {
        this.tree = tree;
        this.render();
    }

    render() {
        this.rootElement.innerHTML = '';
        if (!this.tree) return;
        const node = this._renderNode(this.tree);
        if (node) this.rootElement.appendChild(node);
        if (this._countLeaves(this.tree) === 0) this.onEmpty();
    }

    _countLeaves(node) {
        if (!node) return 0;
        if (node.type === 'pane') return node.instanceId ? 1 : 0;
        return (node.children || []).reduce((sum, c) => sum + this._countLeaves(c), 0);
    }

    _renderNode(node) {
        if (!node) return null;
        if (node.type === 'pane') {
            const pane = document.createElement('div');
            pane.className = 'split-pane flex-1 h-full overflow-hidden relative';
            pane.dataset.instanceId = node.instanceId || '';
            const renderFn = this.renderers.get(node.instanceId);
            if (renderFn) renderFn(pane);
            return pane;
        }
        if (node.type === 'split') {
            const container = document.createElement('div');
            container.className = `split-node flex h-full w-full ${node.direction === 'vertical' ? 'flex-col' : 'flex-row'}`;
            const children = (node.children || []).map(c => this._renderNode(c)).filter(Boolean);
            if (children.length === 0) return null;
            if (children.length === 1) return children[0];
            children.forEach((child, i) => {
                child.style.flex = `1 1 ${(node.ratios || [])[i] || 100 / children.length}%`;
                container.appendChild(child);
                if (i < children.length - 1) {
                    const resizer = document.createElement('div');
                    resizer.className = `split-resizer ${node.direction === 'vertical' ? 'split-resizer-h' : 'split-resizer-v'}`;
                    this._attachResizer(resizer, container, child, children[i + 1], node, i);
                    container.appendChild(resizer);
                }
            });
            return container;
        }
        return null;
    }

    _attachResizer(resizer, container, before, after, node, index) {
        let isResizing = false;
        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = node.direction === 'vertical' ? 'row-resize' : 'col-resize';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const rect = container.getBoundingClientRect();
            let ratio;
            if (node.direction === 'vertical') {
                ratio = ((e.clientY - rect.top) / rect.height) * 100;
            } else {
                ratio = ((e.clientX - rect.left) / rect.width) * 100;
            }
            ratio = Math.max(10, Math.min(90, ratio));
            node.ratios = node.ratios || childrenRatios(node.children || []);
            node.ratios[index] = ratio;
            node.ratios[index + 1] = 100 - ratio;
            const total = node.ratios.reduce((a, b) => a + b, 0);
            if (total > 0) node.ratios = node.ratios.map(r => (r / total) * 100);
            before.style.flex = `1 1 ${node.ratios[index]}%`;
            after.style.flex = `1 1 ${node.ratios[index + 1]}%`;
        });
        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
            }
        });
    }

    replaceLeaf(targetInstanceId, newNode) {
        this.tree = this._replaceLeaf(this.tree, targetInstanceId, newNode);
        this.render();
    }

    _replaceLeaf(node, targetInstanceId, newNode) {
        if (!node) return null;
        if (node.type === 'pane') {
            if (node.instanceId === targetInstanceId) return newNode;
            return node;
        }
        if (node.type === 'split') {
            node.children = (node.children || []).map(c => this._replaceLeaf(c, targetInstanceId, newNode)).filter(Boolean);
            if (node.children.length === 0) return null;
            if (node.children.length === 1) return node.children[0];
            return node;
        }
        return node;
    }

    removeLeaf(instanceId) {
        this.tree = this._removeLeaf(this.tree, instanceId);
        this.render();
    }

    _removeLeaf(node, instanceId) {
        if (!node) return null;
        if (node.type === 'pane') {
            return node.instanceId === instanceId ? null : node;
        }
        if (node.type === 'split') {
            node.children = (node.children || []).map(c => this._removeLeaf(c, instanceId)).filter(Boolean);
            if (node.children.length === 0) return null;
            if (node.children.length === 1) return node.children[0];
            return node;
        }
        return node;
    }

    splitLeaf(instanceId, direction, newLeafNode) {
        this.tree = this._splitLeaf(this.tree, instanceId, direction, newLeafNode);
        this.render();
    }

    _splitLeaf(node, instanceId, direction, newLeafNode) {
        if (!node) return null;
        if (node.type === 'pane' && node.instanceId === instanceId) {
            return {
                type: 'split',
                direction,
                children: [node, newLeafNode],
                ratios: [50, 50],
            };
        }
        if (node.type === 'split') {
            node.children = (node.children || []).map(c => this._splitLeaf(c, instanceId, direction, newLeafNode));
            return node;
        }
        return node;
    }

    registerRenderer(instanceId, fn) {
        this.renderers.set(instanceId, fn);
    }

    unregisterRenderer(instanceId) {
        this.renderers.delete(instanceId);
    }
}

function childrenRatios(children) {
    return children.map(() => 100 / children.length);
}

window.SplitManager = SplitManager;
