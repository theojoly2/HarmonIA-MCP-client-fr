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
        this.loading = props.loading || false;
        // New imports/opened models should always start centered/scaled to fit.
        this.viewerState = { scale: 1, x: 0, y: 0 };
        this.viewer = null;
        this._centerOnNextShow = true;
        this._homeTimeout = null;
        this._loadingTimeout = null;
        this._resizeObserver = null;
        this._skipNextTransition = false;
    }

    static _closeOpenEditDialogs() {
        const openDialogs = document.querySelectorAll('.vision-edit-float');
        openDialogs.forEach((dialog) => dialog.remove());
    }

    static _hasOpenEditDialog() {
        return document.querySelectorAll('.vision-edit-float').length > 0;
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
                    <div id="vision-edit-actions" class="hidden absolute right-3 z-20 flex flex-col gap-3" style="top: calc(50% - (2.75rem + 0.75rem)); transform: translateY(-50%);">
                        <button type="button" id="vision-add-class" class="vision-edit-btn" title="Ajouter une classe">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                                <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                <path d="M12 9v6M9 12h6"></path>
                            </svg>
                            <span class="vision-edit-label">Classe</span>
                        </button>
                        <button type="button" id="vision-add-attr" class="vision-edit-btn" title="Ajouter un attribut">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                                <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                <path d="M8 10h8M8 14h5"></path>
                                <circle cx="18" cy="14" r="1.5" fill="currentColor"></circle>
                            </svg>
                            <span class="vision-edit-label">Attribut</span>
                        </button>
                        <button type="button" id="vision-add-connector" class="vision-edit-btn" title="Ajouter une relation">
                            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                                <rect x="3" y="8" width="7" height="8" rx="2"></rect>
                                <rect x="14" y="8" width="7" height="8" rx="2"></rect>
                                <path d="M10 12h4"></path>
                                <path d="M17 8v-2M17 18v-2M7 8V6M7 18v-2" opacity="0.5"></path>
                            </svg>
                            <span class="vision-edit-label">Relation</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
        this._bindEvents();
        if (this.loading) {
            // Loading state (e.g. opened from history): show the compact viewer with spinner immediately,
            // without animating the home panel down from the centered position.
            this._showLoadingState();
            if (this.svgText) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => this._showViewer());
                });
            }
        } else if (this.svgText) {
            // Normal import: glide the title up from the centered home position.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._enterLoadingMode());
            });
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => this._showViewer());
                });
            });
        } else {
            const home = this.container.querySelector('#vision-home');
            if (home) home.style.transition = 'none';
            this._skipNextTransition = true;
        this._observeResize();
        // Wait for the browser to finish layout before measuring height,
        // otherwise the first render computes an incorrect large offset.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._updateHomeVisibility(true);
                requestAnimationFrame(() => {
                    if (home) {
                        home.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.45s ease';
                    }
                    this._skipNextTransition = false;
                });
            });
        });
        }
    }

    _showLoadingState() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const dropZone = this.container.querySelector('#vision-drop-zone');
        const viewer = this.container.querySelector('#vision-viewer');
        if (!home || !importContainer || !viewer) return;

        if (this._homeTimeout) {
            clearTimeout(this._homeTimeout);
            this._homeTimeout = null;
        }
        if (this._loadingTimeout) {
            clearTimeout(this._loadingTimeout);
            this._loadingTimeout = null;
        }

        // Compact title at the top, viewer below, spinner centered in the viewer.
        importContainer.classList.add('vision-import-hidden');
        if (dropZone) dropZone.style.display = '';
        home.classList.add('vision-top');
        home.style.transition = 'none';
        home.style.paddingTop = '0px';
        home.style.paddingBottom = '0px';
        home.style.marginBottom = '0px';
        home.style.minHeight = 'auto';
        home.style.position = 'relative';
        home.style.zIndex = '25';

        const app = this.container.querySelector('.vision-app');
        if (app) app.classList.add('vision-loading-layout');

        viewer.classList.remove('hidden');
        viewer.style.transition = 'none';
        viewer.style.opacity = '1';
        viewer.style.display = 'flex';

        void home.offsetHeight;
        void viewer.offsetHeight;

        this._setLoading(true);
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
        this._bindEditEvents();
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

            // Persist model to user history when logged in.
            // If not logged in, store the import as pending only while this Vision instance stays open.
            if (AuthManager.isLoggedIn()) {
                try {
                    await ApiClient.importAndSaveModel(file, file.name);
                    if (window.historyPanel) window.historyPanel.load();
                } catch (err) {
                    console.error('Model save error', err);
                }
            } else {
                AuthManager.setPendingImport(file, file.name, this.svgText);
            }
        } catch (err) {
            console.error('Vision import error', err);
            this._setLoading(false);
            this._showError(err.message);
        }
    }

    _enterLoadingMode() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const dropZone = this.container.querySelector('#vision-drop-zone');
        const viewer = this.container.querySelector('#vision-viewer');
        if (!home || !importContainer || !viewer) return;

        // Get current centered padding and animate it to 0 (compact header) as the import begins.
        const startPadding = parseFloat(getComputedStyle(home).paddingTop) || 0;
        home.style.transition = 'none';
        home.style.paddingTop = startPadding + 'px';
        home.classList.remove('vision-top');
        void home.offsetHeight;

        // Animate the title upward while the import UI collapses.
        home.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
        home.style.paddingTop = '0px';
        importContainer.classList.add('vision-import-hidden');
        if (dropZone) dropZone.style.display = 'none';

        // Reveal the viewer area and fade it in as the title glides up.
        viewer.classList.remove('hidden');
        viewer.style.transition = 'none';
        viewer.style.opacity = '1';
        void viewer.offsetHeight;
        this._setLoading(true);

        // Lock the compact viewer state once the upward glide finishes.
        if (this._loadingTimeout) clearTimeout(this._loadingTimeout);
        this._loadingTimeout = setTimeout(() => {
            home.classList.add('vision-top');
            home.style.transition = '';
            home.style.paddingTop = '';
        }, 550);
    }

    _showViewer() {
        const viewerContainer = this.container.querySelector('#vision-svg-viewer');
        const viewer = this.container.querySelector('#vision-viewer');
        const app = this.container.querySelector('.vision-app');
        const editActions = this.container.querySelector('#vision-edit-actions');
        if (app) app.classList.remove('vision-loading-layout');

        if (!this.viewer) {
            this.viewer = new SvgViewer(viewerContainer, {
                onTransform: (state) => { this.viewerState = state; }
            });
        }
        this.viewer.setSvg(this.svgText, this.mainClassName);
        // New import/open from history/preview: center diagram after it becomes visible.
        // Returning from another tab: restore the saved pan/zoom.
        if (this._centerOnNextShow) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.viewer.resetZoom();
                    this._centerOnNextShow = false;
                });
            });
        } else {
            this.viewer.restoreState(this.viewerState);
        }
        this._setLoading(false);
        if (viewer) viewer.style.opacity = '1';
        if (editActions) {
            editActions.classList.remove('hidden');
            this._updateEditButtonStates();
        }
        this.setTitle(`Vision: ${this.fileName}`);
    }

    _showVisionHome() {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const viewer = this.container.querySelector('#vision-viewer');
        const app = this.container.querySelector('.vision-app');

        if (app) app.classList.remove('vision-loading-layout');

        if (!home || !viewer || viewer.classList.contains('hidden')) {
            this._finalizeHomeAndCenter(true);
            return;
        }

        // Compute final centered offset for the home view.
        const contentHeight = this._measureHomeContentHeight(home);
        const available = Math.max(this.container.clientHeight, contentHeight);
        const finalOffset = Math.max(0, (available - contentHeight) / 2);

        // Stage the import container hidden so it can fade in later.
        if (importContainer) {
            importContainer.classList.remove('vision-import-hidden');
            importContainer.style.display = '';
            importContainer.style.transition = 'none';
            importContainer.style.opacity = '0';
            importContainer.style.transform = 'translateY(-16px)';
        }

        // Remove compact class and reset padding so we can animate from the current viewer layout.
        home.classList.remove('vision-top');

        // Start the title/diagram descent using paddingTop in the normal flex flow.
        home.style.transition = 'none';
        home.style.paddingTop = '0px';
        void home.offsetHeight;

        requestAnimationFrame(() => {
            home.style.transition = 'padding-top 0.7s cubic-bezier(0.4, 0, 0.2, 1)';
            home.style.paddingTop = finalOffset + 'px';

            // Fade out the diagram viewer as it follows the title downward naturally.
            viewer.style.transition = 'opacity 0.7s ease';
            viewer.style.opacity = '0';
        });

        // Fade in the import container so it is fully visible when the title reaches center.
        if (importContainer) {
            setTimeout(() => {
                void importContainer.offsetHeight;
                importContainer.style.transition = 'opacity 0.55s ease, transform 0.55s cubic-bezier(0.16, 1, 0.3, 1)';
                requestAnimationFrame(() => {
                    importContainer.style.opacity = '1';
                    importContainer.style.transform = 'translateY(0)';
                });
            }, 250);
        }

        // When the fade-out completes, clean up state and lock the home layout.
        this._homeTimeout = setTimeout(() => {
            this._homeTimeout = null;
            this.svgText = '';
            this.fileName = '';
            this.mainClassName = '';
            this.loading = false;
            this.viewerState = { scale: 1, x: 0, y: 0 };
            if (this.viewer) {
                this.viewer.destroy();
                this.viewer = null;
            }
            this._updateHomeVisibility(true);
            this.setTitle(this.constructor.title);
            if (importContainer) {
                importContainer.style.display = '';
            }
            const dropZone = this.container.querySelector('#vision-drop-zone');
            if (dropZone) dropZone.style.display = '';
        }, 700);
    }

    _finalizeHomeAndCenter(skipTransition) {
        this.svgText = '';
        this.fileName = '';
        this.mainClassName = '';
        if (this.viewer) {
            this.viewer.destroy();
            this.viewer = null;
        }
        this._updateHomeVisibility(skipTransition);
        this.setTitle(this.constructor.title);
    }

    _extractClassNames() {
        if (!this.svgText) return [];
        // Extract class names from SVG nodes. PlantUML generates <g class="entity">
        // groups where the first <text> inside is the class title.
        const parser = new DOMParser();
        const doc = parser.parseFromString(this.svgText, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return [];
        const names = new Set();
        svg.querySelectorAll('g.entity').forEach((g) => {
            const title = g.querySelector('text');
            if (!title) return;
            const label = (title.textContent || '').trim();
            if (label && label !== 'Unnamed' && !label.startsWith('«')) {
                names.add(label);
            }
        });
        // Fallback for the flat visualisation.py generator used offline.
        if (names.size === 0) {
            const rects = Array.from(svg.querySelectorAll('rect'));
            rects.forEach((rect) => {
                const x = parseFloat(rect.getAttribute('x'));
                const y = parseFloat(rect.getAttribute('y'));
                const w = parseFloat(rect.getAttribute('width'));
                const h = parseFloat(rect.getAttribute('height'));
                if (!w || !h || w < 30 || h < 30) return;
                const textEls = Array.from(svg.querySelectorAll('text')).filter((t) => {
                    const fw = t.getAttribute('font-weight');
                    const tx = parseFloat(t.getAttribute('x'));
                    const ty = parseFloat(t.getAttribute('y'));
                    return fw === 'bold' && tx >= x - 1 && tx <= x + w + 1 && ty >= y - 1 && ty <= y + 30;
                });
                for (const t of textEls) {
                    const label = (t.textContent || '').trim();
                    if (label && label !== 'Unnamed' && !label.startsWith('«')) {
                        names.add(label);
                        break;
                    }
                }
            });
        }
        return Array.from(names).sort();
    }

    _bindEditEvents() {
        const addClassBtn = this.container.querySelector('#vision-add-class');
        const addAttrBtn = this.container.querySelector('#vision-add-attr');
        const addConnectorBtn = this.container.querySelector('#vision-add-connector');
        if (addClassBtn) addClassBtn.addEventListener('click', () => this._showAddClassDialog());
        if (addAttrBtn) addAttrBtn.addEventListener('click', () => this._showAddAttributeDialog());
        if (addConnectorBtn) addConnectorBtn.addEventListener('click', () => this._showAddConnectorDialog());
        this._updateEditButtonStates();
    }

    _updateEditButtonStates() {
        const addClassBtn = this.container.querySelector('#vision-add-class');
        const addAttrBtn = this.container.querySelector('#vision-add-attr');
        const addConnectorBtn = this.container.querySelector('#vision-add-connector');
        const classes = this._extractClassNames();
        const disabledClass = 'vision-edit-btn-disabled';
        if (addClassBtn) {
            addClassBtn.disabled = false;
            addClassBtn.classList.remove(disabledClass);
            addClassBtn.title = 'Ajouter une classe';
        }
        if (addAttrBtn) {
            const noClasses = classes.length === 0;
            addAttrBtn.disabled = noClasses;
            addAttrBtn.classList.toggle(disabledClass, noClasses);
            addAttrBtn.title = noClasses ? 'Aucune classe disponible' : 'Ajouter un attribut';
        }
        if (addConnectorBtn) {
            const noClasses = classes.length === 0;
            addConnectorBtn.disabled = noClasses;
            addConnectorBtn.classList.toggle(disabledClass, noClasses);
            addConnectorBtn.title = noClasses ? 'Aucune classe disponible' : 'Ajouter une relation';
        }
    }

    _showAddClassDialog() {
        VisionApp._closeOpenEditDialogs();
        const fields = [
            { id: 'cls-title', label: 'Nom de la classe', required: true, help: 'Nom unique qui identifie la classe dans le modèle.' },
            { id: 'cls-definition', label: 'Définition', type: 'textarea', help: 'Description claire du rôle et du sens de cette classe.' },
            { id: 'cls-usage', label: "Note d'utilisation", type: 'textarea', help: 'Conseils ou contraintes pratiques pour utiliser cette classe.' },
            { id: 'cls-uri', label: 'URI (optionnel)', help: 'Identifiant permanent (URL) permettant de référencer cette classe.' },
            { id: 'cls-package', label: 'Package (optionnel)', help: 'Groupe logique auquel rattacher cette classe (ex. Admin, Produit).' },
        ];
        this._showFloatingDialog('Ajouter une classe', fields, async (values, overlay) => {
            overlay.querySelector('.vision-edit-submit').disabled = true;
            overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrement...';
            try {
                this._setLoading(true);
                const res = await fetch(`api/models/${encodeURIComponent(this.fileName)}/add-class`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        title: values['cls-title'],
                        definition: values['cls-definition'] || '',
                        usage_note: values['cls-usage'] || '',
                        uri: values['cls-uri'] || null,
                        package: values['cls-package'] || null,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
                await this._reloadSvgFromServer();
            } catch (err) {
                console.error('Add class error', err);
                alert(err.message || "Impossible d'ajouter la classe.");
            } finally {
                this._setLoading(false);
                if (overlay.parentNode) {
                    overlay.querySelector('.vision-edit-submit').disabled = false;
                    overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrer';
                }
            }
        });
    }

    _showAddAttributeDialog() {
        VisionApp._closeOpenEditDialogs();
        const classes = this._extractClassNames();
        if (!classes.length) {
            return;
        }
        const classOptions = classes.map((c) => `<option value="${this._escape(c)}">${this._escape(c)}</option>`).join('');
        const predefinedTypes = [
            'string',
            'integer',
            'boolean',
            'decimal',
            'date',
            'dateTime',
            'uri',
            'anyURI',
        ];
        const typeOptions = [
            '<option value="">— Sélectionner —</option>',
            ...predefinedTypes.map((t) => `<option value="${this._escape(t)}">${this._escape(t)}</option>`),
            '<option value="__other__">Autre…</option>',
        ].join('');
        const fields = [
            { id: 'attr-class', label: 'Classe', type: 'select', options: classOptions, required: true, help: 'Classe à laquelle rattacher cet attribut.' },
            { id: 'attr-label', label: "Nom de l'attribut", required: true, help: "Nom de la propriété (ex. nom, dateNaissance, montant)." },
            { id: 'attr-definition', label: 'Définition', type: 'textarea', help: 'Description du contenu et du rôle de cet attribut.' },
            { id: 'attr-uri', label: 'URI', required: true, help: "Identifiant de l'attribut, souvent une URL du vocabulaire utilisé." },
            { id: 'attr-type', label: 'Type', type: 'select', options: typeOptions, required: true, help: "Type de données attendu pour la valeur de l'attribut." },
            { id: 'attr-type-other', label: 'Type personnalisé', className: 'hidden', requiredWhenVisible: true, help: 'Précisez un type non présent dans la liste prédéfinie.' },
            { id: 'attr-lower', label: 'Borne inférieure (optionnel)', help: 'Nombre minimal de valeurs autorisées (ex. 0, 1).' },
            { id: 'attr-upper', label: 'Borne supérieure (optionnel)', help: 'Nombre maximal de valeurs autorisées (ex. 1, *, 5).' },
            { id: 'attr-usage', label: "Note d'utilisation", type: 'textarea', help: 'Précisions sur le format, les règles de saisie ou les contraintes.' },
        ];
        const onOpen = (overlay) => {
            const typeSelect = overlay.querySelector('#attr-type');
            const otherWrapper = overlay.querySelector('#attr-type-other')?.closest('.mb-3');
            if (typeSelect && otherWrapper) {
                const update = () => {
                    otherWrapper.classList.toggle('hidden', typeSelect.value !== '__other__');
                };
                typeSelect.addEventListener('change', update);
                update();
            }
        };
        this._showFloatingDialog("Ajouter un attribut", fields, async (values, overlay) => {
            overlay.querySelector('.vision-edit-submit').disabled = true;
            overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrement...';
            try {
                this._setLoading(true);
                let attrType = values['attr-type'];
                if (attrType === '__other__') {
                    attrType = values['attr-type-other'];
                }
                const res = await fetch(`api/models/${encodeURIComponent(this.fileName)}/add-attribute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        class_name: values['attr-class'],
                        attr_label: values['attr-label'],
                        attr_definition: values['attr-definition'] || '',
                        attr_uri: values['attr-uri'] || '',
                        attr_usage_note: values['attr-usage'] || '',
                        attr_type: attrType || '',
                        lower_bounds: values['attr-lower'] || '',
                        upper_bounds: values['attr-upper'] || '',
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
                await this._reloadSvgFromServer();
            } catch (err) {
                console.error('Add attribute error', err);
                alert(err.message || "Impossible d'ajouter l'attribut.");
            } finally {
                this._setLoading(false);
                if (overlay.parentNode) {
                    overlay.querySelector('.vision-edit-submit').disabled = false;
                    overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrer';
                }
            }
        }, onOpen);
    }

    _showAddConnectorDialog() {
        VisionApp._closeOpenEditDialogs();
        const classes = this._extractClassNames();
        if (!classes.length) {
            return;
        }
        const classOptions = classes.map((c) => `<option value="${this._escape(c)}">${this._escape(c)}</option>`).join('');
        const relationshipTypes = [
            'Association',
            'Aggregation',
            'Composition',
            'Generalization',
            'Dependency',
        ];
        const relationshipOptions = relationshipTypes.map((t) => `<option value="${this._escape(t)}"${t === 'Association' ? ' selected' : ''}>${this._escape(t)}</option>`).join('');
        const multiplicityOptions = [
            '<option value="">—</option>',
            '<option value="0..1">0..1</option>',
            '<option value="1">1</option>',
            '<option value="0..*">0..*</option>',
            '<option value="1..*">1..*</option>',
            '<option value="*">*</option>',
        ].join('');
        const fields = [
            { id: 'conn-source', label: 'Classe source', type: 'select', options: classOptions, required: true, help: 'Classe de départ de la relation (peut être identique à la cible).' },
            { id: 'conn-target', label: 'Classe cible', type: 'select', options: classOptions, required: true, help: 'Classe d\'arrivée de la relation.' },
            { id: 'conn-label', label: 'Nom de la relation', required: true, help: 'Nom lisible décrivant le lien entre les deux classes (ex. possède, appartient à).' },
            { id: 'conn-definition', label: 'Définition', type: 'textarea', help: 'Description du sens et des règles métier de la relation.' },
            { id: 'conn-uri', label: 'URI', required: true, help: 'Identifiant permanent de la relation, souvent une URL.' },
            { id: 'conn-type', label: 'Type de relation', type: 'select', options: relationshipOptions, required: true, help: 'Nature sémantique du lien (Association, Agrégation, Composition…).' },
            { id: 'conn-lb', label: 'Multiplicité source (optionnel)', type: 'select', options: multiplicityOptions, help: "Nombre d'instances de la classe source liées à une cible." },
            { id: 'conn-rb', label: 'Multiplicité cible (optionnel)', type: 'select', options: multiplicityOptions, help: "Nombre d'instances de la classe cible liées à une source." },
            { id: 'conn-lt', label: 'Rôle source (optionnel)', help: 'Nom du rôle joué par la classe source dans la relation.' },
            { id: 'conn-rt', label: 'Rôle cible (optionnel)', help: 'Nom du rôle joué par la classe cible dans la relation.' },
            { id: 'conn-usage', label: "Note d'utilisation", type: 'textarea', help: 'Précisions sur les conditions d\'utilisation ou les contraintes.' },
        ];
        this._showFloatingDialog('Ajouter une relation', fields, async (values, overlay) => {
            overlay.querySelector('.vision-edit-submit').disabled = true;
            overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrement...';
            try {
                this._setLoading(true);
                const res = await fetch(`api/models/${encodeURIComponent(this.fileName)}/add-connector`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        source_name: values['conn-source'],
                        target_name: values['conn-target'],
                        rel_label: values['conn-label'],
                        rel_definition: values['conn-definition'] || '',
                        rel_uri: values['conn-uri'] || '',
                        relationship: values['conn-type'] || 'Association',
                        lb: values['conn-lb'] || '',
                        rb: values['conn-rb'] || '',
                        lt: values['conn-lt'] || '',
                        rt: values['conn-rt'] || '',
                        rel_usage_note: values['conn-usage'] || '',
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || `Erreur ${res.status}`);
                await this._reloadSvgFromServer();
            } catch (err) {
                console.error('Add connector error', err);
                alert(err.message || "Impossible d'ajouter la relation.");
            } finally {
                this._setLoading(false);
                if (overlay.parentNode) {
                    overlay.querySelector('.vision-edit-submit').disabled = false;
                    overlay.querySelector('.vision-edit-submit').textContent = 'Enregistrer';
                }
            }
        });
    }

    _syncEditDialogScroll(win) {
        const body = win.querySelector('.window-body');
        if (!body) return;
        const scrollArea = body.querySelector('.vision-edit-body');
        if (scrollArea) {
            scrollArea.style.maxHeight = (body.clientHeight) + 'px';
        }
        body.style.height = (win.clientHeight - (win.querySelector('.window-header')?.offsetHeight || 40) - (win.querySelector('.resize-handle')?.offsetHeight || 0)) + 'px';
    }

    async _reloadSvgFromServer() {
        const encodedName = encodeURIComponent(this.fileName);
        const res = await fetch(`api/models/${encodedName}/open`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('reload_failed');
        this.svgText = await res.text();
        if (this.viewer) {
            this.viewer.setSvg(this.svgText, this.mainClassName);
            this.viewer.restoreState(this.viewerState);
        }
    }

    _showFloatingDialog(title, fields, onSubmit, onOpen) {
        // Close any existing edit dialog first (only one floating edit window at a time).
        VisionApp._closeOpenEditDialogs();

        const floatWin = UiUtils.createFloatingWindow({
            title,
            width: 420,
            height: 520,
            onClose: () => {},
            onFocus: () => {},
            onResize: () => { this._syncEditDialogScroll(floatWin.win); },
            onResizeEnd: () => { this._syncEditDialogScroll(floatWin.win); }
        });
        floatWin.win.classList.add('vision-edit-float');
        floatWin.win.style.minHeight = '260px';
        floatWin.win.style.maxHeight = '85vh';
        const root = document.getElementById('floating-root') || document.body;
        root.appendChild(floatWin.win);
        const baseTop = 160;
        const floatRect = floatWin.win.getBoundingClientRect();
        const left = (window.innerWidth - floatRect.width) / 2;
        floatWin.win.style.left = left + 'px';
        floatWin.win.style.top = baseTop + 'px';
        floatWin.win.style.transform = 'none';
        UiUtils.clampWindowPosition(floatWin.win);

        const body = floatWin.body;
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.overflow = 'hidden';
        const optionsHtml = (opts) => opts || '';
        const infoIcon = (help) => help ? `<span class="vision-field-help" title="${this._escape(help)}">i</span>` : '';
        const inputsHtml = fields.map((f) => {
            const label = `<label class="block text-sm font-semibold text-gray-700 mb-1 ${this._escape(f.labelClass || '')}" for="${f.id}"><span class="flex items-center gap-1.5">${this._escape(f.label)}${f.required ? ' *' : ''}${infoIcon(f.help)}</span></label>`;
            let input;
            if (f.type === 'textarea') {
                input = `<textarea id="${f.id}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none" rows="3" ${f.required ? 'required' : ''}>${this._escape(f.value || '')}</textarea>`;
            } else if (f.type === 'select') {
                input = `<select id="${f.id}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none bg-white" ${f.required ? 'required' : ''}>${optionsHtml(f.options)}</select>`;
            } else {
                input = `<input type="text" id="${f.id}" value="${this._escape(f.value || '')}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none" ${f.required ? 'required' : ''}>`;
            }
            return `<div class="mb-3 ${this._escape(f.className || '')}">${label}${input}</div>`;
        }).join('');
        body.innerHTML = `
            <div class="vision-edit-body" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 1.25rem;">
                <form id="vision-edit-form">
                    ${inputsHtml}
                    <div class="vision-edit-error hidden" id="dialog-error"></div>
                    <button type="submit" class="vision-edit-submit">Enregistrer</button>
                </form>
            </div>
        `;
        requestAnimationFrame(() => this._syncEditDialogScroll(floatWin.win));

        const form = body.querySelector('#vision-edit-form');
        const submitBtn = body.querySelector('.vision-edit-submit');

        if (onOpen) {
            onOpen(body);
        }

        const close = () => floatWin.win.remove();
        const closeBtn = floatWin.win.querySelector('.window-close');
        if (closeBtn) closeBtn.addEventListener('click', close);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            // Dynamically toggle required attributes for conditional fields
            fields.forEach((f) => {
                if (f.requiredWhenVisible) {
                    const wrapper = body.querySelector(`#${f.id}`)?.closest('.mb-3');
                    const el = body.querySelector(`#${f.id}`);
                    if (wrapper && el) {
                        const visible = !wrapper.classList.contains('hidden');
                        if (visible) {
                            el.setAttribute('required', '');
                        } else {
                            el.removeAttribute('required');
                        }
                    }
                }
            });
            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }
            const values = {};
            fields.forEach((f) => {
                const el = body.querySelector(`#${f.id}`);
                values[f.id] = el ? el.value.trim() : '';
            });
            submitBtn.disabled = true;
            submitBtn.textContent = 'Enregistrement...';
            Promise.resolve(onSubmit(values, body)).then(close).catch((err) => {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Enregistrer';
                const errorEl = body.querySelector('#dialog-error');
                if (errorEl) {
                    errorEl.textContent = err.message || 'Une erreur est survenue.';
                    errorEl.classList.remove('hidden');
                }
            });
        });
    }

    _escape(text) {
        return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        // Only keep the previous pan/zoom if this is the exact same SVG being
        // restored (e.g. tab switch). A new file from history/preview must reset.
        const sameSvg = this.svgText === (state.svgText || '');
        this.viewerState = sameSvg ? (state.viewerState || { scale: 1, x: 0, y: 0 }) : { scale: 1, x: 0, y: 0 };
        this._centerOnNextShow = !sameSvg;
        if (this.container) {
            this.render(this.container);
        }
    }

    _measureHomeContentHeight(home) {
        let contentHeight = 0;
        for (const child of home.children) {
            const rect = child.getBoundingClientRect();
            const styles = getComputedStyle(child);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            contentHeight += rect.height + marginTop + marginBottom;
        }
        return Math.max(contentHeight, 360);
    }

    _updateHomeVisibility(skipTransition) {
        const home = this.container.querySelector('#vision-home');
        const importContainer = this.container.querySelector('#vision-import-container');
        const viewer = this.container.querySelector('#vision-viewer');
        if (!home || !importContainer || !viewer) return;

        if (this.svgText) {
            // Viewer mode: compact header, hidden import UI
            home.classList.add('vision-top');
            home.style.paddingTop = '0px';
            importContainer.classList.add('vision-import-hidden');
            viewer.classList.remove('hidden');
            viewer.style.opacity = '1';
            viewer.style.transition = '';
        } else {
            // Home mode: show import UI, hide viewer, vertically centered by paddingTop.
            // Measure the children directly so the current padding does not influence it.
            const was = home.style.transition;
            if (skipTransition || this._skipNextTransition) home.style.transition = 'none';
            home.classList.remove('vision-top');
            const contentHeight = this._measureHomeContentHeight(home);
            const available = Math.max(this.container.clientHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2);
            home.style.paddingTop = offset + 'px';
            if (skipTransition || this._skipNextTransition) {
                home.offsetHeight; // force reflow
                home.style.transition = was;
            }
            importContainer.classList.remove('vision-import-hidden');
            viewer.classList.add('hidden');
            viewer.style.opacity = '0';
            viewer.style.transition = '';
        }
    }

    _observeResize() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (!this.container || typeof ResizeObserver === 'undefined') return;
        this._resizeObserver = new ResizeObserver(() => {
            if (!this.svgText) this._updateHomeVisibility(true);
        });
        this._resizeObserver.observe(this.container);
    }

    unmount() {
        if (this.viewer) {
            this.viewerState = this.viewer.getState();
            this.viewer.destroy();
            this.viewer = null;
        }
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        super.unmount();
    }
}

window.VisionApp = VisionApp;
