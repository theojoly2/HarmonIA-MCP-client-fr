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
        this.floatWindows = new Map(); // instanceId -> { win, body, setTitle, savedRect, minimized }
        this.activeFloat = null;
        this.options = options;
        this._viewportHandler = () => this._clampAllFloating();
        window.addEventListener('resize', this._viewportHandler);
        this._outsideClickHandler = (e) => this._onOutsideClick(e);
        document.addEventListener('mousedown', this._outsideClickHandler);
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

    async _mountTab(instance) {
        AppState.saveInstanceState(instance.instanceId);
        this.shellElement.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'app-container h-full w-full';
        container.dataset.instanceId = instance.instanceId;
        this.shellElement.appendChild(container);
        await instance.mount(container);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                AppState.restoreInstanceState(instance.instanceId);
            });
        });
    }

    async _mountFloating(instance, props) {
        AppState.saveInstanceState(instance.instanceId);
        const { width = 800, height = 600, offsetX = 0, offsetY = 0 } = props;
        let resizeAnchorSaved = false;
        const floatWin = UiUtils.createFloatingWindow({
            title: instance.getTitle(),
            icon: instance.constructor.iconSvg,
            width,
            height,
            onClose: () => this.close(instance.instanceId),
            onFocus: () => this._bringToFront(instance.instanceId),
            onResizeStart: () => {
                if (instance.viewer && instance.viewer.saveResizeAnchor) {
                    instance.viewer.saveResizeAnchor();
                    resizeAnchorSaved = true;
                }
            },
            onResize: () => {
                if (resizeAnchorSaved && instance.viewer && instance.viewer.restoreResizeAnchor) {
                    instance.viewer.restoreResizeAnchor();
                }
            },
            onResizeEnd: () => {
                if (resizeAnchorSaved && instance.viewer && instance.viewer.restoreResizeAnchor) {
                    instance.viewer.restoreResizeAnchor();
                }
                resizeAnchorSaved = false;
            },
        });
        this.floatingRoot.appendChild(floatWin.win);
        const body = floatWin.body;
        body.dataset.instanceId = instance.instanceId;
        // Position and force layout so the body has its final size before mounting the app.
        UiUtils.centerWindow(floatWin.win, offsetX, offsetY);
        void floatWin.win.offsetHeight;
        await instance.mount(body);
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
        this.splitManager.registerRenderer(instance.instanceId, async (pane) => {
            await instance.mount(pane);
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

    _clampAllFloating() {
        this.floatWindows.forEach((fw) => {
            UiUtils.clampWindowPosition(fw.win);
            UiUtils.clampWindowSize(fw.win, { minWidth: 320, minHeight: 200, minVisible: 60 });
        });
    }

    _onOutsideClick(e) {
        // Ignore if there are no floating windows.
        if (this.floatWindows.size === 0) return;
        // Ignore clicks inside any floating window or inside the shell header/tab bar.
        const target = e.target;
        if (target.closest('.floating-window')) return;
        if (target.closest('#shell-header') || target.closest('#shell-tabs')) return;
        // Minimize all floating windows.
        this.floatWindows.forEach((_, instanceId) => this._minimizeFloat(instanceId));
    }

    _minimizeFloat(instanceId) {
        const fw = this.floatWindows.get(instanceId);
        if (!fw || fw.minimized) return;
        const rect = fw.win.getBoundingClientRect();
        fw.savedRect = {
            left: parseFloat(fw.win.style.left) || rect.left,
            top: parseFloat(fw.win.style.top) || rect.top,
            width: parseFloat(fw.win.style.width) || rect.width,
            height: parseFloat(fw.win.style.height) || rect.height,
        };
        fw.minimized = true;
        fw.win.classList.add('minimized');
        // Slide the window straight down, keeping its width and horizontal position.
        const vh = window.innerHeight;
        const minVisible = 30;
        const targetTop = vh - minVisible;
        fw.win.style.transition = 'top 0.45s cubic-bezier(0.4, 0, 0.2, 1), height 0.45s ease';
        fw.win.style.top = targetTop + 'px';
        fw.win.style.height = minVisible + 'px';
        fw.win.querySelector('.window-body').style.opacity = '0';
    }

    _restoreFloat(instanceId) {
        const fw = this.floatWindows.get(instanceId);
        if (!fw || !fw.minimized) return;
        const saved = fw.savedRect;
        if (!saved) return;
        fw.win.classList.remove('minimized');
        fw.win.style.transition = 'top 0.45s cubic-bezier(0.4, 0, 0.2, 1), left 0.45s ease, width 0.45s ease, height 0.45s ease';
        fw.win.style.left = saved.left + 'px';
        fw.win.style.top = saved.top + 'px';
        fw.win.style.width = saved.width + 'px';
        fw.win.style.height = saved.height + 'px';
        fw.win.querySelector('.window-body').style.opacity = '1';
        fw.minimized = false;
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
        if (this.floatWindows.size === 0) {
            window.removeEventListener('resize', this._viewportHandler);
            document.removeEventListener('mousedown', this._outsideClickHandler);
        }
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
