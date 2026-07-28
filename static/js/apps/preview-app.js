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
                <div id="preview-svg-viewer" class="flex-1 relative"></div>
                <button type="button" id="preview-expand" class="absolute top-3 right-3 z-20 p-2 rounded-full bg-white border border-gray-200 text-gray-600 hover:text-black hover:border-gray-400 shadow-sm transition-colors" title="Ouvrir dans Vision">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                        <path d="M15 3h6v6M14 10l7-7M3 15v6h6M10 14l-7 7M21 3v6h-6M14 4l7 7M3 21v-6h6M10 20l-7-7"></path>
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
        expandBtn.addEventListener('click', () => this._openInVision());
    }

    async _openInVision() {
        if (!this.svgText) return;
        if (!AuthManager.isLoggedIn()) {
            AuthManager.showModal();
            return;
        }
        // Fetch the original file bytes so we can persist the model like a normal Vision import.
        try {
            const fileRes = await fetch(ApiClient.getDocumentFileUrl(this.docId));
            if (!fileRes.ok) throw new Error(`file_fetch_failed:${fileRes.status}`);
            const blob = await fileRes.blob();
            const file = new File([blob], this.docName, { type: blob.type || "application/octet-stream" });
            await ApiClient.importAndSaveModel(file, this.docName);
            if (window.historyPanel) window.historyPanel.load();
        } catch (err) {
            console.error("Persist preview model error", err);
            alert("Impossible d'enregistrer le modèle dans l'historique.");
            return;
        }

        const existingVision = AppState.listInstances().find((i) => i.appId === "vision" && i.mode === "tab");
        if (existingVision) {
            AppState.removeInstance(existingVision.instanceId);
        }
        const match = this.svgText.match(/data-main-class="([^"]*)"/);
        const mainClassName = match ? match[1] : '';
        windowManager.open("vision", {
            mode: "tab",
            fileName: this.docName,
            svgText: this.svgText,
            mainClassName,
        });
        windowManager.close(this.instanceId);
    }

    async _load() {
        const loading = this.container.querySelector('#preview-loading');
        const viewerContainer = this.container.querySelector('#preview-svg-viewer');
        if (!this.docId) {
            if (loading) loading.innerHTML = `<div class="text-red-500 text-sm">Aucun document sélectionné.</div>`;
            return;
        }
        try {
            const url = ApiClient.getDocumentVisualizeUrl(this.docId);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
            this.svgText = await res.text();
            const match = this.svgText.match(/data-main-class="([^"]*)"/);
            const mainClassName = match ? match[1] : '';
            if (!this.viewer) {
                this.viewer = new SvgViewer(viewerContainer, {
                    onTransform: (state) => { this.viewerState = state; }
                });
            }
            // First-time preview: center the diagram. Reopen: keep exact position/zoom.
            const isFirstOpen = !this.viewerState || (this.viewerState.scale === 1 && this.viewerState.x === 0 && this.viewerState.y === 0);
            if (isFirstOpen) {
                this.viewer.setSvgAndRestore(this.svgText, mainClassName, null);
            } else {
                this.viewer.setSvg(this.svgText, mainClassName);
                this.viewer.restoreState(this.viewerState);
            }
            if (loading) loading.classList.add('hidden');
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
