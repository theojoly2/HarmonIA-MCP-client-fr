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
                <div class="assistant-header" id="assistant-header">
                    <h1 class="assistant-header-title text-center">
                        <span class="assistant-title-glow title-glow">Assistant Sémantique</span>
                    </h1>
                </div>
                <div id="assistant-chat" class="flex-1 overflow-y-auto">
                    <div class="assistant-hero" id="assistant-hero">
                        <div class="assistant-hero-subtitle text-center text-sm text-gray-500 max-w-md">
                            Décrivez le modèle que vous souhaitez construire ou posez une question sur vos données.
                        </div>
                    </div>
                    <div class="assistant-messages" id="assistant-messages"></div>
                </div>
                <div class="assistant-input-area p-3 flex-shrink-0" id="assistant-input-area">
                    <div class="assistant-input-wrapper mx-auto rounded-xl border-2 border-gray-300 focus-within:border-black bg-white transition-colors shadow-sm" id="assistant-input-box">
                        <form id="assistant-form" class="flex flex-col">
                            <textarea id="assistant-input" rows="1" autocomplete="off"
                                placeholder="Interrogez l'assistant sémantique..."
                                class="w-full resize-none max-h-40 bg-transparent border-none focus:outline-none focus:ring-0 text-sm text-gray-900 placeholder-gray-500 px-2 py-1.5"></textarea>
                            <div class="flex items-center justify-between px-2 pb-1.5 pt-1.5">
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
                </div>
                <input type="file" id="assistant-model-file" accept=".xml,.xmi,.ttl,.json,.jsonld,.sql,.txt,.html,.htm,.csv" class="hidden">
            </div>
        `;

        this.chatEl = container.querySelector('#assistant-chat');
        this.headerEl = container.querySelector('#assistant-header');
        this.heroEl = container.querySelector('#assistant-hero');
        this.messagesEl = container.querySelector('#assistant-messages');
        this.inputArea = container.querySelector('#assistant-input-area');
        this.inputBox = container.querySelector('#assistant-input-box');
        this.fileInput = container.querySelector('#assistant-model-file');
        this.inputEl = container.querySelector('#assistant-input');

        this._bindInputEvents();
        this._observeResize();

        container.querySelector('#assistant-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputEl.value.trim();
            if (!text || this.isStreaming) return;
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
            this._switchToChatMode();
            this._send(text);
        });

        if (window.GlowEffects && typeof window.GlowEffects.scanAndBind === 'function') {
            window.GlowEffects.scanAndBind(container);
        }

        container.querySelector('#assistant-import-model').addEventListener('click', () => {
            this.fileInput.click();
        });

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
        if (!this.inputEl) return;
        this.inputEl.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
        });
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.inputEl.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
        });
    }

    async mount(container) {
        await super.mount(container);
        // If this instance was created from the history panel with a session,
        // load the persisted messages into the UI.
        if (this.props.session && this.props.fromHistory) {
            try {
                await this.loadHistory(this.props.session);
            } catch (err) {
                console.error('Assistant load history on mount error', err);
            }
        }
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
        this.chatEl.classList.remove('assistant-chat-mode');
        this.headerEl.classList.remove('assistant-header-compact');
        this.heroEl.classList.remove('assistant-hero-hidden');
        this.inputArea.classList.remove('assistant-input-area-chat');
        this.inputBox.classList.remove('assistant-input-box-chat');
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';
        this.heroEl.style.paddingTop = '';
        this.inputArea.style.top = '';
        this.inputArea.style.width = '';
        this.inputArea.style.position = '';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this._applyCentering(true));
        });
    }

    _switchToChatMode() {
        const hadFocus = document.activeElement === this.inputEl;
        this.chatEl.classList.add('assistant-chat-mode');
        this.headerEl.classList.add('assistant-header-compact');
        this.heroEl.classList.add('assistant-hero-hidden');
        this.inputArea.classList.add('assistant-input-area-chat');
        this.inputBox.classList.add('assistant-input-box-chat');
        if (hadFocus) {
            setTimeout(() => this.inputEl.focus(), 550);
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
            this.heroEl.style.paddingTop = '0';
            this.heroEl.style.paddingBottom = '0';
        } else {
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
            const result = await ApiClient.importAssistantModel(file, file.name);
            if (result?.name) {
                this.modelName = result.name;
                this._appendSystemMessage(`Modèle **${this._escape(result.display_name || result.name)}** importé avec succès. Vous pouvez maintenant lui poser des questions.`);
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
        div.className = 'assistant-bubble assistant-bubble-assistant mb-6';
        div.innerHTML = `
            <div class="assistant-bubble-content markdown-body">${this._markdown(text)}</div>
        `;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
    }

    async loadHistory(session) {
        console.log('[AssistantApp] loadHistory', session);
        const data = await ApiClient.getAssistantHistory(session);
        console.log('[AssistantApp] history data', data);
        if (!data || !Array.isArray(data.messages)) {
            console.warn('[AssistantApp] no messages in history data');
            return;
        }

        this.session = session;
        this.modelName = data.model_name || this.modelName || '';
        this.messages = [];
        this.messagesEl.innerHTML = '';
        this.activeSvgCard = null;
        this.activeSvgViewer = null;
        this._switchToChatMode();

        // Rebuild the visible timeline from persisted display events. Events are
        // emitted in stream order and map 1:1 to the renderer methods used during
        // the original conversation.
        const events = Array.isArray(data.display_events) ? data.display_events : [];
        let currentText = '';
        let replayBubble = null;
        let lastRole = null;

        const closeReplayBubble = () => {
            if (replayBubble && replayBubble.dataset.active === 'true') {
                replayBubble.dataset.active = 'false';
            }
            replayBubble = null;
            currentText = '';
        };

        const ensureReplayBubble = () => {
            if (!replayBubble || replayBubble.dataset.active !== 'true') {
                closeReplayBubble();
                replayBubble = document.createElement('div');
                replayBubble.className = 'assistant-bubble assistant-bubble-assistant mb-6';
                replayBubble.dataset.role = 'assistant';
                replayBubble.dataset.active = 'true';
                replayBubble.innerHTML = `<div class="assistant-bubble-content markdown-body"></div>`;
                this.messagesEl.appendChild(replayBubble);
            }
            return replayBubble.querySelector('.assistant-bubble-content');
        };

        const renderEvent = (event) => {
            const kind = event.kind;
            if (kind === 'user') {
                closeReplayBubble();
                this.activeSvgCard = null;
                this.activeSvgViewer = null;
                this._removeThinkingPlaceholder();
                this.messages.push({ role: 'user', content: event.content || '' });
                this._appendUserMessage(event.content || '');
                lastRole = 'user';
                return;
            }
            if (kind === 'assistant_text') {
                if (lastRole !== 'assistant') {
                    closeReplayBubble();
                }
                currentText += event.content || '';
                const bubble = ensureReplayBubble();
                bubble.innerHTML = this._markdown(currentText, false);
                lastRole = 'assistant';
                return;
            }
            if (kind === 'assistant_done') {
                if (event.content && !currentText) {
                    currentText = event.content;
                    const bubble = ensureReplayBubble();
                    bubble.innerHTML = this._markdown(currentText, false);
                }
                closeReplayBubble();
                this.activeSvgCard = null;
                this.activeSvgViewer = null;
                this._removeThinkingPlaceholder();
                lastRole = 'assistant';
                return;
            }
            if (kind === 'assistant_tool_calls') {
                closeReplayBubble();
                this._hideAllSparkles();
                this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
                lastRole = 'tool';
                return;
            }
            if (kind === 'tool_start') {
                closeReplayBubble();
                this._hideAllSparkles();
                this._removeThinkingPlaceholder();
                if (event.name === 'retrieve_documents') {
                    this._appendSearchCard(event.arguments?.search_terms || '', null);
                }
                lastRole = 'tool';
                return;
            }
            if (kind === 'progress_start') {
                closeReplayBubble();
                this._hideAllSparkles();
                this._removeThinkingPlaceholder();
                this._appendProgressCard(event.card_id, event.tool_name);
                lastRole = 'tool';
                return;
            }
            if (kind === 'progress_update') {
                this._updateProgressCard(event.card_id, event.percent, event.message);
                return;
            }
            if (kind === 'progress_done') {
                this._completeProgressCard(event.card_id);
                this._removeProgressStatus(event.card_id);
                return;
            }
            if (kind === 'tool_result') {
                closeReplayBubble();
                if (event.name === 'plan_workflow_with_tools') {
                    this._renderPlan(event.result);
                } else if (event.name === 'retrieve_documents') {
                    this._fillSearchCard(event.display?.query || '', event.display?.results_html || '');
                } else {
                    this._fillToolResult(event.name, event.result, event.display);
                }
                lastRole = 'tool';
                return;
            }
            if (kind === 'model_svg') {
                this._updateCurrentSvgCard(event.svg, event.model_name || 'Visualisation du modèle');
                return;
            }
            if (kind === 'loop_done') {
                closeReplayBubble();
                this.activeSvgCard = null;
                this.activeSvgViewer = null;
                return;
            }
            if (kind === 'thinking') {
                this._removeThinkingPlaceholder();
                this._appendThinkingPlaceholder('Réflexion...');
                return;
            }
            if (kind === 'error') {
                closeReplayBubble();
                const bubble = ensureReplayBubble();
                bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(event.message || '')}</em>`;
                lastRole = 'assistant';
                return;
            }
        };

        events.forEach(renderEvent);
        closeReplayBubble();
        this._removeThinkingPlaceholder();

        // Fallback: render any legacy display_messages that were not covered by events.
        let renderedUsers = this.messagesEl.querySelectorAll('.assistant-bubble-user').length;
        let renderedAssistants = this.messagesEl.querySelectorAll('.assistant-bubble-assistant').length;
        for (const msg of data.messages) {
            const role = msg.role;
            const content = msg.content || '';
            if (role === 'user') {
                if (renderedUsers === 0) {
                    this.messages.push({ role: 'user', content });
                    this._appendUserMessage(content);
                }
                renderedUsers = Math.max(0, renderedUsers - 1);
            } else if (role === 'assistant') {
                if (renderedAssistants === 0 && content.trim()) {
                    const div = document.createElement('div');
                    div.className = 'assistant-bubble assistant-bubble-assistant mb-6';
                    div.innerHTML = `<div class="assistant-bubble-content markdown-body">${this._markdown(content, false)}</div>`;
                    this.messagesEl.appendChild(div);
                }
                renderedAssistants = Math.max(0, renderedAssistants - 1);
                this.messages.push({ role: 'assistant', content });
            }
        }

        // Ensure the view is scrolled all the way to the bottom after rendering.
        requestAnimationFrame(() => {
            this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'auto' });
        });
        console.log('[AssistantApp] loaded messages count', this.messages.length);
    }

    _appendUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'assistant-bubble assistant-bubble-user mb-6 user-msg-anchor';
        div.innerHTML = `<div class="assistant-bubble-content">${this._escape(text)}</div>`;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _appendThinkingPlaceholder(label = 'Réflexion...') {
        this._removeThinkingPlaceholder();
        const wrapper = document.createElement('div');
        wrapper.className = 'assistant-bubble assistant-bubble-assistant mb-6 assistant-thinking-placeholder';
        wrapper.innerHTML = `
            <div class="assistant-bubble-content markdown-body" style="min-height:0;"></div>
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
        wrapper.className = 'assistant-bubble assistant-bubble-assistant mb-6';
        wrapper.dataset.role = 'assistant';
        wrapper.dataset.active = 'true';
        wrapper.innerHTML = `
            <div class="assistant-bubble-content markdown-body"></div>
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

    _throttledReflow() {
        if (this._reflowRaf) return;
        this._reflowRaf = requestAnimationFrame(() => {
            this._reflowRaf = null;
            this._forceReflow();
        });
    }

    _throttledScrollToBottom() {
        if (this._scrollRaf) return;
        this._scrollRaf = requestAnimationFrame(() => {
            this._scrollRaf = null;
            this._scrollToBottom();
        });
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

    _appendProgressCard(cardId, toolName) {
        const labels = {
            metadata_checker: 'Vérification des métadonnées',
            validator_check: 'Validation guide de style',
            reuse_check: 'Vérification de réutilisation',
            style_guide_check: 'Synthèse de la réponse',
        };
        const label = labels[toolName] || toolName;
        const div = document.createElement('div');
        div.id = cardId;
        div.className = 'assistant-progress-card mb-4';
        div.dataset.progressCard = 'true';
        div.innerHTML = `
            <div class="assistant-progress-header">
                <svg class="text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
                <span>${this._escape(label)} en cours</span>
            </div>
            <div class="assistant-progress-body">
                <div class="assistant-progress-bar-bg">
                    <div class="assistant-progress-bar-fill" style="width:0%"></div>
                </div>
                <div class="assistant-progress-message"></div>
            </div>
        `;
        this.messagesEl.appendChild(div);
        // Also add a pulsing sparkle placeholder just below the card, like "Planification en cours...".
        const status = this._appendThinkingPlaceholder(label);
        status.dataset.progressStatus = cardId;
        this._startFakeProgress(cardId);
        this._scrollToBottom();
        return div;
    }

    _startFakeProgress(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const fill = card.querySelector('.assistant-progress-bar-fill');
        card.dataset.realPercent = '0';

        let fakePercent = 0;
        let velocity = 0;
        let lastTime = performance.now();

        const step = (now) => {
            if (!document.getElementById(cardId)) return;
            const reported = parseInt(card.dataset.realPercent || '0', 10);
            const dt = Math.min((now - lastTime) / 1000, 0.5);
            lastTime = now;

            // Target is slightly ahead of reported progress, capped at 90% until real done.
            const headroom = reported > 0 ? Math.min(90, reported + 5) : 90;
            const distance = headroom - fakePercent;

            if (distance > 0) {
                // Slow, smooth spring-like acceleration with a little randomness.
                const targetVelocity = Math.max(0.2, distance * 0.35 + Math.random() * 1.5);
                velocity += (targetVelocity - velocity) * 1.2 * dt;
                const stepSize = velocity * dt;
                fakePercent = Math.min(headroom, fakePercent + stepSize);
            } else {
                velocity *= 0.85;
            }

            if (fill && fakePercent > reported) {
                fill.style.width = `${fakePercent}%`;
            }

            card._fakeProgressFrame = requestAnimationFrame(step);
        };

        card._fakeProgressFrame = requestAnimationFrame(step);
    }

    _stopFakeProgress(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        if (card._fakeProgressFrame) {
            cancelAnimationFrame(card._fakeProgressFrame);
            card._fakeProgressFrame = null;
        }
    }

    _updateProgressCard(cardId, percent, message) {
        const card = document.getElementById(cardId);
        if (!card) return;
        const fill = card.querySelector('.assistant-progress-bar-fill');
        const msg = card.querySelector('.assistant-progress-message');
        card.dataset.realPercent = String(percent);
        if (fill) fill.style.width = `${percent}%`;
        if (msg) msg.textContent = message || '';
        this._scrollToBottom();
    }

    _removeProgressStatus(cardId) {
        this.messagesEl.querySelectorAll(`[data-progress-status="${cardId}"]`).forEach((el) => {
            if (el.parentNode) el.remove();
        });
    }

    _completeProgressCard(cardId) {
        const card = document.getElementById(cardId);
        if (!card) return;
        this._stopFakeProgress(cardId);
        const fill = card.querySelector('.assistant-progress-bar-fill');
        if (fill) {
            fill.style.transition = 'width 0.3s ease';
            fill.style.width = '100%';
        }
        card.classList.add('assistant-progress-done');
        this._scrollToBottom();
    }

    _fillToolResult(name, result, display) {
        if (display && display.type === 'search') {
            this._fillSearchCard(display.query || '', display.results_html || '');
            return null;
        }

        // Mutation and analysis tools are silent: no JSON card is shown. Mutations
        // update the SVG card; analysis results flow into the assistant's answer.
        const silentTools = {
            add_class: true,
            add_attribute: true,
            add_connector: true,
            metadata_checker: true,
            reuse_check: true,
            style_guide_check: true,
            validator_check: true,
        };
        if (silentTools[name]) {
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
                <span>Plan d’action</span>
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
                <svg class="text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

    _appendSvgCard(svgText, label = 'Visualisation du modèle') {
        if (!svgText) return null;
        const id = 'assistant-svg-' + Date.now();
        const div = document.createElement('div');
        div.id = id;
        div.className = 'assistant-svg-card mb-6';
        div.dataset.svgCard = 'true';
        div.innerHTML = `
            <div class="assistant-svg-header">
                <svg class="text-purple-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                </svg>
                <span>${label}</span>
            </div>
            <div class="assistant-svg-body"></div>
        `;
        this.messagesEl.appendChild(div);
        const body = div.querySelector('.assistant-svg-body');
        const viewer = new SvgViewer(body, { defaultScale: 1 });
        viewer.setSvgAndRestore(svgText, '');
        this.activeSvgCard = div;
        this.activeSvgViewer = viewer;
        this._scrollToBottom();
        return div;
    }

    _updateCurrentSvgCard(svgText, label = 'Visualisation du modèle') {
        if (!svgText) return;
        if (!this.activeSvgCard || !this.activeSvgViewer) {
            this._appendSvgCard(svgText, label);
        } else {
            const state = this.activeSvgViewer.getState();
            this.activeSvgViewer.setSvg(svgText, '');
            this.activeSvgViewer.restoreState(state);
        }
        this._scrollToBottom();
    }

    _freezeCurrentSvgCard() {
        if (this.activeSvgCard && this.activeSvgViewer) {
            // Detach the live viewer reference so the card becomes a static snapshot.
            this.activeSvgCard.dataset.svgFrozen = 'true';
        }
        this.activeSvgCard = null;
        this.activeSvgViewer = null;
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

    _stripLatexText(label) {
        if (!label) return '';
        // Remove \text{...} wrappers while preserving the content.
        return label.replace(/\\text\{([^{}]*)\}/g, '$1').trim();
    }

    _preprocessLatex(text) {
        if (!text) return '';
        // Convert extensible arrows with text above/below: \xrightarrow{text} / \xleftarrow{text}
        // The label may itself contain nested braces (e.g. \text{...}), so we match balanced
        // braces to capture the whole argument.
        const balancedArg = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
        text = text.replace(
            new RegExp('\\\\xrightarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = this._stripLatexText(label).trim();
                return clean ? `${clean} →` : '→';
            }
        );
        text = text.replace(
            new RegExp('\\\\xleftarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = this._stripLatexText(label).trim();
                return clean ? `← ${clean}` : '←';
            }
        );
        text = text.replace(
            new RegExp('\\\\xleftrightarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = this._stripLatexText(label).trim();
                return clean ? `↔ ${clean}` : '↔';
            }
        );
        // Single-pass replacement table for common LaTeX commands.
        // Using one regex with a lookup map is much faster than chaining 200+
        // .replace() calls on long assistant answers.
        const latexMap = {
            rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
            Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
            longrightarrow: '⟶', longleftarrow: '⟵', mapsto: '↦',
            to: '→', gets: '←', iff: '⇔', implies: '⇒', impliedby: '⇐',
            uparrow: '↑', downarrow: '↓', nearrow: '↗', searrow: '↘',
            swarrow: '↙', nwarrow: '↖',
            alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
            zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
            lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
            sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ',
            omega: 'ω',
            Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
            Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
            cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓',
            leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠',
            approx: '≈', sim: '∼', cong: '≅', equiv: '≡', propto: '∝',
            infty: '∞', partial: '∂', nabla: '∇',
            sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', sqrt: '√',
            forall: '∀', exists: '∃', in: '∈', notin: '∉',
            subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
            cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
            setminus: '\\', backslash: '\\',
            wedge: '∧', vee: '∨', neg: '¬', lnot: '¬',
            top: '⊤', bot: '⊥', angle: '∠', perp: '⊥', parallel: '∥', mid: '|',
            dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', ldots: '…',
            prime: '′', circ: '°', bullet: '•', star: '★', ast: '*',
            dagger: '†', ddagger: '‡', S: '§', P: '¶', copyright: '©',
            pounds: '£', euro: '€',
            textdegree: '°', textcelsius: '°C', texteuro: '€',
            textleftarrow: '←', textrightarrow: '→', textuparrow: '↑',
            textdownarrow: '↓', textbullet: '•', textasteriskcentered: '*',
            textbardbl: '‖', textbigcircle: '○', textblank: '␣',
            textbrokenbar: '¦', textcent: '¢', textcopyright: '©',
            textcurrency: '¤', textdagger: '†', textdaggerdbl: '‡',
            textdiscount: '⁒', textdivorced: '⚮', textestimated: '℮',
            textfractionsolidus: '⁄', textgravedbl: '̏', textinterrobang: '‽',
            textlangle: '⟨', textlbrackdbl: '⟦', textlnot: '¬',
            textmarried: '⚭', textmusicalnote: '♪', textnineoldstyle: '9',
            textnumero: '№', textopenbullet: '◦', textparagraph: '¶',
            textperiodcentered: '·', textpertenthousand: '‱',
            textperthousand: '‰', textphi: 'φ', textpilcrow: '¶', textpm: '±',
            textquestiondown: '¿', textrangle: '⟩', textrbrackdbl: '⟧',
            textrecipe: '℞', textreferencemark: '※', textregistered: '®',
            textsection: '§', textservicemark: '℠', textsevenoldstyle: '7',
            textsixoldstyle: '6', textsterling: '£', textthreeoldstyle: '3',
            textthreesuperior: '³', texttildelow: '˜', texttimes: '×',
            texttrademark: '™', texttwooldstyle: '2', texttwosuperior: '²',
            textunderscore: '_', textuparrow: '↑', textvisiblespace: '␣',
            textwon: '₩', textyen: '¥',
        };
        const latexRegex = /\\([A-Za-z]+|\$)/g;
        text = text.replace(latexRegex, (match, command) => {
            if (command === '$') return '';
            return latexMap[command] !== undefined ? latexMap[command] : match;
        });

        // Remove remaining inline math delimiters and their content if simple
        text = text.replace(/\$([^$]+)\$/g, '$1');
        return text;
    }

    _markdown(text, streaming = false) {
        if (!text) return '';
        if (typeof marked === 'undefined') {
            return this._escape(text).replace(/\n/g, '<br>');
        }
        // During streaming, skip the expensive full re-parse of markdown and
        // just render plain escaped text with line breaks. This avoids UI
        // freezes when the assistant produces a long final answer. We do a final
        // proper markdown render once streaming ends.
        if (streaming) {
            return this._escape(text).replace(/\n/g, '<br>');
        }
        return marked.parse(this._preprocessLatex(text), { breaks: true, gfm: true });
    }

    _toolStatusLabel(name) {
        const labels = {
            plan_workflow_with_tools: 'Planification en cours...',
            retrieve_documents: 'Recherche de documents...',
            add_class: 'Création de la classe...',
            add_attribute: "Ajout d'un attribut...",
            add_connector: 'Création de la relation...',
            style_guide_check: 'Synthèse de la réponse...',
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

        // Abort controller lets the client survive long waits and prevents duplicate streams.
        this._streamAbortController?.abort();
        this._streamAbortController = new AbortController();

        // Streaming markdown renderer: tokens appear as they arrive from the LLM,
        // but the markdown is re-rendered only when safe (no unclosed markdown
        // markers) and at "structure breakpoints" so the visible formatting stays
        // mostly up-to-date without freezing the UI. Tokens are appended as raw text
        // between two re-renders, which prevents the duplication seen when mixing
        // plain-text DOM nodes with full HTML replacement.
        const STRUCTURE_RE = /[ \n\r\t.,;:!?*`_#\-+=~\[\](){}|'"\\/<>.]/;
        const MIN_REPARSE_MS = 60;
        const MAX_PLAIN_MS = 300;
        let lastReparsedAt = 0;
        let pendingPlain = '';
        let lastPlainAt = 0;

        const hasUnclosedMarkdown = (txt) => {
            // Count backticks: odd means an inline code span is open.
            const backticks = (txt.match(/`/g) || []).length;
            if (backticks % 2 !== 0) return true;
            // Count double-asterisks (bold). Odd count means an opener/closer is pending.
            const doubleStars = (txt.match(/\*\*/g) || []).length;
            if (doubleStars % 2 !== 0) return true;
            // Single underscores/asterisks used as emphasis markers. Approximation: if the
            // total count of unescaped emphasis markers is odd, an emphasis span is open.
            const emphasis = (txt.match(/(^|[^\\])[_*](?=[^\s]|$)/g) || []).length;
            if (emphasis % 2 !== 0) return true;
            return false;
        };

        const typewriter = this._createTypewriter((chunk) => {
            currentText += chunk;
            pendingPlain += chunk;

            if (!currentBubble) {
                this._removeThinkingPlaceholder();
                this._closeAssistantBubble();
                currentBubble = this._ensureAssistantBubble();
                currentBubble.innerHTML = '';
                lastReparsedAt = performance.now();
                lastPlainAt = lastReparsedAt;
            }

            const now = performance.now();
            const lastChar = chunk.slice(-1);
            const isBreakpoint = STRUCTURE_RE.test(lastChar);
            const tooLongPlain = (now - lastPlainAt > MAX_PLAIN_MS) && (now - lastReparsedAt > MIN_REPARSE_MS);
            const safeToRender = !hasUnclosedMarkdown(currentText);
            const shouldReparse = (isBreakpoint || tooLongPlain) && safeToRender && (now - lastReparsedAt > MIN_REPARSE_MS);

            if (shouldReparse) {
                currentBubble.innerHTML = this._markdown(currentText, false);
                pendingPlain = '';
                lastReparsedAt = now;
                lastPlainAt = now;
                this._throttledReflow();
                this._throttledScrollToBottom();
            } else if (currentBubble) {
                // Fast path: append raw text to the live DOM without re-parsing
                // markdown. We insert pendingPlain if any to keep the DOM minimal.
                if (pendingPlain) {
                    const tail = currentBubble.lastChild;
                    if (tail && tail.nodeType === Node.TEXT_NODE) {
                        tail.textContent += pendingPlain;
                    } else {
                        currentBubble.appendChild(document.createTextNode(pendingPlain));
                    }
                    pendingPlain = '';
                    lastPlainAt = now;
                }
                this._throttledReflow();
                this._throttledScrollToBottom();
            }
        });

        const finalizeText = async () => {
            typewriter.flush();
            if (currentBubble) {
                // Yield to the browser so the progress-done transition / last chunks
                // are painted before the final markdown parse.
                await new Promise((resolve) => requestAnimationFrame(resolve));
                currentBubble.innerHTML = this._markdown(currentText, false);
                this._forceReflow();
            }
        };

        const resetBubble = () => {
            typewriter.flush();
            if (currentBubble) {
                // Convert the streaming view into the final markdown render before
                // closing this bubble so the next bubble starts clean and formatted.
                currentBubble.innerHTML = this._markdown(currentText, false);
            }
            pendingPlain = '';
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
                    if (this._streamAliveTimeout) {
                        clearTimeout(this._streamAliveTimeout);
                        this._streamAliveTimeout = null;
                    }
                    // Restart the watchdog each time something arrives (2 min silence = dead).
                    this._streamAliveTimeout = setTimeout(() => {
                        this._streamAbortController?.abort();
                    }, 120000);

                    if (event.kind === 'user') {
                        if (event.session) this.session = event.session;
                        // A new user message starts a new turn: freeze any previous SVG card
                        // immediately so mutations in this turn create a fresh visualization card.
                        this._freezeCurrentSvgCard();
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
                        // Hide the verbose tool-call list; only progress cards (and the
                        // plan card) give the user feedback now.
                        this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
                        return;
                    }

                    if (event.kind === 'tool_start') {
                        resetBubble();
                        // Hide the sparkle on any previous assistant bubble as soon as a new
                        // tool starts, so it does not stay under an intermediate message.
                        this._hideAllSparkles();
                        // Render the tool card/search card BEFORE the placeholder so the
                        // sparkle/"Réflexion" label stays at the bottom of the current step.
                        if (event.name === 'retrieve_documents') {
                            this._appendSearchCard(event.arguments?.search_terms || '', null);
                        } else if (event.name === 'display_model_visualization') {
                            // SVG cards are created/updated by the model_svg event, no extra card here.
                        }
                        // Tool cards (JSON dumps) are intentionally hidden for all tools,
                        // including unknown ones. Only progress cards, plan card, search
                        // results and SVG visualizations remain visible.
                        // Show a transient status label while the tool runs. The helper
                        // removes any previous placeholder first.
                        placeholder = this._appendThinkingPlaceholder(this._toolStatusLabel(event.name));
                        return;
                    }

                    if (event.kind === 'progress_start') {
                        resetBubble();
                        this._hideAllSparkles();
                        this._appendProgressCard(event.card_id, event.tool_name);
                        return;
                    }

                    if (event.kind === 'progress_update') {
                        this._updateProgressCard(event.card_id, event.percent, event.message);
                        return;
                    }

                    if (event.kind === 'progress_done') {
                        this._completeProgressCard(event.card_id);
                        this._removeProgressStatus(event.card_id);
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
                        return;
                    }

                    if (event.kind === 'loop_done') {
                        resetBubble();
                        return;
                    }

                    if (event.kind === 'model_svg') {
                        // Update the active SVG card if one exists; otherwise create a new one.
                        // The active card is frozen (and detached) on every new user message, so
                        // a new user request always starts with a fresh visualization card.
                        // Multiple model_svg events within the same turn update that same card.
                        this._updateCurrentSvgCard(event.svg, event.label || 'Visualisation du modèle');
                        return;
                    }

                    if (event.kind === 'user') {
                        // Handled at the top of the event handler.
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
                            currentBubble.innerHTML = this._markdown(currentText, false);
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


        }
    }

    _createTypewriter(onChunk, options = {}) {
        // By default, render each append() as a whole token/word. This matches how
        // the backend streams LLM tokens and avoids the artificial "character by
        // character" feel. Very long tokens are still split at spaces to keep the
        // UI responsive.
        const maxTokenLength = options.maxTokenLength || 80;

        let buffer = '';
        let rafId = null;
        let running = false;

        const emitNext = () => {
            if (buffer === '') return;
            // Prefer emitting whole words/tokens. If a token is too long, split on
            // spaces; if there are no spaces, take the whole chunk.
            let chunk = buffer;
            if (chunk.length > maxTokenLength) {
                const cut = chunk.lastIndexOf(' ', maxTokenLength);
                const splitAt = cut > 0 ? cut : maxTokenLength;
                chunk = chunk.slice(0, splitAt);
            }
            buffer = buffer.slice(chunk.length);
            if (chunk) onChunk(chunk);
        };

        const schedule = () => {
            if (running || rafId) return;
            running = true;
            rafId = requestAnimationFrame(() => {
                emitNext();
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
                    emitNext();
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
