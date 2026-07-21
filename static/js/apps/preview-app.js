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
                <div class="px-4 py-2 border-b border-gray-200 text-sm text-gray-500 truncate">
                    ${this._escape(this.docName)}
                </div>
                <div id="preview-svg-viewer" class="flex-1 relative"></div>
                <div id="preview-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
                    <svg class="animate-spin h-8 w-8 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span class="text-sm font-medium">Génération de la modélisation...</span>
                </div>
            </div>
        `;
        this.setTitle(`Aperçu: ${this.docName}`);
        this._load();
    }

    _escape(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async _load() {
        const loading = this.container.querySelector('#preview-loading');
        const viewerContainer = this.container.querySelector('#preview-svg-viewer');
        console.log('[Preview] load start docId=', this.docId, 'documentId=', this.documentId);
        if (!this.docId) {
            if (loading) loading.innerHTML = `<div class="text-red-500 text-sm">Aucun document sélectionné.</div>`;
            return;
        }
        try {
            const url = ApiClient.getDocumentVisualizeUrl(this.docId);
            console.log('[Preview] fetching', url);
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
            this.svgText = await res.text();
            console.log('[Preview] received', this.svgText.length, 'chars');
            const match = this.svgText.match(/data-main-class="([^"]*)"/);
            const mainClassName = match ? match[1] : '';
            if (loading) loading.classList.add('hidden');
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
        } catch (err) {
            console.error('Preview load error', err);
            if (loading) loading.innerHTML = `<div class="text-red-500 text-sm">Erreur de chargement du diagramme.</div>`;
        }
    }

    getState() {
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
