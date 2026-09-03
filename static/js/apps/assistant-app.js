/**
 * AssistantApp
 * Chatbot de modélisation sémantique avec tool calling.
 * UI inspirée de ChatApp (fenêtre flottante) : fond blanc, coins arrondis,
 * input "pill", bouton d'envoi noir rond, avatar sparkle, markdown-body.
 */

class AssistantApp extends AppBase {
    static id = 'assistant';
    static title = 'Analyser';
    static iconSvg = `<svg class="w-4 h-4 overflow-visible" viewBox="0 0 24 24">
        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
    </svg>`;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.session = props.session || '';
        // Up to 3 models can be attached to the assistant context. For backward
        // compatibility a single string may arrive from older sessions.
        this.modelNames = this._normalizeModelNames(props.modelNames ?? props.modelName);
        this.modelNamesConfig = { max: 3 };
        // Origin tracks whether this conversation was started from the modeler
        // or from the standalone assistant. It is saved by the backend so the
        // modeler can reopen only its own conversations.
        this.origin = props.origin || 'assistant';
        this.messages = [];
        this.isStreaming = false;
        this.messagesHtml = '';
        // Capture new events while the app is unmounted. When the user switches
        // back, setState will replay the missed events into the new DOM.
        this._pendingEvents = [];
        this._lastRenderedEventIndex = -1;
        // Models currently being imported. Each entry: { name, displayName, loading: true }.
        this._loadingModels = [];
        // Doc ids imported into this assistant conversation from search result cards,
        // mapped to the final backend model name. Allows the + button to become a
        // cross that removes the model on second click.
        this._importedSearchDocIds = new Map();
        // Text accumulated for the assistant message currently being streamed. Stored
        // on the instance so it survives a tab switch (the old DOM is discarded and
        // rebuilt from the HTML snapshot).
        this._currentStreamingText = '';
        // When embedded inside the modeler (inline side panel or split pane), the
        // modeler instance provides the canvas so we don't render SVG cards here.
        this._linkedModelerInstanceId = props.linkedModelerInstanceId || '';
        this._embedded = !!(props.embedded || props.linkedModelerInstanceId || this._linkedModelerInstanceId);
    }

    render(container) {
        // If the container is the cached live DOM, don't rebuild. The SSE events
        // kept flowing in the background, so the chat is already up-to-date.
        if (this.container === container && container.querySelector('#assistant-chat')) {
            this._observeResize();
            this._scheduleCentering(true);
            if (this.messagesEl && this.messagesEl.children.length > 0) {
                this.chatEl.classList.add('assistant-chat-mode');
                this.welcomeEl.classList.add('assistant-welcome-top');
                this.inputArea.classList.add('assistant-input-area-chat');
                // When remounting from cache, wait for layout and then scroll so
                // the last message is visible above the floating input area.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (!this.chatEl || !this.inputArea) return;
                        this._scrollToBottom(true);
                    });
                });
            }
            this._syncModelUi();
            return;
        }
        this.container = container;
        this._embedded = this._embedded || !!(this.props.linkedModelerInstanceId || this._linkedModelerInstanceId);
        const embeddedClass = this._embedded ? 'assistant-embedded' : '';
        container.innerHTML = `
            <div class="assistant-app h-full w-full flex flex-col bg-white rounded-[1.25rem] overflow-hidden relative ${embeddedClass}">
                <div class="assistant-embedded-header ${embeddedClass ? '' : 'hidden'}" id="assistant-embedded-header">
                    <button type="button" id="assistant-close-split" class="w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:text-black hover:bg-gray-100 transition-colors" title="Fermer le panneau assistant">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <div id="assistant-chat" class="flex-1 overflow-y-auto relative">
                    <div class="assistant-welcome" id="assistant-welcome">
                        <h1 class="assistant-welcome-title text-center">
                            <button type="button" id="assistant-reset" class="assistant-title-reset" title="Nouvelle analyse">
                                <span class="assistant-title-glow title-glow">Analyser des modèles</span>
                            </button>
                        </h1>
                        <p class="assistant-welcome-subtitle">Discutez avec l'assistant pour analyser, comparer, fusionner et améliorer vos modèles. Formats supportés : TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML.</p>
                        <div class="assistant-welcome-input" id="assistant-welcome-input"></div>
                    </div>
                    <div class="assistant-embedded-intro" id="assistant-embedded-intro"></div>
                    <div class="assistant-messages" id="assistant-messages"></div>
                </div>
                <div class="assistant-input-area flex-shrink-0 ${embeddedClass}" id="assistant-input-area">
                    <div class="assistant-input-wrapper mx-auto rounded-xl border-2 border-gray-300 focus-within:border-black bg-white transition-colors shadow-sm" id="assistant-input-box">
                        <form id="assistant-form" class="flex flex-col">
                            <textarea id="assistant-input" rows="1" autocomplete="off"
                                placeholder="Interrogez l'assistant de modélisation..."
                                class="w-full resize-none max-h-40 bg-transparent border-none focus:outline-none focus:ring-0 text-sm text-gray-900 placeholder-gray-500 px-2 py-1.5"></textarea>
                            <div class="flex items-center justify-between px-2 pb-1.5 pt-1.5">
                                <div class="flex items-center gap-1.5">
                                    <button type="button" id="assistant-import-model" class="magic-btn flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-500 hover:text-black hover:bg-gray-100 transition-colors" title="Importer un modèle (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML)">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                                        </svg>
                                    </button>
                                    <div id="assistant-model-pill-slot" class="flex-shrink-0"></div>
                                </div>
                                <div class="flex items-center gap-1.5 relative">
                                    <button type="button" id="assistant-sources" class="magic-btn flex-shrink-0 h-8 px-2.5 flex items-center gap-1.5 rounded-xl text-gray-600 hover:text-black hover:bg-gray-100 transition-colors text-xs font-semibold" title="Sélectionner les sources">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path>
                                        </svg>
                                        <span id="assistant-sources-label">Sources</span>
                                    </button>
                                    <button type="submit" id="assistant-send" class="magic-btn assistant-send-btn flex-shrink-0 w-8 h-8 text-white bg-black hover:bg-gray-800 rounded-xl flex items-center justify-center transition-colors">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                                        </svg>
                                    </button>
                                    <div id="assistant-sources-menu" class="assistant-sources-menu hidden"></div>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
                <input type="file" id="assistant-model-file" accept=".xml,.xmi,.ttl,.json,.jsonld,.sql,.txt,.html,.htm,.csv" class="hidden">
            </div>
        `;

        this.chatEl = container.querySelector('#assistant-chat');
        this.welcomeEl = container.querySelector('#assistant-welcome');
        this.welcomeInputSlot = container.querySelector('#assistant-welcome-input');
        this.messagesEl = container.querySelector('#assistant-messages');
        this.embeddedIntroEl = container.querySelector('#assistant-embedded-intro');
        this.modelPillSlotEl = container.querySelector('#assistant-model-pill-slot');
        this.embeddedHeader = container.querySelector('#assistant-embedded-header');
        this.inputArea = container.querySelector('#assistant-input-area');
        this.inputBox = container.querySelector('#assistant-input-box');
        this.fileInput = container.querySelector('#assistant-model-file');
        this.inputEl = container.querySelector('#assistant-input');
        this.sourcesBtn = container.querySelector('#assistant-sources');
        this.sourcesLabel = container.querySelector('#assistant-sources-label');
        this.sourcesMenu = container.querySelector('#assistant-sources-menu');
        this.sendBtn = container.querySelector('#assistant-send');
        this.selectedTags = [];
        this.tagsHtml = '';
        this._tagsReady = false;

        this._bindInputEvents();
        this._observeResize();
        this._observeMessagesScroll();

        container.querySelector('#assistant-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputEl.value.trim();
            if (!text || this.isStreaming) return;
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
            this._switchToChatMode();
            this._send(text);
        });

        const importBtn = container.querySelector('#assistant-import-model');
        if (this._embedded) {
            if (this.embeddedIntroEl) {
                const introText = 'Je peux vous aider à explorer ou modifier le modèle affiché dans le canvas. Posez-moi une question ou demandez une modification.';
                this.embeddedIntroEl.innerHTML = `
                    <div class="assistant-bubble assistant-bubble-assistant mb-6">
                        <div class="assistant-bubble-content markdown-body">
                            ${this._markdown(introText, false)}
                        </div>
                        <div class="ai-avatar-row flex items-center gap-2">
                            <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                                ${this._sparkleSvg()}
                            </div>
                        </div>
                    </div>
                `;
                this.embeddedIntroEl.classList.remove('hidden');
            }
            if (importBtn) {
                importBtn.style.display = 'none';
            }

        }

        this._syncModelUi();
        this._renderLoginBanner();

        if (window.GlowEffects && typeof window.GlowEffects.scanAndBind === 'function') {
            window.GlowEffects.scanAndBind(container);
        }

        container.querySelector('#assistant-reset').addEventListener('click', () => {
            this._newSession();
        });

        if (importBtn && !this._embedded) {
            importBtn.addEventListener('click', () => {
                this.fileInput.click();
            });
        }

        const closeSplitBtn = container.querySelector('#assistant-close-split');
        if (closeSplitBtn && this._embedded && this.props.linkedModelerInstanceId) {
            closeSplitBtn.addEventListener('click', () => {
                EventBus.emit('assistant-split-close', { linkedModelerInstanceId: this.props.linkedModelerInstanceId });
            });
        }

        this.fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            const remaining = Math.max(0, this.modelNamesConfig.max - ((this.modelNames?.length || 0) + (this._loadingModels?.length || 0)));
            const toImport = files.slice(0, remaining);
            for (const file of toImport) this._importModel(file);
            if (this.fileInput) this.fileInput.value = '';
        });

        this.sourcesBtn.addEventListener('click', () => this._toggleSourcesMenu());

        // Delegate clicks for search result cards inside the assistant chat.
        this.messagesEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const docId = btn.dataset.docId;
            const documentId = btn.dataset.documentId;
            const name = btn.dataset.name;
            const filename = btn.dataset.filename;
            if (action === 'preview') {
                EventBus.emit('open-preview', { docId, documentId, name });
            } else if (action === 'chat') {
                EventBus.emit('open-chat', { documentId, name });
            } else if (action === 'add-to-assistant') {
                const alreadyAdded = this._importedSearchDocIds.has(docId);
                if (alreadyAdded) {
                    const modelName = this._importedSearchDocIds.get(docId);
                    if (modelName) this._removeModelPill(modelName);
                } else {
                    this._importSearchResultIntoAssistant(docId, filename);
                }
            }
        });

    }

    _bindInputEvents() {
        if (!this.inputEl) return;
        this.inputEl.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
            this._applyCentering(true);
        });
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.inputEl.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
        });
    }

    getState() {
        return {
            session: this.session,
            modelNames: this.modelNames,
            origin: this.origin || 'assistant',
            messagesHtml: this.messagesEl ? this.messagesEl.innerHTML : '',
            welcomeTop: this.welcomeEl ? this.welcomeEl.classList.contains('assistant-welcome-top') : false,
            chatMode: this.chatEl ? this.chatEl.classList.contains('assistant-chat-mode') : false,
            inputAreaChat: this.inputArea ? this.inputArea.classList.contains('assistant-input-area-chat') : false,
            selectedTags: this.selectedTags || [],
            isStreaming: this.isStreaming,
            linkedModelerInstanceId: this._linkedModelerInstanceId || '',
            origin: this.origin || 'assistant',
            chatScrollTop: this.chatEl ? this.chatEl.scrollTop : 0,
        };
    }

    setState(state) {
        if (!state || !Object.keys(state).length) return;
        if (state.session !== undefined) this.session = state.session;
        if (state.modelNames !== undefined) this.modelNames = this._normalizeModelNames(state.modelNames);
        if (state.origin !== undefined) this.origin = state.origin || 'assistant';
        if (state.isStreaming !== undefined) this.isStreaming = state.isStreaming;
        // Only restore the message HTML if we actually have saved HTML. An empty
        // saved state must not wipe out messages that were just loaded from history.
        if (this.messagesEl && state.messagesHtml) {
            this.messagesEl.innerHTML = state.messagesHtml;
        }
        if (this.welcomeEl && state.welcomeTop) {
            this.welcomeEl.classList.add('assistant-welcome-top');
        }
        if (this.chatEl && state.chatMode) {
            this.chatEl.classList.add('assistant-chat-mode');
        }
        if (this.inputArea && state.inputAreaChat) {
            this.inputArea.classList.add('assistant-input-area-chat');
        }
        if (state.selectedTags && Array.isArray(state.selectedTags)) {
            this.selectedTags = state.selectedTags;
        }
        // Re-apply the welcome centering/positioning once the DOM is rebuilt.
        this._scheduleCentering(true);
        // For chats (messages present), always scroll to the bottom so the latest
        // message is visible. Restoring the previous scrollTop is confusing when
        // new messages arrived while the tab was hidden.
        if (this.chatEl && this.messagesEl && this.messagesEl.children.length > 0) {
            this._scrollToBottom(true);
        }
    }

    async mount(container) {
        // Do not mount a full assistant instance for anonymous users unless it is
        // embedded in the modeler (which already shows its own login prompt).
        if (!this._embedded && !AuthManager.isLoggedIn()) {
            this._renderAnonymousPlaceholder(container);
            return;
        }
        await super.mount(container);
        // If the assistant was opened from the modeler split, make sure the linked
        // model is attached to the conversation context.
        if (this._embedded && (this.props.modelName || this.props.modelNames)) {
            const linkedNames = this._normalizeModelNames(this.props.modelNames ?? this.props.modelName);
            for (const name of linkedNames) {
                if (name && !this.modelNames.includes(name)) {
                    this.modelNames.push(name);
                    this.props.displayNames = this.props.displayNames || {};
                    this.props.displayNames[name] = this.props.displayNames[name] || name;
                }
            }
            this._syncModelUi();
        }
        // If this instance was created from the history panel or from a modeler
        // split with a session, load the persisted messages into the UI.
        if (this.props.session && (this.props.fromHistory || this.props.fromModeler)) {
            try {
                await this.loadHistory(this.props.session);
            } catch (err) {
                console.error('Assistant load history on mount error', err);
            }
            // Use the saved display name as the user-visible title if available.
            if (this.props.display_name && this.setTitle) {
                this.setTitle(`Analyser: ${this.props.display_name}`);
            }
        }
        // After loading history, if messages exist switch to chat mode layout.
        if (this.messagesEl && this.messagesEl.children.length > 0) {
            this.chatEl.classList.add('assistant-chat-mode');
            this.welcomeEl.classList.add('assistant-welcome-top');
            this.inputArea.classList.add('assistant-input-area-chat');
        }
        // Centering is deferred until the DOM is fully attached to the shell
        // and the browser has resolved all ancestor heights. _applyCentering is
        // called here instead of in render() because render() may run before the
        // container has its final size.
        this._scheduleCentering(true);
        this._scrollToBottom(true);
    }

    _scheduleCentering(skipTransition, delayMs = 0) {
        const run = () => {
            // Wait for web fonts to be rendered so title/subtitle heights are
            // stable before measuring, then wait two layout frames.
            const center = () => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this._applyCentering(skipTransition);
                    });
                });
            };
            if (document.fonts && typeof document.fonts.ready === 'object') {
                document.fonts.ready.then(center).catch(center);
            } else {
                center();
            }
        };
        if (delayMs > 0) {
            setTimeout(run, delayMs);
        } else {
            run();
        }
    }

    unmount() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        if (this._messagesObserver) {
            this._messagesObserver.disconnect();
            this._messagesObserver = null;
        }
        this.mounted = false;
        // Only abort an active SSE stream when the instance is actually closed,
        // not when the tab is simply hidden/cached.
        if (this._eventSource) {
            this._eventSource.close();
            this._eventSource = null;
        }
    }

    onTabDeactivated() {
        // The DOM is cached, not destroyed. Stop the resize observer and mark as
        // not visible, but keep the SSE connection / event buffer alive.
        this.mounted = false;
        this._visible = false;
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this._messagesObserver) {
            this._messagesObserver.disconnect();
            this._messagesObserver = null;
        }
    }

    onTabActivated() {
        this.mounted = true;
        this._visible = true;
        // The DOM was cached while the tab was hidden and events kept flowing,
        // so the chat is already up-to-date. Just make sure layout is correct.
        if (this.messagesEl && this.messagesEl.children.length > 0) {
            this.chatEl.classList.add('assistant-chat-mode');
            this.welcomeEl.classList.add('assistant-welcome-top');
            this.inputArea.classList.add('assistant-input-area-chat');
        }
        // If the user has logged in since the anonymous placeholder was cached,
        // replace it with the real assistant UI.
        if (AuthManager.isLoggedIn() && this.container?.querySelector('.assistant-anonymous-card')) {
            this.container.innerHTML = '';
            this.mount(this.container);
            return;
        }
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._observeResize();
        this._observeMessagesScroll();
        this._scheduleCentering(true);
        // If a chat is present, force-scroll to the bottom so the latest message
        // is visible after switching back to this tab. Retry several times because
        // CSS transitions and layout shifts can reset the scroll position.
        if (this.messagesEl && this.messagesEl.children.length > 0) {
            this._snapToBottom();
        }
    }

    _snapToBottom() {
        const scroll = () => {
            if (!this.chatEl || !this.messagesEl) return;
            // Scroll the last message into view; this is far more robust than
            // setting scrollTop while the container is still settling.
            const last = this.messagesEl.lastElementChild;
            if (last) {
                last.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
            } else {
                this.chatEl.scrollTop = this.chatEl.scrollHeight;
            }
        };
        scroll();
        requestAnimationFrame(scroll);
        requestAnimationFrame(() => requestAnimationFrame(scroll));
        setTimeout(scroll, 80);
        setTimeout(scroll, 200);
        setTimeout(scroll, 400);
        setTimeout(scroll, 800);
    }

    _observeMessagesScroll() {
        if (!this.messagesEl || typeof MutationObserver === 'undefined') return;
        if (this._messagesObserver) this._messagesObserver.disconnect();
        if (this._scrollListener) {
            this.chatEl?.removeEventListener('scroll', this._scrollListener);
            this._scrollListener = null;
        }

        // Auto-scroll to bottom is disabled during generation so the user can
        // freely scroll up to read earlier content. Explicit scroll calls (e.g.
        // sending a message or returning to the tab) still move the view when needed.
        this._stickToBottom = false;
    }

    _escape(text) {
        return this.ui.escape(text);
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

    _setSendEnabled(enabled) {
        if (!this.sendBtn) return;
        this.sendBtn.disabled = !enabled;
        this.sendBtn.classList.toggle('assistant-send-btn-disabled', !enabled);
    }

    resetToHome() {
        this.session = '';
        this.messages = [];
        this.isStreaming = false;
        this.selectedTags = [];
        this._linkedModelerInstanceId = '';
        this.props.session = '';
        this.props.fromHistory = false;
        this.props.display_name = '';
        this.props.modelName = '';
        this.props.modelNames = [];
        if (this.setTitle) this.setTitle(this.constructor.title);

        // Fully rebuild the DOM from scratch so every transient element (messages,
        // SVG cards, tool cards, plan cards, search results...) is discarded and
        // the welcome screen is shown exactly like on first mount.
        if (this.container) {
            // Force a fresh render by breaking the cached-live-DOM guard in render().
            const oldContainer = this.container;
            this.container = null;
            oldContainer.innerHTML = '';
            this.render(oldContainer);
            this._scheduleCentering(true);
            AppState.saveInstanceState?.(this.instanceId);
            return;
        }

        if (this.messagesEl) this.messagesEl.innerHTML = '';
        this._clearModelPills();
        if (this.chatEl) this.chatEl.classList.remove('assistant-chat-mode');
        if (this.welcomeEl) this.welcomeEl.classList.remove('assistant-welcome-top');
        if (this.inputArea) this.inputArea.classList.remove('assistant-input-area-chat');
        if (this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
        }
        this._scheduleCentering(true);
        AppState.saveInstanceState?.(this.instanceId);
    }

    _newSession() {
        this.resetToHome();
    }

    _switchToChatMode() {
        const hadFocus = document.activeElement === this.inputEl;
        // Snap the welcome/input to their final home positions without animating
        // so the transition starts from the exact same place the user sees.
        this.welcomeEl.style.transition = 'none';
        this.inputArea.style.transition = 'none';
        this._applyCentering(true);
        void this.welcomeEl.offsetHeight;
        void this.inputArea.offsetHeight;

        this.chatEl.classList.add('assistant-chat-mode');
        this.welcomeEl.classList.add('assistant-welcome-top');
        this.inputArea.classList.add('assistant-input-area-chat');

        // Re-enable CSS transitions, then compute the chat-mode positions so the
        // slide from home to chat is animated from the correct starting point.
        this.welcomeEl.style.transition = '';
        this.inputArea.style.transition = '';
        void this.welcomeEl.offsetHeight;
        void this.inputArea.offsetHeight;
        this._applyCentering(false);
        if (hadFocus) {
            // Keep focus while animating; re-focus after the slide settles.
            setTimeout(() => this.inputEl.focus(), 560);
        }
    }

    _enterChatModeInstantly() {
        if (!this.chatEl || !this.welcomeEl || !this.inputArea) return;
        // Disable transitions, switch classes, apply chat layout, then re-enable.
        this.welcomeEl.style.transition = 'none';
        this.inputArea.style.transition = 'none';
        this.chatEl.classList.add('assistant-chat-mode');
        this.welcomeEl.classList.add('assistant-welcome-top');
        this.inputArea.classList.add('assistant-input-area-chat');
        this._applyCentering(true);
        void this.welcomeEl.offsetHeight;
        void this.inputArea.offsetHeight;
        this.welcomeEl.style.transition = '';
        this.inputArea.style.transition = '';
    }

    _measureWelcomeContentHeight() {
        if (!this.welcomeEl) return 360;
        let height = 0;
        for (const child of this.welcomeEl.children) {
            const rect = child.getBoundingClientRect();
            const styles = getComputedStyle(child);
            const marginTop = parseFloat(styles.marginTop) || 0;
            const marginBottom = parseFloat(styles.marginBottom) || 0;
            height += rect.height + marginTop + marginBottom;
        }
        return Math.max(height, 360);
    }

    _applyCentering(skipTransition) {
        if (!this.welcomeEl || !this.container || !this.inputArea) return;

        const isEmbedded = this._embedded ||
            this.container.classList.contains('assistant-embedded') ||
            this.inputArea.classList.contains('assistant-embedded') ||
            this.container.closest('#modeler-assistant-panel') !== null;
        const welcomeTop = this.welcomeEl.classList.contains('assistant-welcome-top');
        const chatMode = this.chatEl?.classList.contains('assistant-chat-mode');

        if (isEmbedded) {
            // Embedded inside the modeler side panel: do not use fixed viewport
            // positioning. The input stays at the bottom of its flex container.
            this.welcomeEl.style.paddingTop = '';
            this.welcomeEl.style.paddingBottom = '';
            this.inputArea.style.setProperty('--assistant-input-top', 'auto');
            this.inputArea.style.position = 'absolute';
            this.inputArea.style.bottom = '0';
            this.inputArea.style.left = '0';
            this.inputArea.style.right = '0';
            this.inputArea.style.top = 'auto';
            this.inputArea.style.width = '100%';
            const inputHeight = this.inputArea.getBoundingClientRect().height;
            if (this.chatEl && inputHeight) {
                this.chatEl.style.paddingBottom = `${inputHeight + 8}px`;
            }
            return;
        }

        // Welcome padding and input top are both transitioned. Disable them
        // inline when snapping so measurements don't read mid-animation values.
        const welcomeWas = this.welcomeEl.style.transition;
        const inputWas = this.inputArea.style.transition;
        if (skipTransition) {
            this.welcomeEl.style.transition = 'none';
            this.inputArea.style.transition = 'none';
        }

        if (!welcomeTop) {
            // Reset any leftover chat scroll so the welcome is measured from the
            // top of the scroll area, not from a previously scrolled position.
            if (this.chatEl) this.chatEl.scrollTop = 0;

            const title = this.welcomeEl.querySelector('.assistant-welcome-title');
            const subtitle = this.welcomeEl.querySelector('.assistant-welcome-subtitle');
            const slot = this.welcomeInputSlot;
            const titleRect = title ? title.getBoundingClientRect() : { top: 0, height: 0 };
            const subtitleRect = subtitle ? subtitle.getBoundingClientRect() : { top: titleRect.bottom, height: 0 };
            const inputRect = this.inputArea.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            const titleHeight = titleRect.height;
            const subtitleHeight = subtitleRect.height;
            const subtitleMarginTop = parseFloat(getComputedStyle(subtitle).marginTop) || 0;
            const subtitleMarginBottom = parseFloat(getComputedStyle(subtitle).marginBottom) || 0;
            const inputHeight = inputRect.height;
            const inputMarginTop = parseFloat(getComputedStyle(slot).marginTop) || 0;
            const contentHeight = titleHeight + subtitleMarginTop + subtitleHeight + subtitleMarginBottom + inputMarginTop + inputHeight;
            // Center the title+subtitle+input block inside the visible app container.
            const containerHeight = containerRect.height;
            const available = containerHeight > 200 ? Math.max(containerHeight, contentHeight) : Math.max(window.visualViewport ? window.visualViewport.height : window.innerHeight, contentHeight);
            const offset = Math.max(0, (available - contentHeight) / 2);
            this.welcomeEl.style.paddingTop = `${offset}px`;
            this.welcomeEl.style.paddingBottom = '0';
            void this.welcomeEl.offsetHeight;

            // Position the fixed input exactly where the invisible slot sits
            // after the welcome padding has been applied.
            const slotRect = slot ? slot.getBoundingClientRect() : { top: 0 };
            this.inputArea.style.setProperty('--assistant-input-top', `${slotRect.top}px`);
        } else if (chatMode) {
            // In chat mode the title is sticky at the top and the input sits at
            // the bottom of the visible window, preserving its bottom padding.
            this.welcomeEl.style.paddingTop = '';
            this.welcomeEl.style.paddingBottom = '';
            const inputHeight = this.inputArea.getBoundingClientRect().height;
            const bottomPadding = 0.35 * parseFloat(getComputedStyle(document.documentElement).fontSize || 16);
            const topY = window.innerHeight - inputHeight - bottomPadding;
            this.inputArea.style.setProperty('--assistant-input-top', `${topY}px`);
            if (this.chatEl) {
                this.chatEl.style.paddingBottom = `${(inputHeight / 2) + bottomPadding}px`;
            }
        } else {
            // Fallback: clear explicit padding if neither state is fully active.
            this.welcomeEl.style.paddingTop = '';
            this.welcomeEl.style.paddingBottom = '';
        }

        if (skipTransition) {
            void this.welcomeEl.offsetHeight;
            void this.inputArea.offsetHeight;
            this.welcomeEl.style.transition = welcomeWas;
            this.inputArea.style.transition = inputWas;
            void this.welcomeEl.offsetHeight;
            void this.inputArea.offsetHeight;
        }
    }

    _observeResize() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (!this.container || typeof ResizeObserver === 'undefined') return;
        this._resizeObserver = new ResizeObserver(() => {
            // Recalculate the input position in both welcome and chat modes so
            // the fixed input area stays correctly placed after a resize.
            this._scheduleCentering(true);
        });
        this._resizeObserver.observe(this.container);
    }

    _normalizeModelNames(value) {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (typeof value === 'string' && value.trim()) return [value.trim()];
        return [];
    }

    _displayNameForModel(name) {
        const raw = this.props.displayNames?.[name] || name;
        return this.ui.displayNameFromStored(raw);
    }

    _displayNameForSearchModel(filename) {
        return this.ui.displayNameFromStored(filename);
    }

    _updateImportButtonState(importBtn) {
        if (!importBtn || this._embedded) return;
        const atMax = ((this.modelNames?.length || 0) + (this._loadingModels?.length || 0)) >= this.modelNamesConfig.max;
        importBtn.disabled = atMax;
        importBtn.style.opacity = atMax ? '0.4' : '';
        importBtn.title = atMax
            ? `Limite de ${this.modelNamesConfig.max} modèles atteinte`
            : 'Importer un modèle (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML)';
    }

    /**
     * Keep the + buttons inside search result cards in sync with the current
     * model capacity. Disabled/hidden when the limit is reached or in embedded mode.
     */
    _updateSearchResultAddButtons() {
        if (!this.messagesEl) return;
        const total = (this.modelNames?.length || 0) + (this._loadingModels?.length || 0);
        const atMax = total >= this.modelNamesConfig.max;
        this.messagesEl.querySelectorAll('[data-action="add-to-assistant"]').forEach((btn) => {
            const docId = btn.dataset.docId;
            const alreadyAdded = this._importedSearchDocIds.has(docId);
            // A button importing from a search card is clickable either when there
            // is room or when it is already selected (cross). In the latter case,
            // clicking removes the imported model from the assistant context.
            const disabled = (!alreadyAdded && atMax) || this._embedded;
            btn.disabled = disabled;
            btn.style.opacity = disabled ? '0.4' : '';
            btn.style.display = this._embedded ? 'none' : '';
            btn.classList.toggle('search-add-model-selected', alreadyAdded && !this._embedded);
        });
    }

    async _importModel(file) {
        if (!this._requireAuth()) return;
        if (!file || (this.modelNames?.length || 0) >= this.modelNamesConfig.max) return;
        const loadingKey = `loading_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const displayName = file.name;
        this._startImportLoading(loadingKey, displayName);
        try {
            const result = await ApiClient.importAssistantModel(file, file.name, this.origin);
            if (result?.name) {
                this.props.displayNames = this.props.displayNames || {};
                this.props.displayNames[result.name] = result.display_name || result.name;
                this._finishImportLoading(loadingKey, result.name);
            } else {
                throw new Error('Import terminé sans retour de modèle.');
            }
        } catch (err) {
            console.error('Assistant import model error', err);
            this._failImportLoading(loadingKey, `Erreur lors de l'import de ${displayName} : ${err.message}`);
        }
    }

    /**
     * Import a document returned by a search result card directly into the
     * current assistant conversation. Reuses the existing import loading pill
     * machinery. Does nothing if the 3-model limit is reached.
     */
    async _importSearchResultIntoAssistant(docId, filename) {
        if (!this._requireAuth()) return;
        if (!docId || !filename || this._embedded) return;
        const total = (this.modelNames?.length || 0) + (this._loadingModels?.length || 0);
        if (total >= this.modelNamesConfig.max) return;
        if (this._importedSearchDocIds.has(docId)) return;
        if (this.modelNames?.includes?.(docId) || this._loadingModels?.some?.((m) => m.displayName === filename)) return;

        const loadingKey = `search_card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this._importedSearchDocIds.set(docId, '');
        this._startImportLoading(loadingKey, filename);
        try {
            const result = await ApiClient.importDocumentAsAssistantModel(docId, this.origin);
            if (result?.name) {
                this.props.displayNames = this.props.displayNames || {};
                this.props.displayNames[result.name] = result.display_name || filename;
                this._importedSearchDocIds.set(docId, result.name);
                this._finishImportLoading(loadingKey, result.name);
            } else {
                throw new Error('Import terminé sans retour de modèle.');
            }
        } catch (err) {
            this._importedSearchDocIds.delete(docId);
            console.error('Assistant import search result error', err);
            this._failImportLoading(loadingKey, `Erreur lors de l'import de ${filename} : ${err.message}`);
        }
    }

    /**
     * Start loading state for a model that is being imported.
     * This shows a pill immediately and disables further imports until resolved.
     */
    _startImportLoading(name, displayName) {
        if (!this._loadingModels) this._loadingModels = [];
        this._loadingModels.push({ name, displayName, loading: true });
        this._syncModelUi();
    }

    /**
     * Replace a loading placeholder with the imported model name.
     */
    _finishImportLoading(loadingName, importedName) {
        if (!this._loadingModels) return;
        this._loadingModels = this._loadingModels.filter((m) => m.name !== loadingName);
        const names = this.modelNames.slice();
        if (!names.includes(importedName)) names.push(importedName);
        this.modelNames = names.slice(0, this.modelNamesConfig.max);
        this._syncModelUi();
    }

    /**
     * Remove a failed loading placeholder and notify the user.
     */
    _failImportLoading(loadingName, message) {
        if (!this._loadingModels) return;
        this._loadingModels = this._loadingModels.filter((m) => m.name !== loadingName);
        this._syncModelUi();
        this._appendSystemMessage(this._escape(message));
    }

    _updateModelPill() {
        if (!this.modelPillSlotEl) return;
        const showClose = !this._embedded;
        const realModels = (this.modelNames || []).map((name) => ({
            name,
            displayName: this._displayNameForModel(name),
            loading: false,
        }));
        const allModels = [...realModels, ...(this._loadingModels || [])];
        if (!allModels.length) {
            this.modelPillSlotEl.innerHTML = '';
            return;
        }
        this.modelPillSlotEl.innerHTML = allModels.map((model) => {
            const displayName = model.loading ? this._displayNameForSearchModel(model.displayName) : this._displayNameForModel(model.name);
            const loadingSpinner = model.loading ? `
                <span class="assistant-pill-spinner w-3.5 h-3.5 inline-flex items-center justify-center flex-shrink-0" aria-hidden="true">
                    <svg class="animate-spin w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                    </svg>
                </span>` : `
                ${!this._embedded ? `<button type="button" class="assistant-model-pill-preview w-5 h-5 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-500 hover:text-gray-800 transition-colors" title="Prévisualiser le modèle">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                    </svg>
                </button>` : ''}`;
            return `
            <div class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-gray-100 border border-gray-200 text-xs font-semibold text-gray-700 assistant-model-pill ${model.loading ? 'assistant-model-pill-loading' : ''}" data-model-name="${this._escape(model.name)}">
                ${loadingSpinner}
                <span class="truncate max-w-[10rem]" title="${this._escape(displayName)}">${this._escape(displayName)}</span>
                ${model.loading ? '' : `
                <div class="relative">
                    <button type="button" class="assistant-model-pill-export w-5 h-5 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-500 hover:text-gray-800 transition-colors" title="Exporter le modèle">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <path d="M7 10l5 5 5-5"></path>
                            <path d="M12 15V3"></path>
                        </svg>
                    </button>
                    <div class="assistant-model-pill-export-menu hidden absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-36 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-xs z-50">
                        <button type="button" data-format="xmi" class="assistant-pill-export-item w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700 flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            Exporter en XMI
                        </button>
                        <button type="button" data-format="ttl" class="assistant-pill-export-item w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700 flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            Exporter en TTL
                        </button>
                        <button type="button" data-format="svg" class="assistant-pill-export-item w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700 flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                <polyline points="21 15 16 10 5 21"></polyline>
                            </svg>
                            Exporter en SVG
                        </button>
                        <button type="button" data-format="png" class="assistant-pill-export-item w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-700 flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                <polyline points="21 15 16 10 5 21"></polyline>
                            </svg>
                            Exporter en PNG
                        </button>
                    </div>
                </div>
                ${showClose ? `<button type="button" class="assistant-model-pill-close w-5 h-5 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-500 hover:text-gray-800 transition-colors" title="Détacher le modèle">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                        <path d="M18 6L6 18M6 6l12 12"></path>
                    </svg>
                </button>` : ''}`}
            </div>
            `;
        }).join('');

        this.modelPillSlotEl.querySelectorAll('.assistant-model-pill').forEach((pill) => {
            const name = pill.dataset.modelName;
            const closeBtn = pill.querySelector('.assistant-model-pill-close');
            const previewBtn = pill.querySelector('.assistant-model-pill-preview');
            const exportBtn = pill.querySelector('.assistant-model-pill-export');
            const exportMenu = pill.querySelector('.assistant-model-pill-export-menu');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this._removeModelPill(name));
            }
            if (previewBtn) {
                previewBtn.addEventListener('click', () => {
                    const displayName = this.props.displayNames?.[name] || name;
                    EventBus.emit('open-preview-model', { modelName: name, name: displayName });
                });
            }
            if (exportBtn && exportMenu) {
                exportBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isOpen = !exportMenu.classList.contains('hidden');
                    this._closePillExportMenus();
                    if (!isOpen) exportMenu.classList.remove('hidden');
                });
                exportMenu.querySelectorAll('.assistant-pill-export-item').forEach((item) => {
                    item.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this._exportModelFromPill(item.dataset.format, name, item);
                        this._closePillExportMenus();
                    });
                });
            }
        });

        this._pillExportCloseHandler = (e) => {
            const menus = this.modelPillSlotEl?.querySelectorAll('.assistant-model-pill-export-menu');
            let inside = false;
            menus?.forEach((menu) => {
                const pill = menu.closest('.assistant-model-pill');
                const exportBtn = pill?.querySelector('.assistant-model-pill-export');
                if (menu.contains(e.target) || exportBtn === e.target || exportBtn?.contains(e.target)) inside = true;
            });
            if (!inside) this._closePillExportMenus();
        };
        setTimeout(() => document.addEventListener('click', this._pillExportCloseHandler), 0);
    }

    _closePillExportMenus() {
        this.modelPillSlotEl?.querySelectorAll('.assistant-model-pill-export-menu').forEach((m) => m.classList.add('hidden'));
    }

    async _removeModelPill(name) {
        this.modelNames = (this.modelNames || []).filter((n) => n !== name);
        this._loadingModels = (this._loadingModels || []).filter((m) => m.name !== name);
        if (this.props.displayNames) delete this.props.displayNames[name];
        // If this model was imported from a search result card, clear the docId
        // mapping so the card's + button becomes clickable again.
        for (const [docId, modelName] of this._importedSearchDocIds.entries()) {
            if (modelName === name) {
                this._importedSearchDocIds.delete(docId);
                break;
            }
        }
        // Delete the uploaded model from the server if it has not yet been sent
        // in a message (orphan import). This avoids leaving stale model files in
        // the MCP server storage when the user removes the pill before chatting.
        if (name) {
            try {
                const res = await fetch(`api/models/${encodeURIComponent(name)}`, {
                    method: "DELETE",
                    credentials: "same-origin",
                });
                if (!res.ok) {
                    console.error("Failed to delete orphan imported model", name, res.status);
                }
            } catch (err) {
                console.error("Delete orphan imported model error", name, err);
            }
        }
        this._syncModelUi();
    }

    _clearModelPills() {
        if (this._pillExportCloseHandler) {
            document.removeEventListener('click', this._pillExportCloseHandler);
            this._pillExportCloseHandler = null;
        }
        this.modelNames = [];
        this._loadingModels = [];
        this._importedSearchDocIds.clear();
        this.props.displayNames = {};
        if (this.modelPillSlotEl) this.modelPillSlotEl.innerHTML = '';
        this._syncModelUi();
    }

    async _exportModelFromPill(format, name, itemEl) {
        if (!name) return;
        const originalHtml = itemEl?.innerHTML || '';
        this._setPillExportItemLoading(itemEl, true);
        try {
            const blob = await ApiClient.exportModel(name, format);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this._displayNameForModel(name) || 'modele'}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Export model from pill error', err);
            this._appendSystemMessage(`Erreur lors de l'export du modèle : ${this._escape(err.message)}`);
        } finally {
            this._setPillExportItemLoading(itemEl, false, originalHtml);
        }
    }

    _setPillExportItemLoading(itemEl, isLoading, originalHtml = '') {
        if (!itemEl) return;
        if (isLoading) {
            itemEl.disabled = true;
            itemEl.dataset.originalHtml = itemEl.innerHTML || '';
            itemEl.innerHTML = `
                <span class="inline-flex items-center gap-1.5">
                    <svg class="animate-spin w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Export...</span>
                </span>`;
        } else {
            itemEl.disabled = false;
            itemEl.innerHTML = originalHtml || itemEl.dataset.originalHtml || 'Exporter';
            delete itemEl.dataset.originalHtml;
        }
    }

    _buildTagsHtml(tags) {
        if (!tags || !tags.length) return '';
        return tags.map((t) => {
            const tagName = (typeof t === 'object' ? t.tag : t) || '';
            const isChecked = this.selectedTags.includes(tagName) ? 'checked' : '';
            return `
                <label class="cursor-pointer select-none assistant-tag-label" title="${this._escape(tagName)}">
                    <input type="checkbox" name="assistant-tag" value="${this._escape(tagName)}" class="peer hidden" ${isChecked}>
                    <span class="inline-flex items-center rounded-full font-bold border-2 border-gray-200 text-gray-700 peer-checked:bg-black peer-checked:text-white peer-checked:border-black hover:border-gray-400 transition-colors overflow-hidden relative px-2.5 py-1 text-xs">
                        <svg class="icon-unchecked w-3.5 h-3.5 mr-1.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                        <svg class="icon-checked w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                        ${this._escape(tagName)}
                    </span>
                </label>
            `;
        }).join('');
    }

    async _loadTags() {
        if (this._tagsReady) return;
        try {
            const data = await ApiClient.getTags();
            const tags = data.tags || [];
            this.tagsHtml = this._buildTagsHtml(tags);
            this._tagsReady = true;
        } catch (e) {
            console.error('Erreur chargement tags assistant', e);
            this.tagsHtml = '';
            this._tagsReady = true;
        }
    }

    _updateSourcesLabel() {
        if (!this.sourcesLabel) return;
        const count = this.selectedTags.length;
        this.sourcesLabel.textContent = count > 0 ? `Sources (${count})` : 'Sources';
    }

    _toggleSourcesMenu() {
        if (!this.sourcesMenu) return;
        const isOpen = !this.sourcesMenu.classList.contains('hidden');
        if (isOpen) {
            this.sourcesMenu.classList.add('hidden');
            return;
        }
        this._showSourcesMenu();
    }

    async _showSourcesMenu() {
        await this._loadTags();
        if (!this.sourcesMenu || !this.sourcesBtn) return;
        // Rebuild tag HTML with the current selection so checked state persists
        // across menu open/close cycles.
        const data = { tags: [] };
        const temp = document.createElement('div');
        temp.innerHTML = this.tagsHtml;
        const labels = Array.from(temp.querySelectorAll('label'));
        const tags = labels.map((label) => {
            const input = label.querySelector('input');
            return input ? input.value : '';
        }).filter(Boolean);
        this.tagsHtml = this._buildTagsHtml(tags);

        this.sourcesMenu.innerHTML = `
            <div class="assistant-sources-header">Sources</div>
            <div class="assistant-sources-list">
                ${this.tagsHtml || '<span class="text-gray-500 text-sm px-2">Aucune source disponible.</span>'}
            </div>
        `;
        this.sourcesMenu.classList.remove('hidden');
        this._updateSourcesLabel();

        this.sourcesMenu.addEventListener('change', (e) => {
            if (e.target.name === 'assistant-tag') {
                this.selectedTags = Array.from(this.sourcesMenu.querySelectorAll('input[name="assistant-tag"]:checked')).map((cb) => cb.value);
                this._updateSourcesLabel();
            }
        });

        const closeOnClickOutside = (e) => {
            if (!this.sourcesMenu.contains(e.target) && e.target !== this.sourcesBtn && !this.sourcesBtn.contains(e.target)) {
                this.sourcesMenu.classList.add('hidden');
                document.removeEventListener('mousedown', closeOnClickOutside);
                document.removeEventListener('touchstart', closeOnClickOutside);
            }
        };
        // Delay so the click that opened the menu does not close it immediately.
        setTimeout(() => {
            document.addEventListener('mousedown', closeOnClickOutside);
            document.addEventListener('touchstart', closeOnClickOutside);
        }, 50);
    }

    _appendSystemMessage(text) {
        if (!this.messagesEl) return;
        const div = document.createElement('div');
        div.className = 'assistant-bubble assistant-bubble-assistant mb-6';
        div.innerHTML = `
            <div class="assistant-bubble-content markdown-body">${this._markdown(text)}</div>
        `;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
    }

    async loadHistory(session) {
        console.log('[AssistantApp] loadHistory', session, this.origin);

        // Show the chat layout immediately with a loading placeholder while the
        // history is fetched. This avoids any welcome-screen flicker and gives
        // feedback when loading takes time.
        this._enterChatModeInstantly();
        this._removeThinkingPlaceholder();
        const loadingPlaceholder = this._appendThinkingPlaceholder('Chargement de la conversation...');

        const data = await ApiClient.getAssistantHistory(session, this.origin);
        console.log('[AssistantApp] history data', data);

        this._removeThinkingPlaceholder();

        if (!data || !Array.isArray(data.messages)) {
            console.warn('[AssistantApp] no messages in history data');
            this._appendSystemMessage('Impossible de charger cette conversation.');
            return;
        }
        const displayEventCount = Array.isArray(data.display_events) ? data.display_events.length : 0;
        console.log('[AssistantApp] display_events count', displayEventCount);
        if (displayEventCount === 0) {
            console.warn('[AssistantApp] no display_events: conversation was saved before card replay support. Start a new conversation after restarting the server.');
        }

        this.session = session;
        const loadedNames = this._normalizeModelNames(data.model_names ?? data.model_name);
        if (loadedNames.length) this.modelNames = loadedNames;
        // Persist the display name on the instance props so tab title survives
        // across remounts and renames from the history panel.
        if (data.display_name) {
            this.props.display_name = data.display_name;
            if (this.setTitle) this.setTitle(`Analyser: ${data.display_name}`);
        }
        this.messages = [];
        this.messagesEl.innerHTML = '';
        this.activeSvgCard = null;
        this.activeSvgViewer = null;

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
            if (kind === 'assistant_message') {
                // Full assistant message persisted as a single event (used for
                // intermediate explanations produced between tool calls).
                closeReplayBubble();
                this._hideAllSparkles();
                this._removeThinkingPlaceholder();
                const bubble = ensureReplayBubble();
                bubble.innerHTML = this._markdown(event.content || '', false);
                closeReplayBubble();
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
                    const display = event.display || {};
                    const results = display.results || [];
                    const resultsHtml = this.ui.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
                    this._fillSearchCard(display.query || '', resultsHtml);
                } else {
                    this._fillToolResult(event.name, event.result, event.display);
                }
                lastRole = 'tool';
                return;
            }
            if (kind === 'model_svg') {
                const rawName = event.model_name || event.label || '';
                const label = rawName
                    ? this._displayNameForModel(rawName)
                    : 'Visualisation du modèle';
                this._updateCurrentSvgCard(event.svg, label);
                return;
            }
            if (kind === 'model_attached') {
                const attachedName = event.model_name;
                if (attachedName && !this.modelNames.includes(attachedName)) {
                    this.modelNames.push(attachedName);
                    this.props.displayNames = this.props.displayNames || {};
                    this.props.displayNames[attachedName] = attachedName;
                    this._syncModelUi();
                }
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

        // Add a sparkle avatar under the last assistant message so the replayed
        // conversation visually matches the live streaming state.
        const lastAssistant = this.messagesEl.lastElementChild;
        if (lastAssistant && lastAssistant.dataset.role === 'assistant') {
            if (!lastAssistant.querySelector('.ai-avatar-row')) {
                lastAssistant.innerHTML += `
                    <div class="ai-avatar-row flex items-center gap-2">
                        <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                            ${this._sparkleSvg()}
                        </div>
                    </div>
                `;
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
        // Scroll the user message into view (like the floating chat), then re-enable
        // auto-stick so the streaming answer continues to scroll the chat down.
        if (this.chatEl) {
            this._stickToBottom = false;
            requestAnimationFrame(() => {
                div.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Re-enable stick-to-bottom once the smooth scroll finishes, so the
                // assistant response keeps pulling the view down.
                setTimeout(() => { this._stickToBottom = true; }, 350);
            });
        }
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

    _adjustChatPadding() {
        // Keep enough bottom padding on the chat so the last message never slips
        // behind the floating input area. This is especially important when the
        // final markdown reparse suddenly grows the last bubble.
        if (!this.chatEl || !this.inputArea) return;
        const inputHeight = this.inputArea.getBoundingClientRect().height;
        const extra = 0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize || 16);
        this.chatEl.style.paddingBottom = `${inputHeight + extra}px`;
    }

    _resetChatPadding() {
        if (!this.chatEl) return;
        // Do not strip the padding immediately when streaming ends; the final
        // parsed block may be taller than the streamed placeholder and would be
        // hidden by the input area. The padding is reapplied by _applyCentering
        // when the user switches away/back or on the next resize.
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
        const last = this.messagesEl.lastElementChild;
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
        if (this._embedded) return null;
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
        this.messagesEl.appendChild(div);
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
        if (this._embedded) return null;
        if (display && display.type === 'search') {
            const results = display.results || [];
            const resultsHtml = this.ui.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
            this._fillSearchCard(display.query || '', resultsHtml);
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

        const cards = this.messagesEl.querySelectorAll('[data-tool-name]');
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
        let notes = parsed.notes || '';

        if (!Array.isArray(planSteps) || planSteps.length === 0) {
            return null;
        }

        // Replace timestamped model names with their display names. We first find
        // candidates with a cheap regex, then only replace if the full match is a
        // known stored model name. This avoids false positives and stays efficient.
        const knownNames = new Set([
            ...(this.modelNames || []),
            ...Object.keys(this.props.displayNames || {}),
        ]);

        const displayForName = (storedName) => {
            if (!storedName) return '';
            return this.props.displayNames?.[storedName]
                || this._displayNameForModel(storedName);
        };

        const TIMESTAMP_SUFFIX_RE = /[A-Za-z0-9_.\-]+__\d{16,20}\b/g;

        const cleanModelName = (text) => {
            if (typeof text !== 'string') return text;
            return text.replace(TIMESTAMP_SUFFIX_RE, (match) => {
                return knownNames.has(match) ? displayForName(match) : match;
            });
        };

        const cleanStep = (step) => {
            if (typeof step === 'string') return cleanModelName(step);
            if (step && typeof step === 'object') {
                return {
                    ...step,
                    step: cleanModelName(step.step || ''),
                    notes: cleanModelName(step.notes || ''),
                };
            }
            return step;
        };

        notes = cleanModelName(notes);

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

        planSteps.forEach((rawStep, index) => {
            const step = cleanStep(rawStep);
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
                    <span>Analyse en cours</span>
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
            this._updateSearchResultAddButtons();
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
        this._updateSearchResultAddButtons();
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
        if (this._embedded) return null;
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
        if (this._embedded) return;
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
            retrieve_documents: 'Recherche de contexte...',
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

    _scrollToBottom(force = false) {
        const el = this.chatEl;
        if (!el) return;
        if (force || this._stickToBottom) {
            el.scrollTo({ top: el.scrollHeight, behavior: force ? 'auto' : 'smooth' });
        }
    }

    _isNearBottom() {
        return !!this._stickToBottom;
    }

    async _send(text) {
        if (!this._requireAuth()) return;
        // For a brand-new conversation we intentionally pass an empty session.
        // The backend will generate a unique slug + timestamp and return it in
        // the first `user` event, exactly like the modeler does for imports.
        const sessionToSend = this.session || '';

        this.messages.push({ role: 'user', content: text });
        this._appendUserMessage(text);
        this.isStreaming = true;
        this._setSendEnabled(false);
        // Reset the background event queue for each new turn.
        this._pendingEvents = [];
        this._lastRenderedEventIndex = -1;
        // Start with a clean thinking placeholder. Hide stale sparkles first,
        // because a new user message begins a new assistant turn.
        this._hideAllSparkles();

        let placeholder = this._appendThinkingPlaceholder('Réflexion...');
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

        // ChatApp-style streaming: accumulate the full response, then display it
        // character-by-character with live markdown reparsing.
        let fullResponse = '';
        let displayedText = '';
        let streamBuffer = '';
        let currentBubbleContent = null;
        let typewriterInterval = null;

        const startTypewriter = () => {
            if (typewriterInterval) return;
            typewriterInterval = setInterval(() => {
                if (streamBuffer.length === 0) return;
                const chunkSize = Math.min(3 + Math.floor(Math.random() * 8), streamBuffer.length);
                displayedText += streamBuffer.slice(0, chunkSize);
                streamBuffer = streamBuffer.slice(chunkSize);
                if (currentBubbleContent) {
                    currentBubbleContent.innerHTML = this._markdown(displayedText, false);
                }
                this._adjustChatPadding();
            }, 10);
        };

        const stopTypewriter = () => {
            if (typewriterInterval) {
                clearInterval(typewriterInterval);
                typewriterInterval = null;
            }
        };

        const flushTypewriter = () => {
            stopTypewriter();
            if (streamBuffer.length > 0) {
                displayedText += streamBuffer;
                streamBuffer = '';
            }
            if (currentBubbleContent) {
                currentBubbleContent.innerHTML = this._markdown(displayedText, false);
            }
            // The final parse can make the bubble much taller. Apply the safety
            // padding so the new content is never hidden behind the input area.
            this._adjustChatPadding();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._adjustChatPadding();
                });
            });
        };

        const resetTypewriter = () => {
            stopTypewriter();
            displayedText = '';
            streamBuffer = '';
            currentBubbleContent = null;
        };

        const appendToStreamBuffer = (text) => {
            streamBuffer += text;
        };

        const ensureAssistantTextBubble = () => {
            if (currentBubbleContent) return currentBubbleContent;
            this._removeThinkingPlaceholder();
            this._closeAssistantBubble();
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
            currentBubbleContent = wrapper.querySelector('.assistant-bubble-content');
            return currentBubbleContent;
        };

        // Abort controller lets the client survive long waits and prevents duplicate streams.
        this._streamAbortController?.abort();
        this._streamAbortController = new AbortController();

        const saveHtmlSnapshot = () => {
            if (this.messagesEl) {
                this.messagesHtml = this.messagesEl.innerHTML;
            }
        };

        const liveHandler = async (event) => {
            // The DOM may be cached/visible. If messagesEl exists (it does when
            // cached because we keep the container), process live. Otherwise queue.
            if (!this.messagesEl) {
                this._pendingEvents.push(event);
                return;
            }

            // Always process the current event live. If there are also queued events
            // from the background, replay them first so the timeline order is preserved.
            const eventsToReplay = this._pendingEvents.slice(this._lastRenderedEventIndex + 1);
            this._lastRenderedEventIndex = this._pendingEvents.length - 1;
            for (const ev of eventsToReplay) {
                this._processEvent(ev, { startTypewriter, stopTypewriter, flushTypewriter, resetTypewriter, ensureAssistantTextBubble, appendToStreamBuffer, saveHtmlSnapshot, placeholderRef: { value: placeholder } });
            }

            this._processEvent(event, { startTypewriter, stopTypewriter, flushTypewriter, resetTypewriter, ensureAssistantTextBubble, appendToStreamBuffer, saveHtmlSnapshot, placeholderRef: { value: placeholder } });
        };

        try {
            await ApiClient.streamAssistant(
                sessionToSend,
                text,
                this.modelNames,
                this.selectedTags || [],
                liveHandler,
                { origin: this.origin }
            );
        } catch (err) {
            console.error('Assistant stream error', err);
            this._appendThinkingPlaceholder(); // ensures any previous one is removed first
            const bubble = this._ensureAssistantBubble();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(err.message)}</em>`;
        } finally {
            clearInterval(loadingInterval);
            stopTypewriter();
            flushTypewriter();
            this.isStreaming = false;
            this._setSendEnabled(true);
            this._closeAssistantBubble();
            // Keep the padding safety in place; _applyCentering will refresh it on
            // tab switches / resize instead of clearing it here.

            if (displayedText) {
                this.messages.push({ role: 'assistant', content: displayedText });
            }

            this._removeThinkingPlaceholder();
            this._updateFinalSparkle();
            saveHtmlSnapshot();
            clearTimeout(this._streamAliveTimeout);
            this._streamAliveTimeout = null;
        }
    }

    _updateFinalSparkle() {
        const lastAssistant = this.messagesEl.lastElementChild;
        if (lastAssistant && lastAssistant.dataset.role === 'assistant') {
            if (!lastAssistant.querySelector('.ai-avatar-row')) {
                lastAssistant.innerHTML += `
                    <div class="ai-avatar-row flex items-center gap-2">
                        <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                            ${this._sparkleSvg()}
                        </div>
                    </div>
                `;
            }
        }
    }

    _processEvent(event, { startTypewriter, stopTypewriter, flushTypewriter, resetTypewriter, ensureAssistantTextBubble, appendToStreamBuffer, saveHtmlSnapshot, placeholderRef }) {
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
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'thinking') {
            // Each thinking event starts a new reasoning step. The helper
            // removes any previous placeholder first, so stale sparkles from
            // earlier phases do not linger on screen.
            this._removeThinkingPlaceholder();
            placeholderRef.value = this._appendThinkingPlaceholder('Réflexion...');
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_text') {
            if (appendToStreamBuffer) {
                // ChatApp-style live typewriter: append to the buffer and let the
                // interval display characters one-by-one with live markdown parsing.
                appendToStreamBuffer(event.content || '');
                ensureAssistantTextBubble();
                startTypewriter();
            } else {
                // Fallback during background replay (no live typewriter available).
                const bubble = this._ensureAssistantBubble();
                this._currentStreamingText = (this._currentStreamingText || '') + (event.content || '');
                bubble.innerHTML = this._markdown(this._currentStreamingText, false);
                this._throttledReflow();
                this._throttledScrollToBottom();
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_tool_calls') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            // Hide the verbose tool-call list; only progress cards (and the
            // plan card) give the user feedback now.
            this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'tool_start') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            // Hide the sparkle on any previous assistant bubble as soon as a new
            // tool starts, so it does not stay under an intermediate message.
            this._hideAllSparkles();
            // Render the tool card/search card BEFORE the placeholder so the
            // sparkle/"Réflexion" label stays at the bottom of the current step.
            if (event.name === 'retrieve_documents') {
                this._appendSearchCard(event.arguments?.search_terms || '', null);
            } else if (event.name === 'display_model_visualization') {
                // SVG cards are created/updated by the model_svg event, no extra card here.
                // In embedded mode the visualization lives in the modeler canvas.
            }
            // Tool cards (JSON dumps) are intentionally hidden for all tools,
            // including unknown ones. Only progress cards, plan card, search
            // results and SVG visualizations remain visible.
            // Show a transient status label while the tool runs. The helper
            // removes any previous placeholder first.
            placeholderRef.value = this._appendThinkingPlaceholder(this._toolStatusLabel(event.name));
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_start') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            this._hideAllSparkles();
            this._appendProgressCard(event.card_id, event.tool_name);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_update') {
            this._updateProgressCard(event.card_id, event.percent, event.message);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'progress_done') {
            this._completeProgressCard(event.card_id);
            this._removeProgressStatus(event.card_id);
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'tool_result') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            if (event.name === 'plan_workflow_with_tools') {
                this._renderPlan(event.result);
            } else if (event.name === 'retrieve_documents') {
                const display = event.display || {};
                const results = display.results || [];
                const resultsHtml = this.ui.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
                this._fillSearchCard(display.query || '', resultsHtml);
            } else {
                this._fillToolResult(event.name, event.result, event.display);
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'loop_done') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'model_svg') {
            // In standalone assistant mode, update the active SVG card inside the chat.
            // When the assistant is embedded next to the modeler, the visualization
            // lives in the modeler's main canvas instead.
            const linked = this._linkedModelerInstanceId || this.props.linkedModelerInstanceId;
            if (linked && this.modelNames?.length) {
                const modeler = AppState.getInstance(linked);
                if (modeler && typeof modeler._reloadSvgFromServer === 'function') {
                    modeler._reloadSvgFromServer();
                }
            } else if (!this._embedded) {
                const rawName = event.model_name || event.label || '';
                const label = rawName
                    ? this._displayNameForModel(rawName)
                    : 'Visualisation du modèle';
                this._updateCurrentSvgCard(event.svg, label);
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'model_attached') {
            const attachedName = event.model_name;
            if (attachedName && !this.modelNames.includes(attachedName)) {
                this.modelNames.push(attachedName);
                this.props.displayNames = this.props.displayNames || {};
                this.props.displayNames[attachedName] = attachedName;
                this._syncModelUi();
            }
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'assistant_done') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            // Remove any lingering thinking placeholder before rendering the final answer.
            this._removeThinkingPlaceholder();
            saveHtmlSnapshot();
            return;
        }

        if (event.kind === 'error') {
            stopTypewriter?.();
            flushTypewriter?.();
            resetTypewriter?.();
            this._closeAssistantBubble();
            const bubble = this._ensureAssistantBubble();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(event.message || '')}</em>`;
            saveHtmlSnapshot();
            return;
        }
    }

    _createTypewriter(onChunk, options = {}) {
        // Character-by-character typewriter effect, matching the floating chat
        // window. The chunk size varies slightly for a natural feel.
        const charInterval = options.charInterval || 20;

        let buffer = '';
        let timerId = null;
        let running = false;

        const emitNext = () => {
            if (buffer === '') return;
            // Emit 1 to 4 characters per tick with a small random variation.
            const chunkSize = Math.min(1 + Math.floor(Math.random() * 4), buffer.length);
            const chunk = buffer.slice(0, chunkSize);
            buffer = buffer.slice(chunkSize);
            if (chunk) onChunk(chunk);
            return chunkSize;
        };

        const schedule = () => {
            if (running || timerId) return;
            running = true;
            timerId = setTimeout(() => {
                timerId = null;
                running = false;
                if (buffer !== '') {
                    emitNext();
                    if (buffer !== '') schedule();
                }
            }, charInterval);
        };

        return {
            append: (text) => {
                buffer += text;
                schedule();
            },
            flush: () => {
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                running = false;
                while (buffer !== '') {
                    emitNext();
                }
            },
            stop: () => {
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                running = false;
                buffer = '';
            },
        };
    }

    unmount() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        // Keep container reference so the live DOM can keep receiving stream updates
        // while the tab is hidden.
        this.mounted = false;
    }

    _renderLoginBanner() {
        const container = this.container;
        if (!container) return;
        let banner = container.querySelector('#assistant-login-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'assistant-login-banner';
            banner.className = 'login-banner absolute top-3 left-3 right-3 z-40';
            container.insertBefore(banner, container.firstChild);
        }
        if (AuthManager.isLoggedIn()) {
            banner.classList.add('hidden');
            return;
        }
        banner.classList.remove('hidden');
        banner.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
            </svg>
            <span>Connectez-vous pour utiliser l'assistant Analyser.</span>
            <button type="button" class="assistant-login-open">Connexion</button>
        `;
        const btn = banner.querySelector('.assistant-login-open');
        if (btn && this.authManager) {
            btn.addEventListener('click', () => this.authManager.showModal());
        }
    }



    _renderAnonymousPlaceholder(container) {
        this.container = container;
        container.innerHTML = `
            <div class="assistant-app h-full w-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-white rounded-[1.25rem] overflow-hidden relative p-8">
                <div class="assistant-anonymous-card">
                    <h2 class="assistant-anonymous-title">Analyser votre modèle</h2>
                    <p class="assistant-anonymous-subtitle">Importez un modèle et discutez avec l'assistant pour le résumer, le vérifier ou l'améliorer.</p>
                    <div class="assistant-anonymous-features">
                        <div class="assistant-anonymous-feature">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                            <span>Importez TTL, XMI, JSON, SQL...</span>
                        </div>
                        <div class="assistant-anonymous-feature">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                            <span>Interrogez l'assistant de modélisation</span>
                        </div>
                        <div class="assistant-anonymous-feature">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            <span>Recevez des recommandations de standards</span>
                        </div>
                    </div>
                    <button type="button" class="assistant-login-open assistant-anonymous-btn">Se connecter pour continuer</button>
                    <p class="assistant-anonymous-hint">Pas encore de compte ? Le formulaire d'inscription s'ouvrira automatiquement.</p>
                </div>
            </div>
        `;
        const btn = container.querySelector('.assistant-login-open');
        if (btn && this.authManager) {
            btn.addEventListener('click', () => this.authManager.showModal());
        }
    }
}

window.AssistantApp = AssistantApp;
