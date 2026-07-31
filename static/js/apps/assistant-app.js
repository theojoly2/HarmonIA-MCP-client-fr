/**
 * AssistantApp
 * Chatbot de modélisation sémantique avec tool calling.
 * UI inspirée de ChatApp (fenêtre flottante) : fond blanc, coins arrondis,
 * input "pill", bouton d'envoi noir rond, avatar sparkle, markdown-body.
 */

class AssistantApp extends AppBase {
    static id = 'assistant';
    static title = 'Assistant Sémantique';
    static iconSvg = `<svg class="w-4 h-4 overflow-visible" viewBox="0 0 24 24">
        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
    </svg>`;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.session = props.session || '';
        this.modelName = props.modelName || '';
        this.messages = [];
        this.isStreaming = false;
    }

    render(container) {
        this.container = container;
        container.innerHTML = `
            <div class="assistant-app h-full w-full flex flex-col bg-white rounded-[1.25rem] overflow-hidden">
                <div class="assistant-toolbar px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-shrink-0">
                    <div class="flex items-center gap-2 text-sm font-semibold text-gray-900">
                        <span class="w-2 h-2 rounded-full bg-blue-600"></span>
                        Assistant Sémantique
                    </div>
                    <div class="flex items-center gap-2">
                        <input type="text" id="assistant-model" value="${this._escape(this.modelName)}"
                            placeholder="Nom du modèle (optionnel)"
                            class="assistant-model-input text-sm px-3 py-1.5 rounded-full border border-gray-200 focus:outline-none focus:border-black transition-colors w-48"
                            autocomplete="off">
                        <button type="button" id="assistant-new-session" class="assistant-btn-secondary text-sm px-3 py-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors">Nouvelle session</button>
                    </div>
                </div>
                <div id="assistant-chat" class="flex-1 overflow-y-auto p-4">
                    ${this._welcomeMessage()}
                </div>
                <div class="p-3 border-t border-gray-100 flex-shrink-0">
                    <form id="assistant-form" class="relative flex items-center">
                        <input type="text" id="assistant-input" autocomplete="off"
                            placeholder="Interrogez l'assistant sémantique..."
                            class="w-full rounded-[2rem] border-2 border-gray-300 focus:outline-none focus:border-black font-medium transition-colors placeholder-gray-500 pl-4 pr-12 py-3 text-sm"
                            value="">
                        <button type="submit" class="magic-btn assistant-send-btn absolute right-2 text-white bg-black hover:bg-gray-800 rounded-full w-9 h-9 flex items-center justify-center transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                            </svg>
                        </button>
                    </form>
                </div>
            </div>
        `;

        this.chatEl = container.querySelector('#assistant-chat');
        this.inputEl = container.querySelector('#assistant-input');
        this.modelInput = container.querySelector('#assistant-model');

        container.querySelector('#assistant-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputEl.value.trim();
            if (!text || this.isStreaming) return;
            this.inputEl.value = '';
            this._send(text);
        });

        this.modelInput.addEventListener('change', () => {
            this.modelName = this.modelInput.value.trim();
        });

        container.querySelector('#assistant-new-session').addEventListener('click', () => this._newSession());

        // Delegate clicks for embedded search result actions (preview / chat).
        this.chatEl.addEventListener('click', (e) => {
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

    _escape(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _welcomeMessage() {
        return `
            <div class="flex flex-col items-start gap-3 mb-8">
                <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">
                    <p>Je suis l'assistant de modélisation sémantique. Posez-moi une question ou décrivez le modèle que vous souhaitez construire.</p>
                </div>
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container">
                    <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                    </svg>
                </div>
            </div>
        `;
    }

    _slugify(text) {
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]+/g, ' ')
            .trim()
            .split(/\s+/)
            .slice(0, 8)
            .join('_')
            .substring(0, 80) || 'session';
    }

    _newSession() {
        this.session = '';
        this.messages = [];
        this.chatEl.innerHTML = this._welcomeMessage();
    }

    _appendUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'flex items-end justify-end mb-6 user-msg-anchor';
        div.innerHTML = `<div class="bg-gray-50 border border-gray-100 text-gray-900 px-5 py-3.5 rounded-[1.5rem] text-sm max-w-[80%] leading-relaxed">${this._escape(text)}</div>`;
        this.chatEl.appendChild(div);
        return div;
    }

    _appendThinkingPlaceholder(label = 'Réflexion...') {
        // Remove any existing thinking placeholder first to avoid duplicates.
        this._removePlaceholder();
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col items-start gap-3 mb-6 assistant-thinking-placeholder';
        wrapper.dataset.thinking = 'true';
        wrapper.innerHTML = `
            <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body assistant-bubble-content" style="min-height:0;"></div>
            <div class="ai-avatar-row flex items-center gap-2">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                    ${this._sparkleSvg()}
                </div>
                <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400">${this._escape(label)}</span>
            </div>
        `;
        this.chatEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper;
    }

    _updateThinkingLabel(label) {
        const target = this.chatEl.querySelector('.assistant-thinking-placeholder');
        if (!target) return;
        const labelEl = target.querySelector('.thinking-label');
        if (labelEl) labelEl.textContent = label;
    }

    _removePlaceholder() {
        const existing = this.chatEl.querySelector('.assistant-thinking-placeholder');
        if (existing && existing.parentNode) {
            // Hide its sparkle before removing to avoid orphan animation.
            const sparkle = existing.querySelector('.sparkle-container');
            if (sparkle) {
                const avatar = sparkle.closest('.ai-avatar-wrapper') || sparkle;
                avatar.dataset.hidden = 'true';
                avatar.classList.remove('trigger-magic');
                avatar.style.transition = 'opacity 0.2s ease';
                avatar.style.opacity = '0';
                setTimeout(() => {
                    if (avatar.parentNode && !avatar.closest('.assistant-thinking-placeholder')) return;
                    avatar.style.display = 'none';
                }, 200);
            }
            // Detach the wrapper after a short delay so the fade out can play.
            const wrapper = existing;
            setTimeout(() => {
                if (wrapper.parentNode) wrapper.remove();
            }, 210);
            this._forceReflow();
        }
    }

    _ensureAssistantBubble() {
        // Create a new assistant message bubble if the last one is not an active assistant bubble.
        const last = this.chatEl.lastElementChild;
        if (last && last.dataset.role === 'assistant' && last.dataset.active === 'true') {
            return last.querySelector('.assistant-bubble-content');
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col items-start gap-3 mb-6';
        wrapper.dataset.role = 'assistant';
        wrapper.dataset.active = 'true';
        wrapper.innerHTML = `
            <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body assistant-bubble-content"></div>
            <div class="ai-avatar-row flex items-center gap-2">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                    ${this._sparkleSvg()}
                </div>
            </div>
        `;
        this.chatEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper.querySelector('.assistant-bubble-content');
    }

    _forceReflow() {
        if (this.chatEl) {
            void this.chatEl.offsetHeight;
        }
    }

    _hideAllSparkles({ keepLast = false } = {}) {
        const containers = Array.from(this.chatEl.querySelectorAll('.sparkle-container'));
        const last = keepLast && containers.length ? containers[containers.length - 1] : null;
        containers.forEach((container) => {
            if (container === last) return;
            const avatar = container.closest('.ai-avatar-wrapper') || container;
            // Only animate if it is still visible/animated.
            if (avatar.style.display === 'none' || avatar.dataset.hidden === 'true') return;
            avatar.dataset.hidden = 'true';
            avatar.classList.remove('trigger-magic');
            avatar.style.transition = 'opacity 0.25s ease, height 0.25s ease, margin 0.25s ease';
            avatar.style.opacity = '0';
            avatar.style.height = '0';
            avatar.style.margin = '0';
            avatar.style.overflow = 'hidden';
            setTimeout(() => { avatar.style.display = 'none'; }, 250);
        });
    }

    _keepSparkleAlive() {
        // Keep only the last sparkle avatar alive (e.g. current thinking or current bubble).
        const avatars = Array.from(this.chatEl.querySelectorAll('.ai-avatar-wrapper'));
        if (!avatars.length) return;
        const last = avatars[avatars.length - 1];
        // Make sure the last one is visible and actively animating.
        if (last.style.display === 'none') {
            last.style.display = '';
        }
        if (last.dataset.hidden === 'true') {
            last.dataset.hidden = 'false';
        }
        last.classList.add('trigger-magic');
        // Reset inline hiding styles if they were previously applied.
        last.style.opacity = '';
        last.style.height = '';
        last.style.margin = '';
        last.style.overflow = '';
        last.style.transition = '';

        // Hide all others.
        avatars.forEach((avatar) => {
            if (avatar === last) return;
            if (avatar.style.display === 'none' || avatar.dataset.hidden === 'true') return;
            avatar.dataset.hidden = 'true';
            avatar.classList.remove('trigger-magic');
            avatar.style.transition = 'opacity 0.25s ease, height 0.25s ease, margin 0.25s ease';
            avatar.style.opacity = '0';
            avatar.style.height = '0';
            avatar.style.margin = '0';
            avatar.style.overflow = 'hidden';
            setTimeout(() => { avatar.style.display = 'none'; }, 250);
        });
    }

    _closeAssistantBubble() {
        const last = this.chatEl.lastElementChild;
        if (last && last.dataset.role === 'assistant' && last.dataset.active === 'true') {
            last.dataset.active = 'false';
        }
    }

    _appendToolCalls(toolCalls) {
        const names = (toolCalls || [])
            .map((c) => c?.function?.name || c?.name || 'outil')
            .filter(Boolean);
        if (!names.length) return null;
        const div = document.createElement('div');
        div.className = 'assistant-tool-calls mb-4';
        div.innerHTML = `
            <div class="assistant-tool-calls-title">Appels d’outils planifiés</div>
            <div class="assistant-tool-calls-list">
                ${names.map((n) => `<span class="assistant-tool-call-name">${this._escape(n)}</span>`).join('')}
            </div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _createToolCard(name, args = {}) {
        const id = 'assistant-tool-' + name + '-' + Date.now();
        const div = document.createElement('div');
        div.id = id;
        div.className = 'assistant-tool-card mb-4';
        div.dataset.toolName = name;
        const argSummary = this._argsSummary(args);
        div.innerHTML = `
            <div class="assistant-tool-card-header">
                <div class="assistant-tool-name">
                    <span class="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse tool-status-dot"></span>
                    <span class="font-mono">${this._escape(name)}</span>
                </div>
                ${argSummary ? `<div class="assistant-tool-args">${argSummary}</div>` : ''}
            </div>
            <div class="assistant-tool-card-body" style="display:none;">
                <div class="assistant-tool-section">
                    <div class="assistant-tool-section-title">Arguments</div>
                    <pre>${this._escape(JSON.stringify(args, null, 2))}</pre>
                </div>
                <div class="assistant-tool-section assistant-tool-result-section" style="display:none;">
                    <div class="assistant-tool-section-title">Résultat</div>
                    <pre class="assistant-tool-result-content"></pre>
                </div>
            </div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _argsSummary(args) {
        if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
        const parts = Object.entries(args).slice(0, 3).map(([k, v]) => {
            let val = v;
            if (typeof val === 'string' && val.length > 40) val = val.slice(0, 40) + '…';
            if (Array.isArray(val)) val = `[${val.length}]`;
            if (typeof val === 'object') val = JSON.stringify(val).slice(0, 40);
            return `${this._escape(k)}=${this._escape(String(val))}`;
        });
        let text = parts.join(', ');
        if (Object.keys(args).length > 3) text += ', …';
        return text;
    }

    _markToolRunning(card, isRunning) {
        if (!card) return;
        const dot = card.querySelector('.tool-status-dot');
        if (dot) dot.classList.toggle('animate-pulse', isRunning);
        card.classList.toggle('tool-running', isRunning);
        card.classList.toggle('tool-done', !isRunning);
    }

    _fillToolResult(name, result, display) {
        if (display && display.type === 'search') {
            this._fillSearchCard(display.query || '', display.results_html || '');
            return null;
        }
        const cards = this.chatEl.querySelectorAll('[data-tool-name]');
        let card = null;
        for (let i = cards.length - 1; i >= 0; i--) {
            if (cards[i].dataset.toolName === name && !cards[i].dataset.filled) {
                card = cards[i];
                break;
            }
        }
        if (!card) {
            card = this._createToolCard(name, {});
        }
        card.dataset.filled = 'true';
        this._markToolRunning(card, false);
        const body = card.querySelector('.assistant-tool-card-body');
        const resultSection = card.querySelector('.assistant-tool-result-section');
        const resultContent = card.querySelector('.assistant-tool-result-content');
        const summary = this._toolSummary(result);
        const summaryText = summary ? ` ${summary}` : '';
        const headerName = card.querySelector('.assistant-tool-name');
        if (headerName) {
            headerName.innerHTML = `
                <span class="w-1.5 h-1.5 rounded-full bg-green-600 tool-status-dot"></span>
                <span class="font-mono">${this._escape(name)}</span><span class="text-gray-500 font-normal ml-1">${summaryText}</span>
            `;
        }
        if (body) body.style.display = 'block';
        if (resultSection) resultSection.style.display = 'block';
        if (resultContent) resultContent.textContent = JSON.stringify(result, null, 2);
        this._scrollToBottom();
        return card;
    }

    _renderPlan(result) {
        if (!result || typeof result !== 'object') return null;
        const parsed = (result.tool_results && typeof result.tool_results === 'object')
            ? result.tool_results
            : result;

        const planSteps = parsed.plan_steps || [];
        const toolsToCall = parsed.tools_to_call || [];
        const notes = parsed.notes || '';

        if (!Array.isArray(planSteps) || planSteps.length === 0) {
            return null;
        }

        const div = document.createElement('div');
        div.className = 'assistant-plan-card mb-4';
        div.innerHTML = `
            <div class="assistant-plan-header">
                <svg class="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
                </svg>
                <span>Plan d’action proposé</span>
            </div>
            <div class="assistant-plan-body">
                <ol class="assistant-plan-steps"></ol>
                ${notes ? `<div class="assistant-plan-notes" style="display:none;">${this._escape(notes)}</div>` : ''}
            </div>
        `;
        const stepsList = div.querySelector('.assistant-plan-steps');
        const notesEl = div.querySelector('.assistant-plan-notes');

        planSteps.forEach((step, index) => {
            const tool = toolsToCall.find((t) => t.step_index === index);
            const toolName = tool?.tool || '';
            const toolBadge = toolName
                ? `<span class="assistant-plan-tool-badge">${this._escape(toolName)}</span>`
                : '';
            const stepText = typeof step === 'string' ? step : (step.step || '');
            const needsTool = typeof step === 'object' ? step.needs_tool : false;
            const li = document.createElement('li');
            li.className = 'assistant-plan-step';
            li.style.opacity = '0';
            li.style.transform = 'translateY(6px)';
            li.style.transition = 'opacity 180ms ease, transform 180ms ease';
            li.innerHTML = `
                <span class="assistant-plan-step-number">${index + 1}</span>
                <div class="assistant-plan-step-content">
                    <div class="assistant-plan-step-text">${this._escape(stepText)}</div>
                    ${toolBadge}
                    ${needsTool ? '<span class="assistant-plan-uses-tool">nécessite un outil</span>' : ''}
                </div>
            `;
            stepsList.appendChild(li);
        });

        this.chatEl.appendChild(div);
        this._scrollToBottom();

        // Reveal plan steps one by one for a progressive execution feel.
        requestAnimationFrame(() => {
            const items = stepsList.querySelectorAll('.assistant-plan-step');
            items.forEach((item, i) => {
                setTimeout(() => {
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                    this._scrollToBottom();
                }, i * 120);
            });
            if (notesEl) {
                setTimeout(() => {
                    notesEl.style.display = '';
                    this._scrollToBottom();
                }, items.length * 120);
            }
        });

        return div;
    }

    _appendSearchCard(query, resultsHtml) {
        const id = 'assistant-search-' + Date.now();
        const div = document.createElement('div');
        div.id = id;
        div.className = 'assistant-search-card mb-6';
        div.dataset.searchCard = 'true';
        div.dataset.query = query;
        const loadingVisible = resultsHtml ? 'style="display:none;"' : '';
        const resultsVisible = resultsHtml ? '' : 'style="display:none;"';
        div.innerHTML = `
            <div class="assistant-search-header">
                <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                </svg>
                <span class="assistant-search-query">${this._escape(query)}</span>
            </div>
            <div class="assistant-search-loading" ${loadingVisible}>
                <div class="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-gray-400">
                    <span class="assistant-search-spinner"></span>
                    <span>Recherche en cours</span>
                </div>
            </div>
            <div class="assistant-search-results markdown-body" ${resultsVisible}>
                ${resultsHtml || ''}
            </div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _fillSearchCard(query, resultsHtml) {
        const cards = this.chatEl.querySelectorAll('[data-search-card="true"]');
        let target = null;
        for (let i = cards.length - 1; i >= 0; i--) {
            const card = cards[i];
            const loading = card.querySelector('.assistant-search-loading');
            const isLoading = loading && loading.style.display !== 'none';
            if (isLoading && (!query || card.dataset.query === query)) {
                target = card;
                break;
            }
        }
        if (!target) {
            target = this._appendSearchCard(query, resultsHtml);
            return target;
        }
        const loading = target.querySelector('.assistant-search-loading');
        const results = target.querySelector('.assistant-search-results');
        if (loading) loading.style.display = 'none';
        if (results) {
            results.innerHTML = resultsHtml || '<p class="text-gray-500 text-sm p-4">Aucun résultat.</p>';
            results.style.display = 'block';
            this._animateSearchResults(results);
        }
        target.dataset.query = query;
        target.querySelector('.assistant-search-query').textContent = query;
        this._scrollToBottom();
        return target;
    }

    _animateSearchResults(container) {
        container.classList.remove('results-visible');
        const items = container.querySelectorAll('.result-item');
        items.forEach((el) => { el.style.animationDelay = ''; });
        requestAnimationFrame(() => {
            items.forEach((el, i) => { el.style.animationDelay = `${i * 80}ms`; });
            container.classList.add('results-visible');
        });
    }

    _bindSearchCardEvents(card) {
        // Clicks are handled globally on this.chatEl; kept for compatibility.
    }

    _sparkleSvg() {
        return `
            <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
            </svg>
        `;
    }

    _markdown(text) {
        if (!text) return '';
        if (typeof marked !== 'undefined') {
            return marked.parse(text, { breaks: true, gfm: true });
        }
        return this._escape(text).replace(/\n/g, '<br>');
    }

    _toolStatusLabel(name) {
        const labels = {
            plan_workflow_with_tools: 'Planification en cours...',
            retrieve_documents: 'Recherche de documents...',
            add_class: 'Création de la classe...',
            add_attribute: "Ajout d'un attribut...",
            add_connector: 'Création de la relation...',
            style_guide_check: 'Vérification du style...',
        };
        return labels[name] || `${name}...`;
    }

    _toolSummary(result) {
        if (!result || typeof result !== 'object') return '';
        const toolResults = result.tool_results;
        if (!toolResults || typeof toolResults !== 'object') return '';
        if (Array.isArray(toolResults) && toolResults.length > 0) {
            return ` (${toolResults.length} résultats)`;
        }
        if (Object.keys(toolResults).length > 0) {
            return ` (${Object.keys(toolResults).length} entrées)`;
        }
        return '';
    }

    _scrollToBottom() {
        // Scrolling is intentionally left to the user so they can read
        // multi-step assistant/tool output without being pulled down.
    }

    async _send(text) {
        if (!this.session) {
            this.session = this._slugify(text);
        }
        this.modelName = this.modelInput.value.trim();

        this.messages.push({ role: 'user', content: text });
        this._appendUserMessage(text);
        this.isStreaming = true;

        // Start with a clean thinking placeholder. Hide stale sparkles first,
        // because a new user message begins a new assistant turn.
        this._hideAllSparkles();
        const placeholder = this._appendThinkingPlaceholder();

        let currentBubble = null;
        let currentText = '';
        let assistantHasStarted = false;

        // Typewriter: append raw text to the DOM progressively, parse markdown only
        // when finalizing, so the browser can paint smoothly.
        const typewriter = this._createTypewriter((chunk) => {
            currentText += chunk;
            if (!currentBubble) {
                // Remove the thinking placeholder as soon as real text starts.
                this._removePlaceholder();
                this._closeAssistantBubble();
                currentBubble = this._ensureAssistantBubble();
                this._keepSparkleAlive();
                assistantHasStarted = true;
            }
            currentBubble.textContent = currentText;
            this._forceReflow();
            this.chatEl.scrollTop = this.chatEl.scrollHeight;
        });

        const finalizeText = () => {
            typewriter.flush();
            if (currentBubble) {
                currentBubble.innerHTML = this._markdown(currentText);
                this._forceReflow();
            }
        };

        const finishActiveBubble = (keepSparkle = false) => {
            finalizeText();
            if (currentBubble) {
                this._closeAssistantBubble();
                this._hideAllSparkles({ keepLast: keepSparkle });
            }
            currentBubble = null;
            currentText = '';
            assistantHasStarted = false;
        };

        try {
            await ApiClient.streamAssistant(
                this.session,
                text,
                this.modelName,
                async (event) => {
                    if (event.kind === 'user') {
                        if (event.session) this.session = event.session;
                        return;
                    }

                    if (event.kind === 'thinking') {
                        // Ensure a visible thinking placeholder exists with the right label.
                        if (!this.chatEl.querySelector('.assistant-thinking-placeholder')) {
                            this._appendThinkingPlaceholder('Réflexion...');
                        } else {
                            this._updateThinkingLabel('Réflexion...');
                        }
                        this._keepSparkleAlive();
                        return;
                    }

                    if (event.kind === 'assistant_text') {
                        if (!assistantHasStarted) {
                            this._removePlaceholder();
                            this._closeAssistantBubble();
                            currentBubble = this._ensureAssistantBubble();
                            this._keepSparkleAlive();
                            assistantHasStarted = true;
                        }
                        typewriter.append(event.content || '');
                        return;
                    }

                    if (event.kind === 'assistant_tool_calls') {
                        this._removePlaceholder();
                        finishActiveBubble();
                        this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
                        return;
                    }

                    if (event.kind === 'tool_start') {
                        this._removePlaceholder();
                        finishActiveBubble();
                        // Show a transient status label while the tool runs.
                        this._appendThinkingPlaceholder(this._toolStatusLabel(event.name));
                        this._keepSparkleAlive();
                        if (event.name === 'retrieve_documents') {
                            this._appendSearchCard(event.arguments?.search_terms || '', null);
                        } else if (event.name !== 'plan_workflow_with_tools') {
                            const card = this._createToolCard(event.name, event.arguments || {});
                            this._markToolRunning(card, true);
                        }
                        this.messages.push({ role: 'tool_start', name: event.name, arguments: event.arguments });
                        return;
                    }

                    if (event.kind === 'tool_result') {
                        this._removePlaceholder();
                        finishActiveBubble();
                        if (event.name === 'plan_workflow_with_tools') {
                            this._renderPlan(event.result);
                        } else if (event.name === 'retrieve_documents') {
                            this._fillSearchCard(event.display?.query || '', event.display?.results_html || '');
                        } else {
                            this._fillToolResult(event.name, event.result, event.display);
                        }
                        this.messages.push({ role: 'tool_result', name: event.name, result: event.result, display: event.display });
                        return;
                    }

                    if (event.kind === 'loop_done') {
                        this._removePlaceholder();
                        finishActiveBubble();
                        return;
                    }

                    if (event.kind === 'assistant_done') {
                        this._removePlaceholder();
                        // If the backend only sent the final message inside assistant_done
                        // (no preceding assistant_text chunks), render it now.
                        if (event.content && !currentText && !currentBubble) {
                            this._closeAssistantBubble();
                            currentBubble = this._ensureAssistantBubble();
                            this._keepSparkleAlive();
                            currentText = event.content;
                            currentBubble.innerHTML = this._markdown(currentText);
                            this._forceReflow();
                        } else {
                            finalizeText();
                        }
                        this._closeAssistantBubble();
                        this._hideAllSparkles();
                        return;
                    }

                    if (event.kind === 'error') {
                        this._removePlaceholder();
                        finishActiveBubble();
                        const bubble = this._ensureAssistantBubble();
                        this._keepSparkleAlive();
                        bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(event.message || '')}</em>`;
                    }
                }
            );

        } catch (err) {
            console.error('Assistant stream error', err);
            this._removePlaceholder();
            typewriter.flush();
            const bubble = this._ensureAssistantBubble();
            this._keepSparkleAlive();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(err.message)}</em>`;
        } finally {
            typewriter.stop();
            this.isStreaming = false;
            this._removePlaceholder();
            this._closeAssistantBubble();
            // Stop the sparkle animation once generation is complete.
            this._hideAllSparkles();

            if (currentText) {
                this.messages.push({ role: 'assistant', content: currentText });
            }

            requestAnimationFrame(() => {
                this.chatEl.style.paddingBottom = '0px';
            });
        }
    }

    _createTypewriter(onChunk) {
        let buffer = '';
        let rafId = null;
        let running = false;
        const CHUNK_SIZE = 3;

        const schedule = () => {
            if (running || rafId) return;
            running = true;
            rafId = requestAnimationFrame(() => {
                // One paint per frame: render a small chunk then schedule the next.
                const chunk = buffer.slice(0, CHUNK_SIZE);
                if (chunk) {
                    buffer = buffer.slice(CHUNK_SIZE);
                    onChunk(chunk);
                }
                rafId = null;
                running = false;
                if (buffer !== '') schedule();
            });
        };

        return {
            append: (text) => {
                buffer += text;
                schedule();
            },
            flush: () => {
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                running = false;
                while (buffer !== '') {
                    const chunk = buffer.slice(0, CHUNK_SIZE);
                    buffer = buffer.slice(CHUNK_SIZE);
                    onChunk(chunk);
                }
            },
            stop: () => {
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                running = false;
                buffer = '';
            },
        };
    }
}

window.AssistantApp = AssistantApp;
