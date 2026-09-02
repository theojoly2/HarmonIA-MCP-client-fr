/**
 * SearchApp
 * Module Chercher des modèles.
 */

class SearchApp extends AppBase {
    static id = "search";
    static title = "Chercher";
    static iconSvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>`;
    static canFloat = true;
    static canSplit = true;
    static singleton = true;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.query = props.query || "";
        this.selectedTags = props.tags || [];
        this.results = [];
        this.tagsHtml = "";
        this.loading = false;
        this.timerInterval = null;
        this._resizeObserver = null;
        this._skipNextTransition = false;
        this._firstTagAnimation = true;
        this._introAnimating = false;
        this._introAnimationDone = false;
        this._skipHistorySave = !!props.fromHistory;
        this.selectedAssistantModels = [];
        this.maxAssistantModels = 3;
    }

    async render(container) {
        // If the container is the cached live DOM, just resume observers and
        // focus without rebuilding, so scroll / selection / results stay intact.
        if (this.container === container && container.querySelector('#search-wrapper-inner')) {
            this._observeResize();
            this._updateHomeModeClass();
            this._renderAssistantModelBar();
            this._updateAddModelButtons();
            this._renderLoginBanner();
            const input = container.querySelector('#search-input');
            if (input) input.focus();
            return;
        }
        this.container = container;
        // The tag intro animation runs only once per instance. After that,
        // switching back to the tab should restore the already-revealed tags.
        const showTags = !this._introAnimationDone && this._firstTagAnimation;
        if (showTags) {
            this._firstTagAnimation = false;
            this._introAnimating = true;
            this._tagsReady = false;
            this._layoutReady = false;
            // Start loading tags in parallel; the reveal fires as soon as both tags and layout are ready.
            this._loadTags().then(() => this._checkRevealReady());
        }
        // Hide tags initially so only the title/search bar affect the first centering.
        // Start with the wrapper invisible to avoid a flash at the top before centering is applied.
        container.innerHTML = `
            <div class="search-app h-full overflow-y-auto px-4 sm:px-6">
                <div id="search-wrapper-inner" class="mx-auto" style="transition: none; opacity: 0;">
                    <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8">
                        <a href="?" class="interactive-title" title="Réinitialiser la recherche">
                            <span class="title-glow">Chercher des modèles</span>
                        </a>
                    </h1>
                    <form id="search-form" class="mb-4">
                        <div class="search-wrapper" id="search-wrapper">
                            <input type="text" name="q" id="search-input"
                                placeholder="Entrez votre recherche..." required
                                class="w-full rounded-full border-2 border-gray-300 focus:outline-none focus:border-black font-medium transition-colors placeholder-gray-500"
                                value="${this._escape(this.query)}">
                            <button type="submit" id="submit-btn"
                                class="absolute right-2 top-2 bottom-2 text-white rounded-full font-bold disabled:bg-gray-400 whitespace-nowrap overflow-hidden">
                                <span class="btn-label">Chercher</span>
                            </button>
                        </div>
                        <div id="tags-container" class="mt-5 flex flex-wrap gap-2 justify-center ${showTags ? 'tags-staged' : ''}">
                            ${showTags ? '' : (this.tagsHtml || '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>')}
                        </div>
                    </form>
                    <div id="loading-indicator" class="text-center mt-2 mb-6">
                        <span class="text-xs font-bold tracking-widest uppercase text-gray-400">Recherche en cours</span>
                        <span id="elapsed-timer"></span>
                    </div>
                    <div id="results-container" class="mt-4 pb-12">${this.resultsHtml || ''}</div>
                </div>
                <div id="search-login-banner" class="hidden mx-auto max-w-2xl mb-3 px-4"></div>
                <div id="search-assistant-models-bar" class="search-assistant-models-bar hidden">
                    <div id="search-assistant-models-pills" class="search-assistant-models-pills"></div>
                    <button type="button" id="search-open-assistant-btn" class="search-open-assistant-btn" title="Discuter avec l'assistant Analyser">
                        <svg class="w-5 h-5" viewBox="0 0 24 24">
                            <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                            <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                            <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
        this._bindEvents();
        this._updateHomeModeClass();
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        if (wrapper) wrapper.style.transition = 'none';
        this._skipNextTransition = true;
        if (!showTags) this._observeResize();
        if (this.resultsHtml) {
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) resultsContainer.classList.add('results-visible');
        }
        this._renderLoginBanner();
        // Stage 1: center title + search bar only.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._applyCentering(true);
                requestAnimationFrame(() => {
                    if (wrapper) {
                        wrapper.style.transition = 'padding-top 0.85s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.55s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease';
                        wrapper.style.opacity = '1';
                    }
                    this._skipNextTransition = false;
                    if (showTags) {
                        this._layoutReady = true;
                        this._checkRevealReady();
                    } else {
                        this._observeResize();
                    }
                });
            });
        });
    }

    _checkRevealReady() {
        if (this._tagsReady && this._layoutReady) {
            this._revealTags();
        }
    }

    _updateHomeModeClass() {
        const app = this.container.querySelector('.search-app');
        if (!app) return;
        if (!this.query && !this.resultsHtml) {
            app.classList.add('home-mode');
        } else {
            app.classList.remove('home-mode');
        }
    }

    _escape(text) {
        return text.replace(/"/g, '&quot;');
    }

    _bindEvents() {
        const form = this.container.querySelector('#search-form');
        const input = this.container.querySelector('#search-input');
        const tagsContainer = this.container.querySelector('#tags-container');
        const resultsContainer = this.container.querySelector('#results-container');

        const titleLink = this.container.querySelector('h1 a.interactive-title');
        if (titleLink) {
            titleLink.addEventListener('click', (e) => {
                e.preventDefault();
                const resultsContainer = this.container.querySelector('#results-container');
                const hasResults = !!(this.resultsHtml && this.resultsHtml.trim().length > 0);

                const doReset = () => {
                    this.query = '';
                    this.resultsHtml = '';
                    this.selectedTags = [];
                    input.value = '';
                    if (resultsContainer) {
                        resultsContainer.innerHTML = '';
                        resultsContainer.classList.remove('results-hiding');
                        resultsContainer.style.display = '';
                        resultsContainer.style.visibility = '';
                    }
                    this._updateHomeModeClass();
                    this._applyCentering();
                    this.container.scrollTo({ top: 0, behavior: 'smooth' });
                    this._loadTags();
                };

                if (hasResults) {
                    this.container.scrollTo({ top: 0, behavior: 'smooth' });
                    resultsContainer.classList.add('results-hiding');
                    resultsContainer.addEventListener('animationend', () => {
                        resultsContainer.style.visibility = 'hidden';
                        resultsContainer.style.display = 'none';
                        doReset();
                    }, { once: true });
                } else {
                    doReset();
                }
            });
        }

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const hasResults = !!(this.resultsHtml && this.resultsHtml.trim().length > 0);

            const start = () => {
                this.query = input.value.trim();
                this.selectedTags = Array.from(tagsContainer.querySelectorAll('input[name="t"]:checked')).map(cb => cb.value);
                this._updateHomeModeClass();

                // _runSearch handles loading state, timer and centering.
                this._runSearch();
            };

            if (hasResults) {
                this.container.scrollTo({ top: 0, behavior: 'smooth' });
                const onScroll = () => {
                    if (this.container.scrollTop <= 5) {
                        this.container.removeEventListener('scroll', onScroll);
                        clearTimeout(fallback);
                        start();
                    }
                };
                const fallback = setTimeout(() => {
                    this.container.removeEventListener('scroll', onScroll);
                    start();
                }, 600);
                this.container.addEventListener('scroll', onScroll);
            } else {
                start();
            }
        });

        tagsContainer.addEventListener('change', (e) => {
            if (e.target.name === 't') {
                this.selectedTags = Array.from(tagsContainer.querySelectorAll('input[name="t"]:checked')).map(cb => cb.value);
            }
        });

        const resultsContainerClick = this.container.querySelector('#results-container');
        resultsContainerClick.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const docId = btn.dataset.docId;
            const documentId = btn.dataset.documentId;
            const name = btn.dataset.name;
            const filename = btn.dataset.filename;
            const extension = btn.dataset.extension;
            if (action === 'preview') {
                EventBus.emit('open-preview', { docId, documentId, name });
            } else if (action === 'chat') {
                EventBus.emit('open-chat', { documentId, name });
            } else if (action === 'add-to-assistant') {
                if (!AuthManager.isLoggedIn()) {
                    if (this.authManager) this.authManager.showModal();
                    return;
                }
                console.log('[SearchApp] add-to-assistant clicked', { docId, filename, extension });
                this._toggleAssistantModel(docId, filename, extension);
            }
        });

        const assistantBtn = this.container.querySelector('#search-open-assistant-btn');
        if (assistantBtn) {
            assistantBtn.addEventListener('click', () => this._openAssistantWithSelectedModels());
        }
    }

    async _loadTags() {
        if (this.tagsHtml) return;
        try {
            const data = await ApiClient.getTags();
            const tags = data.tags || [];
            this.tagsHtml = this._buildTagsHtml(tags);
            this._tagsReady = true;
        } catch (e) {
            console.error('Erreur chargement tags', e);
            this.tagsHtml = '';
            this._tagsReady = true;
        }
    }

    _buildTagsHtml(tags) {
        if (!tags.length) return '';
        return tags.map(t => {
            const tagName = (typeof t === 'object' ? t.tag : t) || '';
            const isChecked = this.selectedTags.includes(tagName) ? 'checked' : '';
            return `
                <label class="cursor-pointer select-none tag-label" title="${tagName}">
                    <input type="checkbox" name="t" value="${tagName}" class="peer hidden" ${isChecked}>
                    <span class="inline-flex items-center rounded-full font-bold border-2 border-gray-200 text-gray-700 peer-checked:bg-black peer-checked:text-white peer-checked:border-black hover:border-gray-400 transition-colors overflow-hidden relative">
                        <svg class="icon-unchecked w-3.5 h-3.5 mr-1.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                        <svg class="icon-checked w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                        ${tagName}
                    </span>
                </label>
            `;
        }).join('');
    }

    _injectTagsHtml() {
        const tagsContainer = this.container ? this.container.querySelector('#tags-container') : null;
        if (!tagsContainer) return;
        tagsContainer.innerHTML = this.tagsHtml || '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>';
        if (window.GlowEffects) window.GlowEffects.scanAndBind();
    }

    _renderTags(tags) {
        this.tagsHtml = this._buildTagsHtml(tags);
        this._injectTagsHtml();
    }

    _revealTags() {
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        const tagsContainer = this.container.querySelector('#tags-container');
        if (!tagsContainer) return;
        tagsContainer.classList.remove('tags-staged');
        tagsContainer.innerHTML = this.tagsHtml || '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>';
        if (window.GlowEffects) window.GlowEffects.scanAndBind();
        // Re-measure with tags and glide the title/bar upward.
        if (wrapper) wrapper.offsetHeight;
        this._applyCentering();
        if (wrapper) {
            const labels = tagsContainer.querySelectorAll('.tag-label');
            labels.forEach((el, i) => {
                el.classList.add('tag-land');
                el.style.animationDelay = (i * 0.18) + 's';
            });
        }
        // Mark the intro animation as finished so it does not run again when
        // the user switches back to this tab.
        this._introAnimationDone = true;
        // Re-enable resize observer after the intro animation finishes.
        setTimeout(() => {
            this._introAnimating = false;
            this._observeResize();
        }, 1600);
    }

    async _runSearch() {
        if (!this.query) return;
        this._setLoading(true);
        this._startTimer();
        this._setLoading(true);
        this._updateHomeModeClass();
        this._applyCentering();
        // Clear previous results immediately so stale content is not shown during loading.
        const resultsContainer = this.container.querySelector('#results-container');
        if (resultsContainer) {
            resultsContainer.innerHTML = '';
            resultsContainer.classList.remove('results-hiding', 'results-visible');
        }
        this.resultsHtml = '';
        try {
            const data = await ApiClient.postSearch(this.query, this.selectedTags, 20);
            this.resultsHtml = data.results_html || '';
            this.tagsHtml = data.tags_html || this.tagsHtml;
            this._renderTagsFromHtml(this.tagsHtml);
            this._setLoading(false);
            this._stopTimer();
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = this.resultsHtml;
                this._animateResults();
            }
            this._applyCentering();

            // Persist search query to user history when logged in.
            if (AuthManager.isLoggedIn() && !this._skipHistorySave) {
                try {
                    await ApiClient.saveSearch(this.query, this.selectedTags);
                    if (window.historyPanel) window.historyPanel.load();
                } catch (err) {
                    console.error('Save search error', err);
                }
            }
            this._skipHistorySave = false;
        } catch (e) {
            console.error('Erreur recherche', e);
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">
                    ⏳ Délai dépassé (Timeout). Veuillez relancer la recherche.
                </div>`;
            }
            this._setLoading(false);
            this._stopTimer();
        }
    }

    _renderTagsFromHtml(html) {
        const tagsContainer = this.container.querySelector('#tags-container');
        if (tagsContainer) tagsContainer.innerHTML = html;
    }

    _setLoading(isLoading) {
        this.loading = isLoading;
        const wrapper = this.container.querySelector('#search-wrapper');
        const btn = this.container.querySelector('#submit-btn');
        const indicator = this.container.querySelector('#loading-indicator');
        if (!wrapper || !btn) return;
        if (isLoading) {
            wrapper.classList.add('loading');
            btn.disabled = true;
            btn.style.setProperty('--glow-size', '0px');
            btn.innerHTML = '<span class="btn-label leaving">Chercher</span>';

            // Measure the target width of the dots label
            const ghost = btn.cloneNode(false);
            ghost.style.cssText = 'position:absolute;visibility:hidden;width:auto;pointer-events:none;';
            ghost.innerHTML = '<span class="btn-label"><span class="dot-btn">.</span><span class="dot-btn">.</span><span class="dot-btn">.</span></span>';
            document.body.appendChild(ghost);
            const targetWidth = ghost.offsetWidth + 'px';
            document.body.removeChild(ghost);

            btn.style.width = btn.offsetWidth + 'px';
            setTimeout(() => {
                btn.innerHTML = `<span class="btn-label">
                    <span class="dot-btn">.</span>
                    <span class="dot-btn">.</span>
                    <span class="dot-btn">.</span>
                </span>`;
                requestAnimationFrame(() => { btn.style.width = targetWidth; });
                setTimeout(() => { btn.classList.add('loading'); }, 30);
            }, 80);

            indicator.classList.add('visible');
        } else {
            wrapper.classList.remove('loading');
            btn.classList.remove('loading');
            btn.disabled = false;
            btn.style.width = 'auto';
            btn.innerHTML = '<span class="btn-label">Chercher</span>';
            indicator.classList.remove('visible');
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) {
                resultsContainer.classList.remove('results-hiding');
                resultsContainer.style.display = '';
                resultsContainer.style.visibility = '';
            }
        }
    }

    _startTimer() {
        this._stopTimer();
        const el = this.container.querySelector('#elapsed-timer');
        let s = 0;
        if (el) el.textContent = '0s';
        this.timerInterval = setInterval(() => {
            s++;
            if (el) el.textContent = s + 's';
        }, 1000);
    }

    _stopTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = null;
        const el = this.container.querySelector('#elapsed-timer');
        if (el) el.textContent = '';
    }

    _animateResults() {
        const container = this.container.querySelector('#results-container');
        if (!container) return;
        container.classList.remove('results-visible');
        const items = container.querySelectorAll('.result-item');
        items.forEach((el, i) => {
            el.style.animationDelay = `${i * 80}ms`;
        });
        requestAnimationFrame(() => {
            container.classList.add('results-visible');
        });
    }

    _measureContentHeight(wrapper) {
        // Sum the heights of the direct children (title, form, loading, results header)
        // to get the true content height regardless of current padding.
        let contentHeight = 0;
        for (const child of wrapper.children) {
            const rect = child.getBoundingClientRect();
            const styles = getComputedStyle(child);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            contentHeight += rect.height + marginTop + marginBottom;
        }
        return Math.max(contentHeight, 220);
    }

    _applyCentering(skipTransition, extraOffset = 0) {
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        if (!wrapper) return;

        // Match original dynamic max-width logic
        const vw = this.container.clientWidth;
        wrapper.style.maxWidth = (vw <= 1440 ? Math.min(690, vw * 0.82) : 768) + 'px';

        if (!this.query && !this.resultsHtml) {
            // Vertically center the home content based on the container height.
            // Measure the children directly so the current padding does not influence it.
            const was = wrapper.style.transition;
            if (skipTransition || this._skipNextTransition) wrapper.style.transition = 'none';
            const contentHeight = this._measureContentHeight(wrapper);
            const available = Math.max(this.container.clientHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2 + extraOffset);
            wrapper.style.paddingTop = offset + 'px';
            wrapper.style.paddingBottom = '0px';
            if (skipTransition || this._skipNextTransition) {
                wrapper.offsetHeight; // force reflow
                wrapper.style.transition = was;
            }
        } else {
            wrapper.style.paddingTop = '2rem';
            wrapper.style.paddingBottom = '2rem';
        }
    }

    _observeResize() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (!this.container || typeof ResizeObserver === 'undefined') return;
        this._resizeObserver = new ResizeObserver(() => {
            if (!this.query && !this.resultsHtml) {
                this._applyCentering(true);
            }
        });
        this._resizeObserver.observe(this.container);
    }

    onTabDeactivated() {
        // Suspend the resize observer while the tab is cached; the DOM and
        // scroll state stay intact.
        if (this._resizeObserver) this._resizeObserver.disconnect();
    }

    onTabActivated() {
        this.mounted = true;
        // Cached DOM is re-attached; just resume the resize observer.
        this._observeResize();
        this._updateHomeModeClass();
        this._renderAssistantModelBar();
        const input = this.container?.querySelector('#search-input');
        if (input) input.focus();
    }

    unmount() {
        this._stopTimer();
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        super.unmount();
    }

    getState() {
        return {
            query: this.query,
            selectedTags: this.selectedTags,
            resultsHtml: this.resultsHtml,
            tagsHtml: this.tagsHtml,
            selectedAssistantModels: this.selectedAssistantModels,
        };
    }

    setState(state) {
        // While the intro animation is running, ignore state restores so loaded data
        // (e.g. tags just fetched in render) is not overwritten by an empty saved state.
        if (this._introAnimating) return;
        const newQuery = state.query || '';
        const newSelectedTags = state.selectedTags || [];
        const newResultsHtml = state.resultsHtml || '';
        const newTagsHtml = state.tagsHtml || '';
        const newSelectedModels = state.selectedAssistantModels || [];
        const changed = this.query !== newQuery
            || JSON.stringify(this.selectedTags) !== JSON.stringify(newSelectedTags)
            || this.resultsHtml !== newResultsHtml
            || this.tagsHtml !== newTagsHtml
            || JSON.stringify(this.selectedAssistantModels) !== JSON.stringify(newSelectedModels);
        this.query = newQuery;
        this.selectedTags = newSelectedTags;
        this.resultsHtml = newResultsHtml;
        this.tagsHtml = newTagsHtml;
        this.selectedAssistantModels = newSelectedModels;
        if (!this.container) return;
        // If the live DOM already shows the right content, don't rebuild it.
        const liveMatchesState = !changed || (this.container.querySelector('#search-wrapper-inner')
            && this.container.querySelector('#results-container')?.innerHTML === (this.resultsHtml || ''));
        if (liveMatchesState) {
            this._observeResize();
            this._updateHomeModeClass();
            this._renderAssistantModelBar();
            this._updateAddModelButtons();
            return;
        }
        this.render(this.container);
        this._renderAssistantModelBar();
        this._updateAddModelButtons();
    }

    _toggleAssistantModel(docId, filename, extension) {
        if (!docId || !filename) return;
        const existingIndex = this.selectedAssistantModels.findIndex(m => m.docId === docId);
        if (existingIndex >= 0) {
            this.selectedAssistantModels.splice(existingIndex, 1);
        } else {
            if (this.selectedAssistantModels.length >= this.maxAssistantModels) return;
            this.selectedAssistantModels.push({ docId, filename, extension });
        }
        this._renderAssistantModelBar();
        this._updateAddModelButtons();
        // Persist immediately so the selection survives tab switches.
        AppState.saveInstanceState(this.instanceId);
    }

    _removeAssistantModel(docId) {
        this.selectedAssistantModels = this.selectedAssistantModels.filter(m => m.docId !== docId);
        this._renderAssistantModelBar();
        this._updateAddModelButtons();
        AppState.saveInstanceState(this.instanceId);
    }

    _clearAssistantModels() {
        this.selectedAssistantModels = [];
        this._renderAssistantModelBar();
        this._updateAddModelButtons();
        AppState.saveInstanceState(this.instanceId);
    }

    _saveState() {
        AppState.saveInstanceState(this.instanceId);
    }

    _renderAssistantModelBar() {
        const bar = this.container?.querySelector('#search-assistant-models-bar');
        const pillsSlot = this.container?.querySelector('#search-assistant-models-pills');
        console.log('[SearchApp] _renderAssistantModelBar', { bar: !!bar, pillsSlot: !!pillsSlot, count: this.selectedAssistantModels.length, models: this.selectedAssistantModels });
        if (!bar || !pillsSlot) return;
        if (!this.selectedAssistantModels.length) {
            bar.classList.add('hidden');
            pillsSlot.innerHTML = '';
            return;
        }
        bar.classList.remove('hidden');
        pillsSlot.innerHTML = this.selectedAssistantModels.map(m => {
            const displayName = m.filename.includes('__') ? m.filename.split('__').slice(0, -1).join('__') : m.filename;
            return `
                <div class="search-assistant-model-pill" data-doc-id="${this._escape(m.docId)}">
                    <span title="${this._escape(m.filename)}">${this._escape(displayName)}</span>
                    <button type="button" class="search-assistant-model-remove" title="Retirer">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
            `;
        }).join('');
        pillsSlot.querySelectorAll('.search-assistant-model-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const pill = btn.closest('.search-assistant-model-pill');
                if (pill) this._removeAssistantModel(pill.dataset.docId);
            });
        });
    }

    _updateAddModelButtons() {
        if (!this.container) return;
        const atMax = this.selectedAssistantModels.length >= this.maxAssistantModels;
        this.container.querySelectorAll('[data-action="add-to-assistant"]').forEach(btn => {
            const docId = btn.dataset.docId;
            const selected = this.selectedAssistantModels.some(m => m.docId === docId);
            btn.disabled = atMax && !selected;
            btn.classList.toggle('search-add-model-selected', selected);
            btn.style.opacity = (atMax && !selected) ? '0.4' : '';
        });
    }

    _displayNameForSearchModel(filename) {
        return filename.includes('__') ? filename.split('__').slice(0, -1).join('__') : filename;
    }

    async _openAssistantWithSelectedModels() {
        if (!AuthManager.isLoggedIn()) {
            if (this.authManager) this.authManager.showModal();
            return;
        }
        if (!this.selectedAssistantModels.length) return;
        const btn = this.container?.querySelector('#search-open-assistant-btn');
        if (btn) btn.disabled = true;

        // Open the Assistant immediately with loading placeholders so the user
        // isn't stuck on Search while imports run in the background.
        const existing = AppState.listInstances().find(i => i.appId === 'assistant');
        if (existing) AppState.removeInstance(existing.instanceId);

        const initialDisplayNames = {};
        const loadingKeys = this.selectedAssistantModels.map((item, idx) => {
            const key = `search_import_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`;
            initialDisplayNames[key] = item.filename;
            return { key, item };
        });

        const { instance, instanceId } = AppState.createInstance('assistant', {
            mode: 'tab',
            modelNames: [],
            modelName: '',
            origin: 'assistant',
            fromHistory: false,
            displayNames: initialDisplayNames,
        });

        await window.windowManager._mountTab(instance);
        AppState.setActiveInstance(instanceId);

        // Register loading placeholders on the Assistant instance.
        loadingKeys.forEach(({ key, item }) => {
            instance._startImportLoading(key, item.filename);
        });
        this._clearAssistantModels();

        // Import in parallel in the background and update the Assistant pills.
        const imported = [];
        await Promise.all(loadingKeys.map(async ({ key, item }) => {
            try {
                const result = await ApiClient.importDocumentAsAssistantModel(item.docId, 'assistant');
                if (result?.name) {
                    instance.props.displayNames = instance.props.displayNames || {};
                    instance.props.displayNames[result.name] = result.display_name || item.filename;
                    instance._finishImportLoading(key, result.name);
                    imported.push({ name: result.name, display_name: result.display_name || item.filename });
                } else {
                    throw new Error('Import terminé sans retour de modèle.');
                }
            } catch (err) {
                console.error('Import model from search error', err);
                instance._failImportLoading(key, `Erreur import de ${this._displayNameForSearchModel(item.filename)} : ${err.message}`);
            }
        }));

        if (btn) btn.disabled = false;
    }

    _appendSearchError(message) {
        const container = this.container?.querySelector('#results-container');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'search-import-error';
        div.textContent = message;
        container.appendChild(div);
    }

    _renderLoginBanner() {
        const slot = this.container?.querySelector('#search-login-banner');
        if (!slot) return;
        if (AuthManager.isLoggedIn()) {
            slot.classList.add('hidden');
            slot.innerHTML = '';
            return;
        }
        slot.classList.remove('hidden');
        slot.innerHTML = `
            <div class="login-banner">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                </svg>
                <span>Connectez-vous pour enregistrer vos recherches et les envoyer à l'assistant.</span>
                <button type="button" class="search-login-open">Connexion</button>
            </div>
        `;
        const btn = slot.querySelector('.search-login-open');
        if (btn && this.authManager) {
            btn.addEventListener('click', () => this.authManager.showModal());
        }
    }

    _saveState() {
        AppState.saveInstanceState(this.instanceId);
    }
}

window.SearchApp = SearchApp;
