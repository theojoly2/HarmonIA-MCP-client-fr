/**
 * AssistantApp
 * Chatbot de modélisation sémantique avec tool calling.
 * UI inspirée de ChatApp (fenêtre flottante) : fond blanc, coins arrondis,
 * input "pill", bouton d'envoi noir rond, avatar sparkle, markdown-body.
 */

class AssistantApp extends AppBase {
    static id = 'assistant';
    static title = 'Assistant';
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
            <div class="assistant-app h-full w-full flex flex-col bg-white rounded-[1.25rem] overflow-hidden relative">
                <div id="assistant-chat" class="flex-1 overflow-y-auto">
                    <div class="assistant-wrapper" id="assistant-wrapper">
                        <div class="assistant-hero" id="assistant-hero">
                            <h1 class="assistant-hero-title text-center">
                                <span class="assistant-title-glow title-glow">Assistant Sémantique</span>
                            </h1>
                            <div class="assistant-hero-input assistant-input-wrapper rounded-2xl border-2 border-gray-300 focus-within:border-black bg-white transition-colors shadow-sm">
                                <form id="assistant-form" class="flex flex-col gap-2 p-3">
                                    <textarea id="assistant-input" rows="1" autocomplete="off"
                                        placeholder="Interrogez l'assistant sémantique..."
                                        class="w-full resize-none max-h-40 bg-transparent border-none focus:outline-none focus:ring-0 text-sm text-gray-900 placeholder-gray-500 px-1 py-1"></textarea>
                                    <div class="flex items-center justify-between">
                                        <button type="button" id="assistant-import-model" class="magic-btn flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-500 hover:text-black hover:bg-gray-100 transition-colors" title="Importer un modèle">
                                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                                            </svg>
                                        </button>
                                        <button type="submit" class="magic-btn assistant-send-btn flex-shrink-0 w-8 h-8 text-white bg-black hover:bg-gray-800 rounded-xl flex items-center justify-center transition-colors">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                                            </svg>
                                        </button>
                                    </div>
                                </form>
                            </div>
                            <div class="assistant-hero-subtitle text-center text-sm text-gray-500 max-w-md mt-6">
                                Décrivez le modèle que vous souhaitez construire ou posez une question sur vos données.
                            </div>
                        </div>
                        <div class="assistant-messages" id="assistant-messages"></div>
                    </div>
                </div>
                <div class="assistant-input-area p-3 flex-shrink-0 hidden" id="assistant-input-area">
                    <div class="assistant-input-wrapper max-w-3xl mx-auto rounded-2xl border-2 border-gray-300 focus-within:border-black bg-white transition-colors shadow-sm">
                        <form id="assistant-bottom-form" class="flex flex-col gap-2 p-3">
                            <textarea id="assistant-bottom-input" rows="1" autocomplete="off"
                                placeholder="Interrogez l'assistant sémantique..."
                                class="w-full resize-none max-h-40 bg-transparent border-none focus:outline-none focus:ring-0 text-sm text-gray-900 placeholder-gray-500 px-1 py-1"></textarea>
                            <div class="flex items-center justify-between">
                                <button type="button" id="assistant-import-model-bottom" class="magic-btn flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-500 hover:text-black hover:bg-gray-100 transition-colors" title="Importer un modèle">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                                    </svg>
                                </button>
                                <button type="submit" class="magic-btn assistant-send-btn flex-shrink-0 w-8 h-8 text-white bg-black hover:bg-gray-800 rounded-xl flex items-center justify-center transition-colors">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                                    </svg>
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
                <input type="file" id="assistant-model-file" accept=".xmi,.owl,.ttl,.rdf,.json" class="hidden">
            </div>
        `;

        this.chatEl = container.querySelector('#assistant-chat');
        this.wrapperEl = container.querySelector('#assistant-wrapper');
        this.heroEl = container.querySelector('#assistant-hero');
        this.messagesEl = container.querySelector('#assistant-messages');
        this.inputArea = container.querySelector('#assistant-input-area');
        this.fileInput = container.querySelector('#assistant-model-file');
        this.inputEl = container.querySelector('#assistant-input');
        this.bottomInputEl = container.querySelector('#assistant-bottom-input');

        this._bindInputEvents();
        this._observeResize();

        const onSubmit = (textarea) => {
            const text = textarea.value.trim();
            if (!text || this.isStreaming) return;
            textarea.value = '';
            textarea.style.height = 'auto';
            this._switchToChatMode();
            this._send(text);
        };

        container.querySelector('#assistant-form').addEventListener('submit', (e) => {
            e.preventDefault();
            onSubmit(this.inputEl);
        });
        container.querySelector('#assistant-bottom-form').addEventListener('submit', (e) => {
            e.preventDefault();
            onSubmit(this.bottomInputEl);
        });

        if (window.GlowEffects && typeof window.GlowEffects.scanAndBind === 'function') {
            window.GlowEffects.scanAndBind(container);
        }

        const importBtn = container.querySelector('#assistant-import-model');
        const importBtnBottom = container.querySelector('#assistant-import-model-bottom');
        const doImport = () => this.fileInput.click();
        if (importBtn) importBtn.addEventListener('click', doImport);
        if (importBtnBottom) importBtnBottom.addEventListener('click', doImport);

        this.fileInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) this._importModel(file);
        });

        // Delegate clicks for embedded search result actions (preview / chat).
        this.messagesEl.addEventListener('click', (e) => {
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

        // Initial centering after layout is ready.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this._applyCentering(true));
        });
    }

    _bindInputEvents() {
        [this.inputEl, this.bottomInputEl].forEach((textarea) => {
            if (!textarea) return;
            textarea.addEventListener('input', () => {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
            });
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    textarea.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
            });
        });
    }

    _escape(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
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
        this.modelName = '';
        this.messages = [];
        this.messagesEl.innerHTML = '';
        this.heroEl.classList.remove('assistant-hero-compact');
        this.heroEl.classList.add('assistant-hero-home');
        this.chatEl.classList.remove('assistant-chat-mode');
        this.wrapperEl.classList.remove('assistant-wrapper-chat');
        if (this.inputArea) {
            this.inputArea.classList.add('hidden');
            this.inputArea.style.opacity = '';
            this.inputArea.style.transform = '';
            this.inputArea.style.transition = '';
        }
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';
        this.bottomInputEl.value = '';
        this.bottomInputEl.style.height = 'auto';
        // Reset centering and re-measure after layout.
        this.heroEl.style.paddingTop = '';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this._applyCentering(true));
        });
    }

    _switchToChatMode() {
        const hadFocus = document.activeElement === this.inputEl;
        this.heroEl.classList.remove('assistant-hero-home');
        this.heroEl.classList.add('assistant-hero-compact');
        this.chatEl.classList.add('assistant-chat-mode');
        this.wrapperEl.classList.add('assistant-wrapper-chat');

        this._applyCentering();

        if (this.inputArea) {
            this.inputArea.classList.remove('hidden');
            this.inputArea.style.opacity = '0';
            this.inputArea.style.transform = 'translateY(20px)';
            requestAnimationFrame(() => {
                this.inputArea.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                this.inputArea.style.opacity = '1';
                this.inputArea.style.transform = 'translateY(0)';
                setTimeout(() => {
                    this.inputArea.style.transition = '';
                    this.inputArea.style.transform = '';
                    if (hadFocus && this.bottomInputEl) {
                        this.bottomInputEl.focus();
                    }
                }, 520);
            });
        }
    }

    _measureHeroContentHeight() {
        if (!this.heroEl) return 360;
        let height = 0;
        for (const child of this.heroEl.children) {
            const rect = child.getBoundingClientRect();
            const styles = getComputedStyle(child);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            height += rect.height + marginTop + marginBottom;
        }
        return Math.max(height, 360);
    }

    _applyCentering(skipTransition) {
        if (!this.heroEl || !this.container) return;
        const was = this.heroEl.style.transition;
        if (skipTransition) this.heroEl.style.transition = 'none';

        if (this.chatEl.classList.contains('assistant-chat-mode')) {
            // Compact mode: small top padding, hero stays at the top.
            this.heroEl.style.paddingTop = '0.5rem';
            this.heroEl.style.paddingBottom = '0';
        } else {
            // Home mode: vertically center the hero content inside the app viewport.
            // Use the app container height (like Modeler/Search) for a stable measurement.
            const contentHeight = this._measureHeroContentHeight();
            const available = Math.max(this.container.clientHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2);
            this.heroEl.style.paddingTop = offset + 'px';
            this.heroEl.style.paddingBottom = '0';
        }

        if (skipTransition) {
            this.heroEl.offsetHeight;
            this.heroEl.style.transition = was;
        }
    }

    _observeResize() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (!this.container || typeof ResizeObserver === 'undefined') return;
        this._resizeObserver = new ResizeObserver(() => {
            if (!this.chatEl.classList.contains('assistant-chat-mode')) {
                this._applyCentering(true);
            }
        });
        this._resizeObserver.observe(this.container);
    }

    async _importModel(file) {
        if (!file) return;
        try {
            const result = await ApiClient.importAndSaveModel(file, file.name);
            if (result?.name || result?.model_name) {
                this.modelName = result.name || result.model_name;
                this._appendSystemMessage(`Modèle **${this._escape(this.modelName)}** importé avec succès. Vous pouvez maintenant lui poser des questions.`);
            } else {
                this._appendSystemMessage('Le modèle a été importé.');
            }
        } catch (err) {
            console.error('Assistant import model error', err);
            this._appendSystemMessage(`Erreur lors de l'import du modèle : ${this._escape(err.message)}`);
        }
        if (this.fileInput) this.fileInput.value = '';
    }

    _appendSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'flex flex-col items-start gap-3 mb-6';
        div.innerHTML = `
            <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">${this._markdown(text)}</div>
        `;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
    }

    _appendUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'flex items-end justify-end mb-6 user-msg-anchor';
        div.innerHTML = `<div class="bg-gray-50 border border-gray-100 text-gray-900 px-5 py-3.5 rounded-[1.5rem] text-sm max-w-[80%] leading-relaxed">${this._escape(text)}</div>`;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _appendThinkingPlaceholder(label = 'Réflexion...') {
        this._removeThinkingPlaceholder();
        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col items-start gap-3 mb-6 assistant-thinking-placeholder';
        wrapper.innerHTML = `
            <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body assistant-bubble-content" style="min-height:0;"></div>
            <div class="ai-avatar-row flex items-center gap-2">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic">
                    ${this._sparkleSvg()}
                </div>
                <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400">${this._escape(label)}</span>
            </div>
        `;
        this.messagesEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper;
    }

    _updateThinkingLabel(label) {
        const target = this.messagesEl.querySelector('.assistant-thinking-placeholder');
        if (!target) return;
        const labelEl = target.querySelector('.thinking-label');
        if (labelEl) labelEl.textContent = label;
    }

    _removeThinkingPlaceholder() {
        this.messagesEl.querySelectorAll('.assistant-thinking-placeholder').forEach((el) => {
            if (el.parentNode) el.remove();
        });
    }

    _ensureAssistantBubble() {
        // Create a new assistant message bubble if the last one is not an active assistant bubble.
        const last = this.messagesEl.lastElementChild;
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
        this.messagesEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper.querySelector('.assistant-bubble-content');
    }

    _forceReflow() {
        if (this.chatEl) {
            void this.chatEl.offsetHeight;
        }
    }

    _hideAllSparkles() {
        this.chatEl.querySelectorAll('.sparkle-container').forEach((container) => {
            const avatar = container.closest('.ai-avatar-wrapper') || container;
            avatar.classList.remove('trigger-magic');
            avatar.style.transition = 'opacity 0.3s ease, height 0.3s ease, margin 0.3s ease';
            avatar.style.opacity = '0';
            avatar.style.height = '0';
            avatar.style.margin = '0';
            avatar.style.overflow = 'hidden';
            setTimeout(() => { avatar.style.display = 'none'; }, 300);
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

        this.messagesEl.appendChild(div);
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
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _fillSearchCard(query, resultsHtml) {
        const cards = this.messagesEl.querySelectorAll('[data-search-card="true"]');
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
        const el = this.chatEl;
        if (!el) return;
        const threshold = 80; // px from bottom to consider "at bottom"
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
        if (isNearBottom) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
    }

    _isNearBottom() {
        const el = this.chatEl;
        if (!el) return true;
        const threshold = 80;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
    }

    async _send(text) {
        if (!this.session) {
            this.session = this._slugify(text);
        }

        this.messages.push({ role: 'user', content: text });
        this._appendUserMessage(text);
        this.isStreaming = true;

        // Start with a clean thinking placeholder. Hide stale sparkles first,
        // because a new user message begins a new assistant turn.
        this._hideAllSparkles();

        let placeholder = this._appendThinkingPlaceholder();
        const placeholderContent = placeholder.querySelector('.assistant-bubble-content');
        const loadingInterval = setInterval(() => {
            // Always target the latest placeholder so the sparkle keeps beating
            // across phase changes (text -> tool -> new text, etc.).
            const placeholders = Array.from(this.chatEl.querySelectorAll('.assistant-thinking-placeholder'));
            const latest = placeholders.length ? placeholders[placeholders.length - 1] : null;
            const avatar = latest?.querySelector('.ai-avatar-wrapper');
            if (avatar) {
                avatar.classList.remove('trigger-magic');
                void avatar.offsetWidth;
                avatar.classList.add('trigger-magic');
            }
        }, 1200);

        let currentBubble = null;
        let currentText = '';

        // Typewriter: stream raw text into a <span>, parsing markdown only at finalization
        // to avoid re-creating the DOM and losing selection on every chunk.
        let streamSpan = null;
        const typewriter = this._createTypewriter((chunk) => {
            currentText += chunk;
            if (!currentBubble) {
                // Remove the thinking placeholder as soon as real text starts so it
                // does not stay above the final answer.
                this._removeThinkingPlaceholder();
                this._closeAssistantBubble();
                currentBubble = this._ensureAssistantBubble();
                streamSpan = currentBubble.querySelector('.assistant-stream-text');
                if (!streamSpan) {
                    streamSpan = document.createElement('span');
                    streamSpan.className = 'assistant-stream-text';
                    currentBubble.appendChild(streamSpan);
                }
            }
            if (streamSpan) {
                streamSpan.textContent += chunk;
                this._forceReflow();
            }
        });

        const finalizeText = () => {
            typewriter.flush();
            if (currentBubble) {
                currentBubble.innerHTML = this._markdown(currentText);
                this._forceReflow();
            }
        };

        const resetBubble = () => {
            finalizeText();
            currentBubble = null;
            currentText = '';
            this._closeAssistantBubble();
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
                        // Each thinking event starts a new reasoning step. The helper
                        // removes any previous placeholder before creating a fresh one,
                        // so stale sparkles from earlier phases do not linger on screen.
                        this._removeThinkingPlaceholder();
                        placeholder = this._appendThinkingPlaceholder('Réflexion...');
                        return;
                    }

                    if (event.kind === 'assistant_text') {
                        typewriter.append(event.content || '');
                        return;
                    }

                    if (event.kind === 'assistant_tool_calls') {
                        resetBubble();
                        this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
                        return;
                    }

                    if (event.kind === 'tool_start') {
                        resetBubble();
                        // Render the tool card/search card BEFORE the placeholder so the
                        // sparkle/"Réflexion" label stays at the bottom of the current step.
                        if (event.name === 'retrieve_documents') {
                            this._appendSearchCard(event.arguments?.search_terms || '', null);
                        } else if (event.name !== 'plan_workflow_with_tools') {
                            const card = this._createToolCard(event.name, event.arguments || {});
                            this._markToolRunning(card, true);
                        }
                        // Show a transient status label while the tool runs. The helper
                        // removes any previous placeholder first.
                        placeholder = this._appendThinkingPlaceholder(this._toolStatusLabel(event.name));
                        this.messages.push({ role: 'tool_start', name: event.name, arguments: event.arguments });
                        return;
                    }

                    if (event.kind === 'tool_result') {
                        resetBubble();
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
                        resetBubble();
                        return;
                    }

                    if (event.kind === 'assistant_done') {
                        resetBubble();
                        // Remove any lingering thinking placeholder before rendering the final answer.
                        this._removeThinkingPlaceholder();
                        // If the backend only sent the final message inside assistant_done
                        // (no preceding assistant_text chunks), render it now.
                        if (event.content && !currentText && !currentBubble) {
                            currentText = event.content;
                            currentBubble = this._ensureAssistantBubble();
                            currentBubble.innerHTML = this._markdown(currentText);
                            this._forceReflow();
                        }
                        this._closeAssistantBubble();
                        return;
                    }

                    if (event.kind === 'error') {
                        resetBubble();
                        const bubble = this._ensureAssistantBubble();
                        bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(event.message || '')}</em>`;
                    }
                }
            );

        } catch (err) {
            console.error('Assistant stream error', err);
            this._appendThinkingPlaceholder(); // ensures any previous one is removed first
            const bubble = this._ensureAssistantBubble();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(err.message)}</em>`;
        } finally {
            clearInterval(loadingInterval);
            typewriter.stop();
            this.isStreaming = false;
            this._closeAssistantBubble();

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

    unmount() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        super.unmount();
    }
}

window.AssistantApp = AssistantApp;
