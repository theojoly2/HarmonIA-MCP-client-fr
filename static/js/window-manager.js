/**
 * WindowManager
 * Gère les apps dans trois modes : tab (plein écran shell), float (fenêtre flottante), split (panneau).
 */

class WindowManager {
    constructor(shellElement, splitManager, options = {}) {
        this.shellElement = shellElement;
        this.splitManager = splitManager;
        this.floatingRoot = document.createElement('div');
        this.floatingRoot.id = 'floating-root';
        document.body.appendChild(this.floatingRoot);
        this.floatWindows = new Map(); // instanceId -> { win, body, setTitle }
        this.activeFloat = null;
        this.options = options;
    }

    open(appId, props = {}) {
        const AppClass = AppState.getRecord ? null : null; // not used directly
        const { instanceId, instance } = AppState.createInstance(appId, props);
        const mode = props.mode || 'tab';
        instance.setTitle(instance.getTitle());

        if (mode === 'tab') {
            this._mountTab(instance);
        } else if (mode === 'float') {
            this._mountFloating(instance, props);
        } else if (mode === 'split') {
            this._mountSplit(instance, props);
        }
        AppState.setActiveInstance(instanceId);
        return instanceId;
    }

    _mountTab(instance) {
        AppState.saveInstanceState(instance.instanceId);
        this.shellElement.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'app-container h-full w-full';
        container.dataset.instanceId = instance.instanceId;
        this.shellElement.appendChild(container);
        instance.mount(container);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                AppState.restoreInstanceState(instance.instanceId);
            });
        });
    }

    _mountFloating(instance, props) {
        AppState.saveInstanceState(instance.instanceId);
        const { width = 800, height = 600, offsetX = 0, offsetY = 0 } = props;
        const floatWin = UiUtils.createFloatingWindow({
            title: instance.getTitle(),
            icon: instance.constructor.iconSvg,
            width,
            height,
            onClose: () => this.close(instance.instanceId),
            onFocus: () => this._bringToFront(instance.instanceId),
        });
        this.floatingRoot.appendChild(floatWin.win);
        const body = floatWin.body;
        body.dataset.instanceId = instance.instanceId;
        // Position and force layout so the body has its final size before mounting the app.
        UiUtils.centerWindow(floatWin.win, offsetX, offsetY);
        void floatWin.win.offsetHeight;
        instance.mount(body);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => AppState.restoreInstanceState(instance.instanceId));
        });
        this.floatWindows.set(instance.instanceId, floatWin);
        this._bringToFront(instance.instanceId);
    }

    _mountSplit(instance, props) {
        AppState.saveInstanceState(instance.instanceId);
        const { targetInstanceId, direction = 'horizontal' } = props;
        let tree = this.splitManager.tree;
        if (!tree) {
            tree = { type: 'pane', instanceId: instance.instanceId };
            this.splitManager.setTree(tree);
            this.splitManager.registerRenderer(instance.instanceId, (pane) => instance.mount(pane));
            AppState.restoreInstanceState(instance.instanceId);
            return;
        }
        if (targetInstanceId) {
            this.splitManager.splitLeaf(targetInstanceId, direction, { type: 'pane', instanceId: instance.instanceId });
        } else {
            // split active or first leaf
            const leaves = this._collectLeaves(tree);
            const target = leaves.find(l => l.instanceId === AppState.getActiveInstance()) || leaves[0];
            if (target) {
                this.splitManager.splitLeaf(target.instanceId, direction, { type: 'pane', instanceId: instance.instanceId });
            }
        }
        this.splitManager.registerRenderer(instance.instanceId, (pane) => {
            instance.mount(pane);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => AppState.restoreInstanceState(instance.instanceId));
            });
        });
        this.splitManager.render();
    }

    _collectLeaves(node, out = []) {
        if (!node) return out;
        if (node.type === 'pane') {
            if (node.instanceId) out.push(node);
            return out;
        }
        (node.children || []).forEach(c => this._collectLeaves(c, out));
        return out;
    }

    _bringToFront(instanceId) {
        const floatWin = this.floatWindows.get(instanceId);
        if (!floatWin) return;
        this.floatWindows.forEach(fw => fw.win.classList.remove('active'));
        floatWin.win.classList.add('active');
        this.activeFloat = instanceId;
        AppState.setActiveInstance(instanceId);
    }

    updateTitle(instanceId, title) {
        const instance = AppState.getInstance(instanceId);
        if (instance) instance.setTitle(title);
        const floatWin = this.floatWindows.get(instanceId);
        if (floatWin) floatWin.setTitle(title);
    }

    close(instanceId) {
        AppState.saveInstanceState(instanceId);
        const record = AppState.getRecord(instanceId);
        if (record && record.mode === 'split') {
            this.splitManager.unregisterRenderer(instanceId);
            this.splitManager.removeLeaf(instanceId);
        }
        const floatWin = this.floatWindows.get(instanceId);
        if (floatWin) {
            floatWin.win.remove();
            this.floatWindows.delete(instanceId);
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this.shellElement.innerHTML = '';
        }
        AppState.removeInstance(instanceId);
    }

    switchTab(instanceId) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);
        if (record) record.mode = 'tab';
        this.shellElement.innerHTML = '';
        AppState.saveInstanceState(instanceId);
        this._mountTab(instance);
        AppState.setActiveInstance(instanceId);
    }


    moveToFloat(instanceId, props = {}) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);
        if (record && record.mode === 'split') {
            this.splitManager.unregisterRenderer(instanceId);
            this.splitManager.removeLeaf(instanceId);
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this.shellElement.innerHTML = '';
        }
        record.mode = 'float';
        this._mountFloating(instance, props);
    }

    moveToSplit(instanceId, props = {}) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);
        if (record.mode === 'float') {
            const floatWin = this.floatWindows.get(instanceId);
            if (floatWin) {
                floatWin.win.remove();
                this.floatWindows.delete(instanceId);
            }
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this.shellElement.innerHTML = '';
        }
        record.mode = 'split';
        this._mountSplit(instance, props);
    }

    renderSplit() {
        this.splitManager.render();
    }
}

window.WindowManager = WindowManager;
