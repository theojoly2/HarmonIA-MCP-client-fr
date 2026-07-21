/**
 * SearchApp
 * Module Recherche Sémantique.
 */

class SearchApp extends AppBase {
    static id = "search";
    static title = "Recherche";
    static icon = "🔍";
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
    }

    render(container) {
        this.container = container;
        container.innerHTML = `
            <div class="search-app h-full overflow-y-auto px-4 sm:px-6">
                <div id="search-wrapper-inner" class="max-w-3xl mx-auto transition-all">
                    <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8 mt-6">
                        <span class="title-glow interactive-title">Recherche Sémantique</span>
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
        this._applyCentering();
        if (this.resultsHtml) this._animateResults();
        this._loadTags();
    }

    _escape(text) {
        return text.replace(/"/g, '&quot;');
    }

    _bindEvents() {
        const form = this.container.querySelector('#search-form');
        const input = this.container.querySelector('#search-input');
        const tagsContainer = this.container.querySelector('#tags-container');

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.query = input.value.trim();
            this.selectedTags = Array.from(tagsContainer.querySelectorAll('input[name="t"]:checked')).map(cb => cb.value);
            this._runSearch();
        });

        tagsContainer.addEventListener('change', (e) => {
            if (e.target.name === 't') {
                this.selectedTags = Array.from(tagsContainer.querySelectorAll('input[name="t"]:checked')).map(cb => cb.value);
            }
        });

        const resultsContainer = this.container.querySelector('#results-container');
        resultsContainer.addEventListener('click', (e) => {
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
                <label class="cursor-pointer select-none tag-label">
                    <input type="checkbox" name="t" value="${tagName}" class="peer hidden" ${isChecked}>
                    <span class="inline-flex items-center rounded-full font-bold border-2 border-gray-200 text-gray-700 peer-checked:bg-black peer-checked:text-white peer-checked:border-black hover:border-gray-400 transition-colors">
                        <svg class="icon-unchecked w-3.5 h-3.5 mr-1.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                        <svg class="icon-checked w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                        ${tagName}
                    </span>
                </label>
            `;
        }).join('');
        tagsContainer.innerHTML = this.tagsHtml;
    }

    async _runSearch() {
        if (!this.query) return;
        this._setLoading(true);
        this._startTimer();
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
            btn.innerHTML = `<span class="btn-label"><span class="dot-btn">.</span><span class="dot-btn">.</span><span class="dot-btn">.</span></span>`;
            indicator.classList.add('visible');
        } else {
            wrapper.classList.remove('loading');
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-label">Chercher</span>';
            indicator.classList.remove('visible');
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

    _applyCentering() {
        const wrapper = this.container.querySelector('#search-wrapper-inner');
        if (!wrapper) return;
        if (!this.query && !this.resultsHtml) {
            const pad = Math.max(48, (window.innerHeight - wrapper.offsetHeight) / 2 - 60);
            wrapper.style.paddingTop = pad + 'px';
            wrapper.style.paddingBottom = pad + 'px';
        } else {
            wrapper.style.paddingTop = '2rem';
            wrapper.style.paddingBottom = '2rem';
        }
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

    unmount() {
        this._stopTimer();
        super.unmount();
    }
}

window.SearchApp = SearchApp;
