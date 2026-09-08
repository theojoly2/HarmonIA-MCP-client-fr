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
        this._renderer = new AssistantRenderer(this.messagesEl, this.chatEl, {
            escape: (t) => this._escape(t),
            markdown: (t, streaming = false) => AssistantMarkdown.markdown(t, (x) => this._escape(x), streaming),
            sparkleSvg: () => AssistantMarkdown.sparkleSvg(),
            toolStatusLabel: (n) => AssistantEventProcessor.toolStatusLabel(n),
            toolSummary: (result) => AssistantEventProcessor.toolSummary(result),
            buildResultsHtml: (results, count, opts) => this.ui.buildResultsHtml(results, count, opts),
            onUpdateSearchButtons: () => this._updateSearchResultAddButtons(),
            onScroll: (force) => this._scrollToBottom(force),
        });

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
                            ${AssistantMarkdown.markdown(introText, (t) => this._escape(t), false)}
                        </div>
                        <div class="ai-avatar-row flex items-center gap-2">
                            <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                                ${AssistantMarkdown.sparkleSvg()}
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

        this._scanGlow(container);

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
        if (!this._embedded && !(this.authManager && this.authManager.isLoggedIn())) {
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
        if (this.authManager?.isLoggedIn() && this.container?.querySelector('.assistant-anonymous-card')) {
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
        // Detach all imported/linked models so the fresh conversation starts
        // with an empty context, exactly like a brand-new assistant session.
        this._clearModelPills();
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
            const result = await ModelGateway.importAssistantModel(file, file.name, this.origin);
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
            const result = await ModelGateway.importDocumentAsAssistantModel(docId, this.origin);
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
                await ModelGateway.deleteModel(name).catch((err) => {
                    console.error("Failed to delete orphan imported model", name, err?.message || err);
                });
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
            const blob = await ModelGateway.exportAsBlob(name, format);
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
            const data = await SearchGateway.getTags();
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
            <div class="assistant-bubble-content markdown-body">${AssistantMarkdown.markdown(text, (t) => this._escape(t), false)}</div>
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
        this._renderer.removeThinkingPlaceholder();
        const loadingPlaceholder = this._renderer.appendThinkingPlaceholder('Chargement de la conversation...');

            const data = await AssistantGateway.getAssistantHistory(session, this.origin);
        console.log('[AssistantApp] history data', data);

        this._renderer.removeThinkingPlaceholder();

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
        this._renderer.activeSvgCard = null;
        this._renderer.activeSvgViewer = null;

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
                this._renderer.activeSvgCard = null;
                this._renderer.activeSvgViewer = null;
                this._renderer.removeThinkingPlaceholder();
                this.messages.push({ role: 'user', content: event.content || '' });
                this._renderer.appendUserMessage(event.content || '');
                lastRole = 'user';
                return;
            }
            if (kind === 'assistant_text') {
                if (lastRole !== 'assistant') {
                    closeReplayBubble();
                }
                currentText += event.content || '';
                const bubble = ensureReplayBubble();
                bubble.innerHTML = AssistantMarkdown.markdown(currentText, (t) => this._escape(t), false);
                lastRole = 'assistant';
                return;
            }
            if (kind === 'assistant_done') {
                if (event.content && !currentText) {
                    currentText = event.content;
                    const bubble = ensureReplayBubble();
                    bubble.innerHTML = AssistantMarkdown.markdown(currentText, (t) => this._escape(t), false);
                }
                closeReplayBubble();
                this._renderer.activeSvgCard = null;
                this._renderer.activeSvgViewer = null;
                this._renderer.removeThinkingPlaceholder();
                lastRole = 'assistant';
                return;
            }
            if (kind === 'assistant_message') {
                // Full assistant message persisted as a single event (used for
                // intermediate explanations produced between tool calls).
                closeReplayBubble();
                this._renderer.hideAllSparkles();
                this._renderer.removeThinkingPlaceholder();
                const bubble = ensureReplayBubble();
                bubble.innerHTML = AssistantMarkdown.markdown(event.content || '', (t) => this._escape(t), false);
                closeReplayBubble();
                lastRole = 'assistant';
                return;
            }
            if (kind === 'assistant_tool_calls') {
                closeReplayBubble();
                this._renderer.hideAllSparkles();
                this.messages.push({ role: 'assistant_tool_calls', tool_calls: event.tool_calls });
                lastRole = 'tool';
                return;
            }
            if (kind === 'tool_start') {
                closeReplayBubble();
                this._renderer.hideAllSparkles();
                this._renderer.removeThinkingPlaceholder();
                if (event.name === 'retrieve_documents') {
                    this._renderer.appendSearchCard(event.arguments?.search_terms || '', null);
                }
                lastRole = 'tool';
                return;
            }
            if (kind === 'progress_start') {
                closeReplayBubble();
                this._renderer.hideAllSparkles();
                this._renderer.removeThinkingPlaceholder();
                this._renderer.appendProgressCard(event.card_id, event.tool_name);
                lastRole = 'tool';
                return;
            }
            if (kind === 'progress_update') {
                this._renderer.updateProgressCard(event.card_id, event.percent, event.message);
                return;
            }
            if (kind === 'progress_done') {
                this._renderer.completeProgressCard(event.card_id);
                this._renderer.removeProgressStatus(event.card_id);
                return;
            }
            if (kind === 'tool_result') {
                closeReplayBubble();
                if (event.name === 'plan_workflow_with_tools') {
                    this._renderer.renderPlan(event.result, {
                        knownNames: new Set([
                            ...(this.modelNames || []),
                            ...Object.keys(this.props.displayNames || {}),
                        ]),
                        displayForName: (storedName) => this._displayNameForModel(storedName),
                    });
                } else if (event.name === 'retrieve_documents') {
                    const display = event.display || {};
                    const results = display.results || [];
                    const resultsHtml = this.ui.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
                    this._renderer.fillSearchCard(display.query || '', resultsHtml);
                } else {
                    this._renderer.fillToolResult(event.name, event.result, event.display);
                }
                lastRole = 'tool';
                return;
            }
            if (kind === 'model_svg') {
                const rawName = event.model_name || event.label || '';
                const label = rawName
                    ? this._displayNameForModel(rawName)
                    : 'Visualisation du modèle';
                this._renderer.updateCurrentSvgCard(event.svg, label);
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
                this._renderer.activeSvgCard = null;
                this._renderer.activeSvgViewer = null;
                return;
            }
            if (kind === 'thinking') {
                this._renderer.removeThinkingPlaceholder();
                this._renderer.appendThinkingPlaceholder('Réflexion...');
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
        this._renderer.removeThinkingPlaceholder();

        // Add a sparkle avatar under the last assistant message so the replayed
        // conversation visually matches the live streaming state.
        this._renderer.updateFinalSparkle();

        // Ensure the view is scrolled all the way to the bottom after rendering.
        requestAnimationFrame(() => {
            this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'auto' });
        });
        console.log('[AssistantApp] loaded messages count', this.messages.length);
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
        const sessionToSend = this.session || '';

        this.messages.push({ role: 'user', content: text });
        this._renderer.appendUserMessage(text);
        this.isStreaming = true;
        this._setSendEnabled(false);
        this._pendingEvents = [];
        this._lastRenderedEventIndex = -1;
        this._renderer.hideAllSparkles();

        let placeholder = this._renderer.appendThinkingPlaceholder('Réflexion...');
        const loadingInterval = setInterval(() => {
            const placeholders = Array.from(this.chatEl.querySelectorAll('.assistant-thinking-placeholder'));
            const latest = placeholders.length ? placeholders[placeholders.length - 1] : null;
            const avatar = latest?.querySelector('.ai-avatar-wrapper');
            if (avatar) {
                avatar.classList.remove('trigger-magic');
                void avatar.offsetWidth;
                avatar.classList.add('trigger-magic');
            }
        }, 1200);

        const typewriter = new AssistantTypewriter({
            messagesEl: this.messagesEl,
            renderer: this._renderer,
            sparkleSvg: () => AssistantMarkdown.sparkleSvg(),
            markdown: (t) => AssistantMarkdown.markdown(t, (x) => this._escape(x), false),
            adjustPadding: () => this._adjustChatPadding(),
        });

        this._streamAbortController?.abort();
        this._streamAbortController = new AbortController();

        const saveHtmlSnapshot = () => {
            if (this.messagesEl) {
                this.messagesHtml = this.messagesEl.innerHTML;
            }
        };

        const ctx = {
            renderer: this._renderer,
            ui: this.ui,
            escape: (t) => this._escape(t),
            markdown: (t, streaming = false) => AssistantMarkdown.markdown(t, (x) => this._escape(x), streaming),
            embedded: this._embedded,
            linkedModelerInstanceId: this._linkedModelerInstanceId || this.props.linkedModelerInstanceId,
            modelNames: this.modelNames,
            onModelAttached: (name) => {
                this.props.displayNames = this.props.displayNames || {};
                this.props.displayNames[name] = this.props.displayNames[name] || name;
                this._syncModelUi();
            },
            getSession: () => this.session,
            setSession: (session) => { this.session = session; },
            saveHtmlSnapshot,
            typewriter,
            placeholderRef: { value: placeholder },
            streamAliveTimeoutRef: { timeout: this._streamAliveTimeout },
            abortController: this._streamAbortController,
        };

        const liveHandler = async (event) => {
            if (!this.messagesEl) {
                this._pendingEvents.push(event);
                return;
            }
            const eventsToReplay = this._pendingEvents.slice(this._lastRenderedEventIndex + 1);
            this._lastRenderedEventIndex = this._pendingEvents.length - 1;
            for (const ev of eventsToReplay) {
                AssistantEventProcessor.processEvent(ev, ctx);
            }
            AssistantEventProcessor.processEvent(event, ctx);
            this._streamAliveTimeout = ctx.streamAliveTimeoutRef.timeout || null;
        };

        try {
            await AssistantGateway.streamAssistant(
                sessionToSend,
                text,
                this.modelNames,
                this.selectedTags || [],
                liveHandler,
                { origin: this.origin }
            );
        } catch (err) {
            console.error('Assistant stream error', err);
            this._renderer.removeThinkingPlaceholder();
            const bubble = this._renderer.ensureAssistantBubble();
            bubble.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(err.message)}</em>`;
        } finally {
            clearInterval(loadingInterval);
            typewriter.stop();
            typewriter.flush();
            this.isStreaming = false;
            this._setSendEnabled(true);
            this._renderer.closeAssistantBubble();

            if (typewriter.displayedText) {
                this.messages.push({ role: 'assistant', content: typewriter.displayedText });
            }

            this._renderer.removeThinkingPlaceholder();
            this._renderer.updateFinalSparkle();
            saveHtmlSnapshot();
            clearTimeout(this._streamAliveTimeout);
            this._streamAliveTimeout = null;
        }
    }

    _updateFinalSparkle() {
        this._renderer.updateFinalSparkle();
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
        if (this.authManager?.isLoggedIn()) {
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
