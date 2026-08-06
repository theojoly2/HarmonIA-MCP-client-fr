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
        this._viewportHandler = () => this._clampAllFloating();
        this._splitResizeObserver = null;
        this._lastShellSize = null;
        window.addEventListener('resize', this._viewportHandler);
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
        return new Promise(async (resolve) => {
            await instance.mount(container);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    AppState.restoreInstanceState(instance.instanceId);
                    resolve();
                });
            });
        });
    }

    _mountFloating(instance, props) {
        AppState.saveInstanceState(instance.instanceId);
        const { width = 800, height = 600, offsetX = 0, offsetY = 0 } = props;
        let resizeAnchorSaved = false;
        const floatWin = UiUtils.createFloatingWindow({
            title: instance.getTitle(),
            fileName: instance.fileName || instance.docName || '',
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
        return new Promise(async (resolve) => {
            await instance.mount(body);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    AppState.restoreInstanceState(instance.instanceId);
                    resolve();
                });
            });
            this.floatWindows.set(instance.instanceId, floatWin);
            this._bringToFront(instance.instanceId);
        });
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
            return Promise.resolve();
        }

        // When a modeler tab asks for an assistant split panel, we want the
        // current modeler pane to stay exactly where it is and a new assistant
        // pane to appear on the right. If the modeler is currently the only
        // tab in the shell, we create a split root around it; otherwise we split
        // the modeler's pane directly.
        const targetIsCurrentTab = targetInstanceId &&
            this.shellElement.querySelector(`[data-instance-id="${targetInstanceId}"]`);
        if (targetInstanceId && targetIsCurrentTab) {
            // The modeler is rendered as a full tab. Save its state, replace the
            // shell content with a fresh split tree so the modeler becomes the
            // left pane, then remount both panes.
            AppState.saveInstanceState(targetInstanceId);
            AppState.saveInstanceState(instance.instanceId);
            this.shellElement.innerHTML = '';
            // Clear any stale split renderers for the target so it gets a fresh one.
            this.splitManager.unregisterRenderer(targetInstanceId);
            this.splitManager.unregisterRenderer(instance.instanceId);
            tree = {
                type: 'split',
                direction: 'horizontal',
                children: [
                    { type: 'pane', instanceId: targetInstanceId },
                    { type: 'pane', instanceId: instance.instanceId },
                ],
                ratios: [55, 45],
            };
            this.splitManager.setTree(tree);
            this.splitManager.registerRenderer(targetInstanceId, async (pane) => {
                const targetInstance = AppState.getInstance(targetInstanceId);
                if (!targetInstance) return;
                await targetInstance.mount(pane);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => AppState.restoreInstanceState(targetInstanceId));
                });
            });
            this.splitManager.registerRenderer(instance.instanceId, async (pane) => {
                await instance.mount(pane);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => AppState.restoreInstanceState(instance.instanceId));
                });
            });
            this.splitManager.render();
            return Promise.resolve();
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
        return Promise.resolve();
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
        if (floatWin) {
            floatWin.setTitle(title);
            const fileName = instance ? (instance.fileName || instance.docName || '') : '';
            if (fileName) floatWin.setFileName(fileName);
        }
    }

    _clampAllFloating() {
        this.floatWindows.forEach((fw) => {
            UiUtils.clampWindowPosition(fw.win);
            UiUtils.clampWindowSize(fw.win, { minWidth: 320, minHeight: 200, minVisible: 60 });
        });
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
        }
    }

    async switchTab(instanceId) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);
        if (record) record.mode = 'tab';
        // If this instance is currently part of a split tree, collapse the tree
        // to a single tab by removing sibling leaves and turning this leaf into
        // the only pane.
        if (this.splitManager.tree) {
            this.splitManager.unregisterRenderer(instanceId);
            const leaves = this._collectLeaves(this.splitManager.tree);
            const keep = leaves.find(l => l.instanceId === instanceId);
            this.splitManager.setTree(keep || { type: 'pane', instanceId });
            this.splitManager.render();
        }
        this.shellElement.innerHTML = '';
        AppState.saveInstanceState(instanceId);
        await this._mountTab(instance);
        AppState.setActiveInstance(instanceId);
    }

    /**
     * Collapse a split so only `keepInstanceId` remains, then remove
     * `removeInstanceId` and remount `keepInstanceId` as a full tab.
     * Use this when closing a split panel without leaving an empty shell.
     */
    async collapseSplitTo(keepInstanceId, removeInstanceId) {
        const keepInstance = AppState.getInstance(keepInstanceId);
        const removeRecord = AppState.getRecord(removeInstanceId);
        if (!keepInstance) return;
        if (removeRecord && removeRecord.mode === 'split') {
            this.splitManager.unregisterRenderer(removeInstanceId);
            this.splitManager.removeLeaf(removeInstanceId);
        }
        this.splitManager.unregisterRenderer(keepInstanceId);
        this.splitManager.setTree({ type: 'pane', instanceId: keepInstanceId });
        this.shellElement.innerHTML = '';
        AppState.saveInstanceState(keepInstanceId);
        await this._mountTab(keepInstance);
        AppState.setActiveInstance(keepInstanceId);
        this.splitManager.unregisterRenderer(removeInstanceId);
        if (removeRecord && removeRecord.mode === 'split') {
            AppState.removeInstance(removeInstanceId);
        }
    }

    async moveToFloat(instanceId, props = {}) {
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
        await this._mountFloating(instance, props);
    }

    async moveToSplit(instanceId, props = {}) {
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
        await this._mountSplit(instance, props);
    }

    renderSplit() {
        this.splitManager.render();
    }

    /**
     * Open a panel split next to a specific instance.
     * Guarantees both panes are rendered, even when starting from a full-screen tab.
     */
    async splitPanel(targetInstanceId, appId, props = {}, options = {}) {
        const targetRecord = AppState.getRecord(targetInstanceId);
        const targetInstance = AppState.getInstance(targetInstanceId);
        if (!targetInstance || !targetRecord) throw new Error('Target instance not found');

        // Cleanly unmount the target from its current container before re-mounting
        // it inside the split tree. This avoids stale DOM / double-mount issues.
        if (typeof targetInstance.unmount === 'function') {
            targetInstance.unmount();
        }
        AppState.saveInstanceState(targetInstanceId);

        const { instanceId, instance } = AppState.createInstance(appId, {
            ...props,
            mode: 'split',
        });
        AppState.saveInstanceState(instanceId);

        this.splitManager.unregisterRenderer(targetInstanceId);
        this.splitManager.unregisterRenderer(instanceId);
        this.shellElement.innerHTML = '';

        const ratio = options.ratio || [50, 50];
        this.splitManager.setTree({
            type: 'split',
            direction: 'horizontal',
            children: [
                { type: 'pane', instanceId: targetInstanceId },
                { type: 'pane', instanceId },
            ],
            ratios: ratio,
        });

        let mountedTarget = false;
        this.splitManager.registerRenderer(targetInstanceId, async (pane) => {
            if (mountedTarget) return;
            mountedTarget = true;
            pane.innerHTML = '';
            await targetInstance.mount(pane);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => AppState.restoreInstanceState(targetInstanceId));
            });
        });

        let mountedAssistant = false;
        this.splitManager.registerRenderer(instanceId, async (pane) => {
            if (mountedAssistant) return;
            mountedAssistant = true;
            pane.innerHTML = '';
            await instance.mount(pane);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => AppState.restoreInstanceState(instanceId));
            });
        });

        this.splitManager.render();

        // Whenever the split panes are resized, ask the modeler to keep its SVG
        // anchored to the pane center, just like a floating preview window does.
        if (this._splitResizeObserver) this._splitResizeObserver.disconnect();
        this._splitResizeObserver = new ResizeObserver((entries) => {
            const modeler = AppState.getInstance(targetInstanceId);
            if (!modeler) return;
            const entry = entries[0];
            if (!entry) return;
            const cr = entry.contentRect;
            // Ignore the first resize event: the shell has just been created and
            // the modeler already restored its saved viewer state. We only want
            // to nudge the SVG when the user drags the split resizer afterwards.
            if (!this._lastShellSize) {
                this._lastShellSize = { width: cr.width, height: cr.height };
                return;
            }
            const prev = this._lastShellSize;
            const dx = (cr.width - prev.width) / 2;
            const dy = (cr.height - prev.height) / 2;
            this._lastShellSize = { width: cr.width, height: cr.height };
            if (modeler.viewer && modeler.svgText) {
                modeler.viewer.state.x += dx;
                modeler.viewer.state.y += dy;
                modeler.viewer.applyTransform();
            }
        });
        this._lastShellSize = null;
        this._splitResizeObserver.observe(this.shellElement);

        AppState.setActiveInstance(instanceId);
        return instanceId;
    }
}

window.WindowManager = WindowManager;
