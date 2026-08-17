/**
 * WindowManager
 * Gère les apps dans trois modes : tab (plein écran shell), float (fenêtre flottante), split (panneau).
 *
 * Conception du cache :
 * - Une seule vue est visible à la fois dans this.shellElement.
 * - Quand on la quitte, son DOM est détaché et stocké dans _viewCache[instanceId].
 * - Pour un split, les deux feuilles pointent vers la MÊME entrée de cache.
 * - La source de vérité de "qui est visible" est le DOM (dataset.instanceId), pas
 *   AppState.activeInstanceId, qui peut être en retard.
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
        this._viewCache = new Map(); // instanceId -> { dom, mode, splitTree?, activeInstanceId? }
        window.addEventListener('resize', this._viewportHandler);
    }

    /**
     * Public entry point for the shell nav buttons. Ensures one tab/split
     * instance per appId and switches/restores it.
     */
    switchToApp(appId) {
        const existing = AppState.listInstances()
            .filter((i) => i.appId === appId && (i.mode === 'tab' || i.mode === 'split'))
            .pop();
        if (existing) {
            this.switchTab(existing.instanceId);
        } else {
            this.open(appId, { mode: 'tab' });
        }
    }

    open(appId, props = {}) {
        const mode = props.mode || 'tab';
        // Tab/split apps are singleton-like: reuse the existing instance.
        if (mode === 'tab' || mode === 'split') {
            const existing = AppState.listInstances()
                .filter((i) => i.appId === appId && (i.mode === 'tab' || i.mode === 'split'))
                .pop();
            if (existing) {
                this.switchTab(existing.instanceId);
                return existing.instanceId;
            }
        }

        const AppClass = AppState.getRecord ? null : null; // not used directly
        const { instanceId, instance } = AppState.createInstance(appId, props);
        const record = AppState.getRecord(instanceId);
        if (record) record.mode = mode;
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

    /**
     * Return the instanceId whose DOM is currently in the shell.
     * For a split, returns the active pane (or the first pane if none is active).
     */
    _getVisibleInstanceId() {
        if (this.splitManager.tree) {
            const activePane = this.shellElement.querySelector('.split-pane.split-pane-active');
            if (activePane) return activePane.dataset.instanceId || null;
            const firstPane = this.shellElement.querySelector('.split-pane');
            if (firstPane) return firstPane.dataset.instanceId || null;
        }
        const container = this.shellElement.querySelector('.app-container');
        return container?.dataset.instanceId || AppState.getActiveInstance();
    }

    async switchTab(instanceId) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;

        const visibleId = this._getVisibleInstanceId();

        // Already visible and target is the visible one -> nothing to do.
        if (visibleId === instanceId) {
            return;
        }

        // Suspend the currently visible view.
        if (visibleId) {
            this._cacheView(visibleId);
        }

        // Restore a cached view for the target.
        const cached = this._viewCache.get(instanceId);
        if (cached?.dom) {
            this._restoreCachedView(instanceId, cached, instance);
            return;
        }

        // Fresh mount as a tab.
        const record = AppState.getRecord(instanceId);
        if (record) record.mode = 'tab';
        this.shellElement.innerHTML = '';
        this.splitManager.setTree(null);
        AppState.saveInstanceState(instanceId);
        await this._mountTab(instance);
        AppState.setActiveInstance(instanceId);
    }

    /**
     * Detach the visible DOM for instanceId and store it in _viewCache.
     * Defensive: only cache if the DOM actually belongs to instanceId.
     */
    _cacheView(instanceId) {
        const record = AppState.getRecord(instanceId);
        const instance = AppState.getInstance(instanceId);
        if (!record) return;

        // Split view: cache the whole split under every leaf.
        if (this.splitManager.tree) {
            const leaves = this._collectLeaves(this.splitManager.tree);
            const dom = this.shellElement.firstChild;
            if (!dom || !dom.querySelector('.split-pane')) return;
            // Verify the active pane matches instanceId before caching.
            const activePane = dom.querySelector('.split-pane.split-pane-active') || dom.querySelector('.split-pane');
            if (activePane?.dataset.instanceId !== instanceId) return;

            leaves.forEach((leaf) => {
                const leafInstance = AppState.getInstance(leaf.instanceId);
                if (leafInstance && typeof leafInstance.onTabDeactivated === 'function') {
                    leafInstance.onTabDeactivated();
                }
                AppState.saveInstanceState(leaf.instanceId);
            });
            const entry = {
                dom,
                mode: 'split',
                splitTree: this.splitManager.tree,
                activeInstanceId: instanceId,
            };
            leaves.forEach((leaf) => this._viewCache.set(leaf.instanceId, entry));
            this.splitManager.tree = null;
            this._clearShell();
            return;
        }

        // Simple tab view.
        if (instance && typeof instance.onTabDeactivated === 'function') {
            instance.onTabDeactivated();
        }
        AppState.saveInstanceState(instanceId);
        const dom = this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`);
        if (dom) {
            this._viewCache.set(instanceId, { dom, mode: record.mode || 'tab' });
        }
        this._clearShell();
    }

    _restoreCachedView(instanceId, cached, instance) {
        this._viewCache.delete(instanceId);
        this._clearShell();

        if (cached.mode === 'split' && cached.splitTree) {
            // Remove the shared cache entry for all split leaves.
            this._collectLeaves(cached.splitTree).forEach((leaf) => {
                if (leaf.instanceId !== instanceId) this._viewCache.delete(leaf.instanceId);
            });
            this.shellElement.appendChild(cached.dom);
            this.splitManager.tree = cached.splitTree;
            this.splitManager.setActiveLeaf(instanceId);
        } else {
            this.splitManager.setTree(null);
            this.shellElement.appendChild(cached.dom);
        }

        if (typeof instance.onTabActivated === 'function') {
            instance.onTabActivated();
        } else {
            AppState.restoreInstanceState(instanceId);
        }
        AppState.setActiveInstance(instanceId);
    }

    _clearShell() {
        while (this.shellElement.firstChild) {
            this.shellElement.removeChild(this.shellElement.firstChild);
        }
    }

    _mountTab(instance) {
        const instanceId = instance.instanceId;
        AppState.saveInstanceState(instanceId);
        this._clearShell();
        this.splitManager.setTree(null);

        const cached = this._viewCache.get(instanceId);
        if (cached && cached.mode === 'tab') {
            this.shellElement.appendChild(cached.dom);
            this._viewCache.delete(instanceId);
            if (typeof instance.onTabActivated === 'function') {
                instance.onTabActivated();
            } else {
                AppState.restoreInstanceState(instanceId);
            }
            return Promise.resolve();
        }

        const container = document.createElement('div');
        container.className = 'app-container h-full w-full';
        container.dataset.instanceId = instanceId;
        this.shellElement.appendChild(container);
        return new Promise(async (resolve) => {
            await instance.mount(container);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    AppState.restoreInstanceState(instanceId);
                    resolve();
                });
            });
        });
    }

    _mountFloating(instance, props) {
        AppState.saveInstanceState(instance.instanceId);
        this._removeViewCache(instance.instanceId);
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
        this._removeViewCache(instance.instanceId);
        const { targetInstanceId, direction = 'horizontal' } = props;
        let tree = this.splitManager.tree;
        if (!tree) {
            tree = { type: 'pane', instanceId: instance.instanceId };
            this.splitManager.setTree(tree);
            this.splitManager.registerRenderer(instance.instanceId, (pane) => instance.mount(pane));
            AppState.restoreInstanceState(instance.instanceId);
            return Promise.resolve();
        }

        const targetIsCurrentTab = targetInstanceId &&
            this.shellElement.querySelector(`[data-instance-id="${targetInstanceId}"]`);
        if (targetInstanceId && targetIsCurrentTab) {
            AppState.saveInstanceState(targetInstanceId);
            AppState.saveInstanceState(instance.instanceId);
            this._clearShell();
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
        this._removeViewCache(instanceId);
        if (this.splitManager.tree) {
            const leaves = this._collectLeaves(this.splitManager.tree);
            if (leaves.some((l) => l.instanceId === instanceId)) {
                const remaining = leaves.find((l) => l.instanceId !== instanceId);
                if (remaining) {
                    const remainingInstance = AppState.getInstance(remaining.instanceId);
                    if (remainingInstance) {
                        AppState.saveInstanceState(remaining.instanceId);
                        if (typeof remainingInstance.unmount === 'function') {
                            remainingInstance.unmount();
                        }
                    }
                }
                this.splitManager.setTree(remaining || null);
                this.splitManager.render();
            }
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this._clearShell();
        }
        AppState.removeInstance(instanceId);
        if (this.floatWindows.size === 0) {
            window.removeEventListener('resize', this._viewportHandler);
        }
    }

    _removeViewCache(instanceId) {
        const cached = this._viewCache.get(instanceId);
        if (cached && cached.mode === 'split' && cached.splitTree) {
            this._collectLeaves(cached.splitTree).forEach((leaf) => {
                this._viewCache.delete(leaf.instanceId);
            });
            return;
        }
        this._viewCache.delete(instanceId);
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
        this._removeViewCache(keepInstanceId);
        this._removeViewCache(removeInstanceId);
        AppState.saveInstanceState(keepInstanceId);
        if (typeof keepInstance.unmount === 'function') {
            keepInstance.unmount();
        }
        if (removeRecord && removeRecord.mode === 'split') {
            this.splitManager.unregisterRenderer(removeInstanceId);
            this.splitManager.removeLeaf(removeInstanceId);
        }
        this.splitManager.unregisterRenderer(keepInstanceId);
        this.splitManager.setTree({ type: 'pane', instanceId: keepInstanceId });
        this._clearShell();

        AppState.restoreInstanceState(keepInstanceId);

        const container = document.createElement('div');
        container.className = 'app-container h-full w-full';
        container.dataset.instanceId = keepInstanceId;
        this.shellElement.appendChild(container);
        await keepInstance.mount(container);
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
            if (this.splitManager.tree) {
                const leaves = this._collectLeaves(this.splitManager.tree);
                leaves.forEach((leaf) => this._removeViewCache(leaf.instanceId));
            }
            this.splitManager.unregisterRenderer(instanceId);
            this.splitManager.removeLeaf(instanceId);
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this._clearShell();
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
            this._clearShell();
        }
        this._removeViewCache(instanceId);
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

        if (typeof targetInstance.unmount === 'function') {
            targetInstance.unmount();
        }
        this._removeViewCache(targetInstanceId);
        AppState.saveInstanceState(targetInstanceId);

        const { instanceId, instance } = AppState.createInstance(appId, {
            ...props,
            mode: 'split',
        });
        const newRecord = AppState.getRecord(instanceId);
        if (newRecord) newRecord.mode = 'split';
        targetRecord.mode = 'split';
        AppState.saveInstanceState(instanceId);

        this.splitManager.unregisterRenderer(targetInstanceId);
        this.splitManager.unregisterRenderer(instanceId);
        this._clearShell();

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

        if (this._splitResizeObserver) this._splitResizeObserver.disconnect();
        this._splitResizeObserver = new ResizeObserver((entries) => {
            const modeler = AppState.getInstance(targetInstanceId);
            if (!modeler) return;
            const entry = entries[0];
            if (!entry) return;
            const cr = entry.contentRect;
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
