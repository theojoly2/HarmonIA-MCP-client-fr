/**
 * PreviewApp
 * Aperçu rapide d'un document avec visualisation SVG.
 */

class PreviewApp extends AppBase {
    static id = "preview";
    static title = "Aperçu";
    static iconSvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>`;
    static canFloat = true;
    static canSplit = true;
    static singleton = false;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.docId = props.docId || '';
        this.documentId = props.documentId || '';
        this.modelName = props.modelName || '';
        this.docName = props.name || 'Document';
        this.svgText = '';
        this.viewer = null;
        this.viewerState = { scale: 1, x: 0, y: 0 };
    }

    render(container) {
        // Any previous viewer is tied to a DOM container that will be replaced;
        // discard the reference so a fresh viewer is created for the new container.
        if (this.viewer) {
            this.viewerState = this.viewer.getState();
            this.viewer.destroy();
            this.viewer = null;
        }
        this.container = container;
        container.innerHTML = `
            <div class="preview-app h-full w-full flex flex-col relative bg-white">
                <div id="preview-svg-viewer" class="flex-1 relative opacity-0"></div>
                <button type="button" id="preview-expand" class="absolute top-3 right-3 z-20 p-2 rounded-full bg-white border border-gray-200 text-gray-600 hover:text-black hover:border-gray-400 shadow-sm transition-colors" title="Ouvrir dans Éditer">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                        <path d="M21 9V3h-6M15 9l6-6"></path>
                        <path d="M3 15v6h6M9 15l-6 6"></path>
                    </svg>
                </button>
                <div id="preview-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10 bg-white/80 backdrop-blur-sm transition-opacity duration-300">
                    <svg class="animate-spin h-8 w-8 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span class="text-sm font-medium">Génération de la modélisation...</span>
                </div>
            </div>
        `;
        this.setTitle(`Aperçu: ${this.docName}`);
        this._bindEvents();
        this._load();
    }

    _escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    _bindEvents() {
        const expandBtn = this.container.querySelector('#preview-expand');
        if (!expandBtn) return;
        expandBtn.addEventListener('click', () => this._openInModéliseur());
    }

    async _openInModéliseur() {
        if (!this.svgText) return;
        if (!AuthManager.isLoggedIn()) {
            AuthManager.showModal();
            return;
        }
        const match = this.svgText.match(/data-main-class="([^"]*)"/);
        const mainClassName = match ? match[1] : '';

        // Persist the model before opening the modeler so the opened model points
        // to the real stored name, exactly like a direct import from the modeler tab.
        let storedName = this.modelName;
        let displayName = this.docName;
        if (!this.modelName) {
            try {
                const fileRes = await fetch(ApiClient.getDocumentFileUrl(this.docId));
                if (!fileRes.ok) throw new Error(`file_fetch_failed:${fileRes.status}`);
                const blob = await fileRes.blob();
                const file = new File([blob], this.docName, { type: blob.type || "application/octet-stream" });
                const meta = await ApiClient.importAndSaveModel(file, this.docName);
                storedName = meta.name || this.docName;
                displayName = meta.display_name || this.docName;
                if (window.historyPanel) window.historyPanel.load();
            } catch (err) {
                console.error("Persist preview model error", err);
                return;
            }
        }

        const existingModéliseur = AppState.listInstances().find((i) => i.appId === "modeler" && i.mode === "tab");
        if (existingModéliseur) {
            AppState.removeInstance(existingModéliseur.instanceId);
        }
        const modelerInstance = AppState.createInstance("modeler", {
            mode: "tab",
        });
        await windowManager._mountTab(modelerInstance.instance);
        AppState.setActiveInstance(modelerInstance.instanceId);
        windowManager.close(this.instanceId);
        if (modelerInstance.instance.loadSvg) {
            await modelerInstance.instance.loadSvg(this.svgText, displayName, mainClassName, storedName);
        }
    }

    async _load() {
        const loading = this.container.querySelector('#preview-loading');
        const viewerContainer = this.container.querySelector('#preview-svg-viewer');
        if (!this.docId && !this.modelName) {
            if (loading) loading.innerHTML = `<div class="text-red-500 text-sm">Aucun document sélectionné.</div>`;
            return;
        }
        try {
            let svgText = '';
            if (this.modelName) {
                const result = await ApiClient.getModelSvg(this.modelName);
                svgText = result.svgText || '';
            } else {
                const url = ApiClient.getDocumentVisualizeUrl(this.docId);
                const res = await fetch(url);
                if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
                svgText = await res.text();
            }
            this.svgText = svgText;
            const match = this.svgText.match(/data-main-class="([^"]*)"/);
            const mainClassName = match ? match[1] : '';
            if (!this.viewer) {
                this.viewer = new SvgViewer(viewerContainer, {
                    onTransform: (state) => { this.viewerState = state; }
                });
            }
            // Reopen from tab switch: keep pan/zoom. First preview: center the diagram.
            const isFirstOpen = !this.viewerState || (this.viewerState.scale === 1 && this.viewerState.x === 0 && this.viewerState.y === 0);
            const finalize = () => {
                if (loading) {
                    loading.style.transition = 'opacity 0.35s ease';
                    loading.style.opacity = '0';
                    setTimeout(() => loading.classList.add('hidden'), 350);
                }
                const viewerEl = this.container.querySelector('#preview-svg-viewer');
                if (viewerEl) {
                    viewerEl.style.transition = 'opacity 0.35s ease';
                    viewerEl.style.opacity = '1';
                }
            };
            if (isFirstOpen) {
                this.viewer.setSvg(this.svgText, mainClassName);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this.viewer.resetZoom();
                        finalize();
                    });
                });
            } else {
                this.viewer.setSvg(this.svgText, mainClassName);
                this.viewer.restoreState(this.viewerState);
                finalize();
            }
        } catch (err) {
            console.error('Preview load error', err);
            if (loading) loading.innerHTML = `<div class="text-red-500 text-sm">Erreur de chargement du diagramme.</div>`;
        }
    }

    getState() {
        // Avoid saving state before the first load so restoreInstanceState doesn't
        // trigger a redundant render while _load is still async.
        if (!this.svgText && !this.viewer) {
            return {};
        }
        return {
            docId: this.docId,
            documentId: this.documentId,
            docName: this.docName,
            viewerState: this.viewer ? this.viewer.getState() : this.viewerState,
        };
    }

    setState(state) {
        this.docId = state.docId || this.docId;
        this.documentId = state.documentId || this.documentId;
        this.docName = state.docName || this.docName;
        this.viewerState = state.viewerState || { scale: 1, x: 0, y: 0 };
        if (this.container) this.render(this.container);
    }

    unmount() {
        if (this.viewer) {
            this.viewerState = this.viewer.getState();
            this.viewer.destroy();
            this.viewer = null;
        }
        super.unmount();
    }
}

window.PreviewApp = PreviewApp;
