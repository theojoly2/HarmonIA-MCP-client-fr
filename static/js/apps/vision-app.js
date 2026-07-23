/**
 * VisionApp
 * Module Vision Sémantique : import + visualisation SVG.
 */

class VisionApp extends AppBase {
    static id = "vision";
    static title = "Vision";
    static iconSvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>`;
    static canFloat = true;
    static canSplit = true;
    static singleton = false;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.fileName = props.fileName || '';
        this.svgText = props.svgText || '';
        this.mainClassName = props.mainClassName || '';
        this.viewerState = { scale: 1, x: 0, y: 0 };
        this.viewer = null;
        this._centerOnNextShow = true;
        this._homeTimeout = null;
    }

    render(container) {
        // Any previous viewer is tied to a DOM container that will be replaced;
        // discard the reference so a fresh viewer is created for the new container.
        this.viewer = null;
        this.container = container;
        container.innerHTML = `
            <div class="vision-app h-full flex flex-col relative">
                <div id="vision-home" class="vision-home px-4 sm:px-6 flex flex-col items-center text-center z-20 bg-white">
                    <h1 class="font-bold tracking-tight text-center text-black mb-2 mt-2">
                        <button type="button" class="interactive-title bg-transparent border-0 p-0" title="Retour à l'accueil Vision">
                            <span class="title-glow">Vision Sémantique</span>
                        </button>
                    </h1>
                    <div id="vision-import-container" class="w-full max-w-md">
                        <p class="text-base font-medium mb-6 text-center max-w-md mx-auto text-gray-500">
                            Importez un fichier (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML) pour le visualiser sous forme de diagramme.
                        </p>
                        <label id="vision-drop-zone" class="drop-zone flex flex-col items-center justify-center w-full max-w-md mx-auto py-10 px-6 cursor-pointer hover:border-gray-400">
                            <svg class="w-10 h-10 mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
                            </svg>
                            <span class="text-sm font-semibold text-gray-700">Glissez-déposez un fichier ici</span>
                            <span class="text-xs text-gray-400 mt-1">ou cliquez pour parcourir</span>
                            <input type="file" id="vision-file-input" class="hidden" accept=".ttl,.xml,.xmi,.json,.jsonld,.sql,.txt,.html,.htm,.csv">
                        </label>
                    </div>
                </div>
                <div id="vision-viewer" class="hidden flex-1 min-h-0 opacity-0 transition-opacity duration-300 relative">
                    <div id="vision-svg-viewer" class="h-full w-full"></div>
                    <div id="vision-loading" class="hidden absolute inset-0 flex items-center justify-center text-gray-500 z-10 bg-white/80 backdrop-blur-sm transition-opacity duration-300">
                        <svg class="animate-spin h-8 w-8 text-gray-400 mr-3" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span class="text-sm font-medium">Génération de la modélisation...</span>
                    </div>
                </div>
            </div>
        `;
        this._bindEvents();
        if (this.svgText) {
            // Defer viewer creation until container layout is settled
            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._showViewer());
            });
        }
    }

    _bindEvents() {
        const dropZone = this.container.querySelector('#vision-drop-zone');
        const fileInput = this.container.querySelector('#vision-file-input');
        const titleBtn = this.container.querySelector('#vision-home .interactive-title');

        if (titleBtn) {
            titleBtn.addEventListener('click', () => this._showVisionHome());
        }

        if (!dropZone || !fileInput) return;

        const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
            dropZone.addEventListener(ev, prevent, false);
        });
        dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) this._handleFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) this._handleFile(e.target.files[0]);
        });
    }

    async _handleFile(file) {
        this.fileName = file.name;
        // Every new import must be centered.
        this._centerOnNextShow = true;
        this.viewerState = { scale: 1, x: 0, y: 0 };
        // Cancel any pending return-to-home transition that would overwrite this import.
        if (this._homeTimeout) {
            clearTimeout(this._homeTimeout);
            this._homeTimeout = null;
        }
        if (this.viewer) {
            this.viewer.destroy();
            this.viewer = null;
        }
        // Switch to viewer area and show spinner while keeping the import UI visible briefly
        this._enterLoadingMode();
        try {
            this.svgText = await ApiClient.importVisionFile(file);
            const match = this.svgText.match(/data-main-class="([^"]*)"/);
            this.mainClassName = match ? match[1] : '';
            this._showViewer();
        } catch (err) {
            console.error('Vision import error', err);
            this._setLoading(false);
            this._showError(err.message);
        }
    }

    _enterLoadingMode() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const viewer = this.container.querySelector('#vision-viewer');
        if (!home || !importContainer || !viewer) return;

        // Collapse import UI (text + button slide up and fade out)
        home.classList.add('vision-top');
        importContainer.classList.add('vision-import-hidden');

        // Reveal the viewer area and show spinner inside it at the same time
        viewer.classList.remove('hidden');
        viewer.style.opacity = '1';
        this._setLoading(true);
    }

    _showViewer() {
        const viewerContainer = this.container.querySelector('#vision-svg-viewer');
        const viewer = this.container.querySelector('#vision-viewer');

        if (!this.viewer) {
            this.viewer = new SvgViewer(viewerContainer, {
                onTransform: (state) => { this.viewerState = state; }
            });
        }
        // New import: center diagram. Window switching: restore exact position/zoom.
        if (this._centerOnNextShow) {
            this.viewer.setSvg(this.svgText, this.mainClassName);
            // Reset the view as if the user clicked the reset button (centers the new diagram).
            this.viewer.resetZoom();
            this._centerOnNextShow = false;
        } else {
            this.viewer.setSvg(this.svgText, this.mainClassName);
            this.viewer.restoreState(this.viewerState);
        }
        this._setLoading(false);
        if (viewer) viewer.style.opacity = '1';
        this.setTitle(`Vision: ${this.fileName}`);
    }

    _showVisionHome() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const viewer = this.container.querySelector('#vision-viewer');

        const finalizeHome = () => {
            this.svgText = '';
            this.fileName = '';
            this.mainClassName = '';
            if (this.viewer) {
                this.viewer.destroy();
                this.viewer = null;
            }
            this._updateHomeVisibility();
            this.setTitle(this.constructor.title);
        };

        if (!home || !viewer || viewer.classList.contains('hidden')) {
            finalizeHome();
            return;
        }

        // Keep viewer visible while header moves down; hide it once import UI is fully expanded
        if (importContainer) {
            importContainer.style.transition = 'none';
            importContainer.classList.remove('vision-import-hidden');
            importContainer.style.maxHeight = '';
            importContainer.style.opacity = '1';
            importContainer.style.transform = '';
            void importContainer.offsetHeight;
            importContainer.style.transition = '';
        }

        home.classList.remove('vision-top');
        home.style.justifyContent = 'flex-start';

        viewer.style.transition = 'opacity 0.45s ease';
        viewer.style.opacity = '0';

        this._homeTimeout = setTimeout(() => {
            this._homeTimeout = null;
            finalizeHome();
        }, 450);
    }

    _setLoading(isLoading) {
        const el = this.container.querySelector('#vision-loading');
        if (el) el.classList.toggle('hidden', !isLoading);
    }

    _showError(message) {
        const viewer = this.container.querySelector('#vision-viewer');
        if (viewer) {
            viewer.classList.remove('hidden');
            viewer.innerHTML = `<div class="text-red-500 text-sm p-4 flex items-center justify-center h-full">Erreur d'import : ${message}</div>`;
        }
    }

    getState() {
        return {
            fileName: this.fileName,
            svgText: this.svgText,
            mainClassName: this.mainClassName,
            viewerState: this.viewer ? this.viewer.getState() : this.viewerState,
        };
    }

    setState(state) {
        this.fileName = state.fileName || '';
        this.svgText = state.svgText || '';
        this.mainClassName = state.mainClassName || '';
        this.viewerState = state.viewerState || { scale: 1, x: 0, y: 0 };
        // Restoring from a saved state is a window switch, not a new import.
        this._centerOnNextShow = false;
        if (this.container) {
            this.render(this.container);
            this._updateHomeVisibility();
        }
    }

    _updateHomeVisibility() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const viewer = this.container.querySelector('#vision-viewer');
        if (!home || !importContainer || !viewer) return;

        if (this.svgText) {
            // Viewer mode: compact header, hidden import UI
            home.classList.add('vision-top');
            home.style.paddingTop = '';
            importContainer.classList.add('vision-import-hidden');
            viewer.classList.remove('hidden');
            viewer.style.opacity = '1';
            viewer.style.transition = '';
        } else {
            // Home mode: show import UI, hide viewer, vertically center content
            home.classList.remove('vision-top');
            const vh = this.container.clientHeight;
            const contentHeight = home.offsetHeight || 360;
            const offset = Math.max(0, (vh - contentHeight) / 2 - 24);
            home.style.paddingTop = offset + 'px';
            importContainer.classList.remove('vision-import-hidden');
            viewer.classList.add('hidden');
            viewer.style.opacity = '0';
            viewer.style.transition = '';
        }
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

window.VisionApp = VisionApp;
