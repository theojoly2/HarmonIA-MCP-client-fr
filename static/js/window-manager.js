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
        // Cache DOM containers for tab instances so switching tabs does not destroy
        // the rendered app. Each tab keeps its own live DOM tree.
        this._tabDomCache = new Map(); // instanceId -> HTMLElement
        // Cache for split views. A split has one DOM tree but multiple instanceIds,
        // so we store the same DOM/tree under each leaf instanceId. When the user
        // switches back to any leaf, the whole split is restored exactly as it was.
        this._splitDomCache = new Map(); // instanceId -> HTMLElement
        this._splitTreeCache = new Map(); // instanceId -> tree
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
        const instanceId = instance.instanceId;
        AppState.saveInstanceState(instanceId);
        this.shellElement.innerHTML = '';

        // If this tab already has a live DOM cache, reuse it. This preserves the
        // running stream, scroll position, and partial UI state across tab switches.
        let container = this._tabDomCache.get(instanceId);
        if (container) {
            this.shellElement.appendChild(container);
            // The DOM was preserved while the tab was hidden. Notify the app so it
            // can reconnect observers / resume streaming, but do not call setState
            // which would rebuild the DOM and destroy live state (e.g. SVG viewer).
            if (typeof instance.onTabActivated === 'function') {
                instance.onTabActivated();
            } else {
                AppState.restoreInstanceState(instanceId);
            }
            return Promise.resolve();
        }

        container = document.createElement('div');
        container.className = 'app-container h-full w-full';
        container.dataset.instanceId = instanceId;
        this._tabDomCache.set(instanceId, container);
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
        // Floating windows get a fresh container; clear any stale cached tab DOM
        // so the instance is rebuilt cleanly if it later returns to tab mode.
        const cachedContainer = this._tabDomCache.get(instance.instanceId);
        if (cachedContainer) {
            cachedContainer.remove();
            this._tabDomCache.delete(instance.instanceId);
        }
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
        // Split mode uses a fresh pane; clear any stale cached tab DOM so the
        // instance is rebuilt cleanly if it later returns to tab mode.
        const cachedContainer = this._tabDomCache.get(instance.instanceId);
        if (cachedContainer) {
            cachedContainer.remove();
            this._tabDomCache.delete(instance.instanceId);
        }
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
        // Remove cached tab DOM for this instance to free memory when explicitly closed.
        const cachedContainer = this._tabDomCache.get(instanceId);
        if (cachedContainer) {
            cachedContainer.remove();
            this._tabDomCache.delete(instanceId);
        }
        // If the closed instance is part of a split tree, collapse the split
        // around the remaining leaf so the shell is not left empty.
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
                this._clearSplitCache(...leaves.map((l) => l.instanceId));
                this.splitManager.setTree(remaining || null);
                this.splitManager.render();
            }
        }
        if (this.shellElement.querySelector(`[data-instance-id="${instanceId}"]`)) {
            this.shellElement.innerHTML = '';
        }
        AppState.removeInstance(instanceId);
        if (this.floatWindows.size === 0) {
            window.removeEventListener('resize', this._viewportHandler);
        }
    }

    async     switchTab(instanceId) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);

        const activeInstanceId = AppState.getActiveInstance();
        const activeInstance = activeInstanceId ? AppState.getInstance(activeInstanceId) : null;

        // 1. Target is part of the currently visible split -> just activate its pane.
        if (this.splitManager.containsInstance(instanceId)) {
            if (activeInstanceId !== instanceId) {
                if (activeInstance && typeof activeInstance.onTabDeactivated === 'function') {
                    activeInstance.onTabDeactivated();
                }
                AppState.saveInstanceState(activeInstanceId);
                this.splitManager.setActiveLeaf(instanceId);
                if (typeof instance.onTabActivated === 'function') {
                    instance.onTabActivated();
                } else {
                    AppState.restoreInstanceState(instanceId);
                }
            }
            AppState.setActiveInstance(instanceId);
            return;
        }

        // 2. Target is in a cached split -> restore the whole split view.
        // We also require the instance record to still be marked as split, so a
        // standalone tab with the same appId is never mistaken for a split pane.
        if (record && record.mode === 'split' && this._splitDomCache.has(instanceId) && this._splitTreeCache.has(instanceId)) {
            // Suspend whatever is currently visible before swapping it out.
            if (activeInstanceId && activeInstanceId !== instanceId) {
                if (activeInstance && typeof activeInstance.onTabDeactivated === 'function') {
                    activeInstance.onTabDeactivated();
                }
                AppState.saveInstanceState(activeInstanceId);
                const currentDom = this.shellElement.firstChild;
                if (activeInstance && currentDom) {
                    if (this.splitManager.tree) {
                        // The current view is a split; cache it for all its leaves.
                        this._cacheCurrentSplit();
                    } else {
                        this._tabDomCache.set(activeInstanceId, currentDom);
                    }
                }
                while (this.shellElement.firstChild) {
                    this.shellElement.removeChild(this.shellElement.firstChild);
                }
            }
            const splitDom = this._splitDomCache.get(instanceId);
            const splitTree = this._splitTreeCache.get(instanceId);
            if (!splitDom || !splitTree) {
                // Cache entry is incomplete; fall through to normal tab mount.
                this._clearSplitCache(instanceId);
            } else {
                this.shellElement.appendChild(splitDom);
                this.splitManager.tree = splitTree;
                // Activate the requested pane; the other pane is already live and
                // will resume via the active pane notification if needed.
                this.splitManager.setActiveLeaf(instanceId);
                if (typeof instance.onTabActivated === 'function') {
                    instance.onTabActivated();
                }
                AppState.setActiveInstance(instanceId);
                return;
            }
        }

        // 3. Normal tab switch. If a split is currently visible, cache it first.
        if (this.splitManager.tree) {
            this._cacheCurrentSplit();
            while (this.shellElement.firstChild) {
                this.shellElement.removeChild(this.shellElement.firstChild);
            }
        }
        if (activeInstanceId && activeInstanceId !== instanceId) {
            if (activeInstance && typeof activeInstance.onTabDeactivated === 'function') {
                activeInstance.onTabDeactivated();
            }
            AppState.saveInstanceState(activeInstanceId);
            const currentDom = this.shellElement.firstChild;
            if (currentDom) this._tabDomCache.set(activeInstanceId, currentDom);
            while (this.shellElement.firstChild) {
                this.shellElement.removeChild(this.shellElement.firstChild);
            }
        }

        if (record) record.mode = 'tab';
        AppState.saveInstanceState(instanceId);
        await this._mountTab(instance);
        AppState.setActiveInstance(instanceId);
    }

    _cacheCurrentSplit() {
        if (!this.splitManager.tree) return;
        const leaves = this._collectLeaves(this.splitManager.tree);
        const splitDom = this.shellElement.firstChild;
        // Safety: only cache if the shell actually contains the split DOM.
        if (!splitDom || !splitDom.querySelector('.split-pane')) return;
        // Deactivate every leaf so observers/streams are suspended while cached.
        for (const leaf of leaves) {
            const leafInstance = AppState.getInstance(leaf.instanceId);
            if (leafInstance && typeof leafInstance.onTabDeactivated === 'function') {
                leafInstance.onTabDeactivated();
            }
            AppState.saveInstanceState(leaf.instanceId);
        }
        for (const leaf of leaves) {
            this._splitDomCache.set(leaf.instanceId, splitDom);
            this._splitTreeCache.set(leaf.instanceId, this.splitManager.tree);
        }
        // The DOM is now detached from the shell and stored; clear the live tree
        // reference so it is not mistaken for the currently visible view.
        this.splitManager.tree = null;
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
        // Clear any cached split state: the split is being closed intentionally.
        this._clearSplitCache(keepInstanceId, removeInstanceId);
        // Save modeler state before unmounting it from the split.
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
        this.shellElement.innerHTML = '';

        // Restore saved state before mount so render() sees the real svgText.
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

    _clearSplitCache(...instanceIds) {
        for (const id of instanceIds) {
            this._splitDomCache.delete(id);
            this._splitTreeCache.delete(id);
        }
    }

    async moveToFloat(instanceId, props = {}) {
        const instance = AppState.getInstance(instanceId);
        if (!instance) return;
        const record = AppState.getRecord(instanceId);
        if (record && record.mode === 'split') {
            // Moving one pane of a split to float destroys the split layout.
            if (this.splitManager.tree) {
                const leaves = this._collectLeaves(this.splitManager.tree);
                this._clearSplitCache(...leaves.map((l) => l.instanceId));
            }
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
        // Also clear the cached tab DOM so the target is rebuilt cleanly if it
        // later returns to tab mode.
        if (typeof targetInstance.unmount === 'function') {
            targetInstance.unmount();
        }
        const targetCached = this._tabDomCache.get(targetInstanceId);
        if (targetCached) {
            targetCached.remove();
            this._tabDomCache.delete(targetInstanceId);
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
