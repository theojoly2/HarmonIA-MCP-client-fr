/**
 * SearchApp
 * Module Recherche Sémantique.
 */

class SearchApp extends AppBase {
    static id = "search";
    static title = "Recherche";
    static iconSvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>`;
    static canFloat = true;
    static canSplit = true;
    static singleton = true;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.query = "";
        this.selectedTags = [];
        this.results = [];
        this.tagsHtml = "";
        this.loading = false;
        this.timerInterval = null;
        this._resizeObserver = null;
        this._skipNextTransition = false;
    }

    render(container) {
        this.container = container;
        container.innerHTML = `
            <div class="search-app h-full overflow-y-auto px-4 sm:px-6">
                <div id="search-wrapper-inner" class="mx-auto" style="transition: none;">
                    <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8">
                        <a href="?" class="interactive-title" title="Réinitialiser la recherche">
                            <span class="title-glow">Recherche Sémantique</span>
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
                        <div id="tags-container" class="mt-5 flex flex-wrap gap-2 justify-center">
                            ${this.tagsHtml || '<span class="text-gray-500 font-medium text-sm">Chargement des sources...</span>'}
                        </div>
                    </form>
                    <div id="loading-indicator" class="text-center mt-2 mb-6">
                        <span class="text-xs font-bold tracking-widest uppercase text-gray-400">Recherche en cours</span>
                        <span id="elapsed-timer"></span>
                    </div>
                    <div id="results-container" class="mt-4 pb-12">${this.resultsHtml || ''}</div>
                </div>
            </div>
        `;
        this._bindEvents();
        this._updateHomeModeClass();
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        if (wrapper) wrapper.style.transition = 'none';
        this._skipNextTransition = true;
        this._observeResize();
        if (this.resultsHtml) this._animateResults();
        this._loadTags();
        // Measure and position after layout is stable, then re-enable transition.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._applyCentering(true);
                if (wrapper) {
                    wrapper.offsetHeight; // force reflow
                    wrapper.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1), max-width 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
                }
                this._skipNextTransition = false;
            });
        });
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

                // Clear previous results immediately as soon as loading starts
                if (resultsContainer) {
                    resultsContainer.innerHTML = '';
                    resultsContainer.classList.remove('results-hiding');
                    resultsContainer.style.display = '';
                    resultsContainer.style.visibility = '';
                }

                this._setLoading(true);
                this._startTimer();
                // Start move up while halo appears, so both run together (60ms frame)
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => this._applyCentering());
                });
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
            if (action === 'preview') {
                EventBus.emit('open-preview', { docId, documentId, name });
            } else if (action === 'chat') {
                EventBus.emit('open-chat', { documentId, name });
            }
        });
    }

    async _loadTags() {
        try {
            const data = await ApiClient.getTags();
            const tags = data.tags || [];
            this._renderTags(tags);
        } catch (e) {
            console.error('Erreur chargement tags', e);
        }
    }

    _renderTags(tags) {
        const tagsContainer = this.container.querySelector('#tags-container');
        if (!tagsContainer) return;
        if (!tags.length) {
            tagsContainer.innerHTML = '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>';
            return;
        }
        this.tagsHtml = tags.map(t => {
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
        tagsContainer.innerHTML = this.tagsHtml;
        if (window.GlowEffects) window.GlowEffects.scanAndBind();
    }

    async _runSearch() {
        if (!this.query) return;
        try {
            const data = await ApiClient.postSearch(this.query, this.selectedTags, 20);
            this.resultsHtml = data.results_html || '';
            this.tagsHtml = data.tags_html || this.tagsHtml;
            this._renderTagsFromHtml(this.tagsHtml);
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = this.resultsHtml;
                this._animateResults();
            }
            this._applyCentering();
        } catch (e) {
            console.error('Erreur recherche', e);
            const resultsContainer = this.container.querySelector('#results-container');
            if (resultsContainer) {
                resultsContainer.innerHTML = `<div class="text-center py-20 text-red-500 font-bold">
                    ⏳ Délai dépassé (Timeout). Veuillez relancer la recherche.
                </div>`;
            }
        } finally {
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
        const items = this.container.querySelectorAll('.result-item');
        items.forEach((el, i) => {
            el.classList.remove('visible');
            setTimeout(() => el.classList.add('visible'), i * 80);
        });
    }

    _applyCentering(skipTransition) {
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        if (!wrapper) return;

        // Match original dynamic max-width logic
        const vw = this.container.clientWidth;
        wrapper.style.maxWidth = (vw <= 1440 ? Math.min(690, vw * 0.82) : 768) + 'px';

        if (!this.query && !this.resultsHtml) {
            // Vertically center the home content based on the container height.
            // Reset padding before measuring to avoid including previous padding in offsetHeight.
            const was = wrapper.style.transition;
            if (skipTransition || this._skipNextTransition) wrapper.style.transition = 'none';
            wrapper.style.paddingTop = '0px';
            wrapper.style.paddingBottom = '0px';
            const contentHeight = wrapper.offsetHeight || 220;
            const available = Math.max(this.container.clientHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2);
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
        };
    }

    setState(state) {
        this.query = state.query || '';
        this.selectedTags = state.selectedTags || [];
        this.resultsHtml = state.resultsHtml || '';
        this.tagsHtml = state.tagsHtml || '';
        if (this.container) this.render(this.container);
    }
}

window.SearchApp = SearchApp;
