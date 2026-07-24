/**
 * ChatApp
 * Assistant sémantique avec streaming LLM.
 */

class ChatApp extends AppBase {
    static id = "chat";
    static title = "Assistant";
    static iconSvg = `<svg class="w-4 h-4 overflow-visible" viewBox="0 0 24 24">
        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
    </svg>`;
    static canFloat = true;
    static canSplit = true;
    static singleton = false;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.documentId = props.documentId || '';
        this.docName = props.name || 'Document';
        this.history = [];
        this.messagesHtml = '';
        this.inputDraft = '';
        this.loadingAnimInterval = null;
    }

    render(container) {
        this.container = container;
        container.innerHTML = `
            <div class="chat-app h-full w-full flex flex-col bg-white rounded-[1.25rem] overflow-hidden">
                <div id="chat-messages" class="flex-1 overflow-y-auto p-4">
                    ${this.messagesHtml || this._welcomeMessage()}
                </div>
                <div class="p-3 border-t border-gray-100">
                    <form id="ai-chat-form" class="relative flex items-center">
                        <input type="text" id="ai-chat-input" autocomplete="off"
                            placeholder="Interrogez le modèle..."
                            class="w-full rounded-[2rem] border-2 border-gray-300 focus:outline-none focus:border-black font-medium transition-colors placeholder-gray-500 pl-4 pr-12 py-3 text-sm"
                            value="${this._escape(this.inputDraft)}">
                        <button type="submit" class="magic-btn chat-send-btn absolute right-2 text-white bg-black hover:bg-gray-800 rounded-full w-9 h-9 flex items-center justify-center transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                            </svg>
                        </button>
                    </form>
                </div>
            </div>
        `;
        this.setTitle(`Assistant: ${this.docName}`);
        this._bindEvents();
    }

    _escape(text) {
        return text.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _welcomeMessage() {
        return `
            <div class="flex flex-col items-start gap-3 mb-8">
                <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">
                    <p>Je prépare l'analyse de ce document. Quelle est votre question spécifique ?</p>
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

    _bindEvents() {
        const form = this.container.querySelector('#ai-chat-form');
        const input = this.container.querySelector('#ai-chat-input');
        const messagesContainer = this.container.querySelector('#chat-messages');
        let autoScrollEnabled = true;

        if (messagesContainer) {
            messagesContainer.addEventListener('scroll', () => {
                autoScrollEnabled = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 60;
            });
        }

        this._autoScrollEnabled = () => autoScrollEnabled;

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            this.inputDraft = '';
            input.value = '';
            this._sendMessage(text);
        });
        input.addEventListener('input', (e) => {
            this.inputDraft = e.target.value;
        });
    }

    async _sendMessage(text) {
        const messagesContainer = this.container.querySelector('#chat-messages');
        const historySnapshot = this.history.slice();
        let fullResponse = '';
        let displayedText = '';
        let streamBuffer = '';

        // Hide all existing sparkle containers (original behavior)
        this.container.querySelectorAll('.sparkle-container').forEach(container => {
            container.classList.remove('trigger-magic');
            container.style.transition = 'opacity 0.3s ease, height 0.3s ease, margin 0.3s ease';
            container.style.opacity = '0';
            setTimeout(() => { container.style.display = 'none'; }, 300);
        });

        messagesContainer.insertAdjacentHTML('beforeend', `
            <div class="flex items-end justify-end mb-8 user-msg-anchor">
                <div class="bg-gray-50 border border-gray-100 text-gray-900 px-5 py-3.5 rounded-[1.5rem] text-sm max-w-[80%] leading-relaxed">${this._escape(text)}</div>
            </div>
        `);
        const userMsgEl = messagesContainer.lastElementChild;

        const loadingId = 'loading-' + Date.now();
        messagesContainer.insertAdjacentHTML('beforeend', `
            <div id="${loadingId}" class="flex flex-col items-start gap-3 mb-8">
                <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body message-content"></div>
                <div class="flex items-center gap-2">
                    <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic">
                        ${this._sparkleSvg()}
                    </div>
                    <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400">Réflexion...</span>
                </div>
            </div>
        `);

        requestAnimationFrame(() => {
            const loadingEl = messagesContainer.querySelector(`#${loadingId}`);
            if (loadingEl && userMsgEl) {
                const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                messagesContainer.style.paddingBottom = remaining + 'px';
                requestAnimationFrame(() => {
                    userMsgEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }
        });

        const messageContent = messagesContainer.querySelector(`#${loadingId} .message-content`);
        const thinkingLabel = messagesContainer.querySelector(`#${loadingId} .thinking-label`);

        this.loadingAnimInterval = setInterval(() => {
            const avatar = messagesContainer.querySelector(`#${loadingId} .ai-avatar-wrapper`);
            if (avatar) {
                avatar.classList.remove('trigger-magic');
                void avatar.offsetWidth;
                avatar.classList.add('trigger-magic');
            }
        }, 1200);

        const typewriterInterval = setInterval(() => {
            if (streamBuffer.length > 0) {
                const chunkSize = Math.min(1 + Math.floor(Math.random() * 4), streamBuffer.length);
                displayedText += streamBuffer.slice(0, chunkSize);
                streamBuffer = streamBuffer.slice(chunkSize);
                if (messageContent) messageContent.innerHTML = marked.parse(displayedText);

                const loadingEl = messagesContainer.querySelector(`#${loadingId}`);
                if (loadingEl && userMsgEl && this._autoScrollEnabled && this._autoScrollEnabled()) {
                    const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                    const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                    messagesContainer.style.paddingBottom = remaining + 'px';
                }
            }
        }, 20);

        try {
            const reader = await ApiClient.streamChat(this.documentId, text, historySnapshot);
            const decoder = new TextDecoder('utf-8');
            let first = false;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                if (chunk) {
                    fullResponse += chunk;
                    streamBuffer += chunk;
                    if (!first) {
                        first = true;
                        if (thinkingLabel) thinkingLabel.remove();
                    }
                }
            }

            await new Promise(resolve => {
                const checkDrain = setInterval(() => {
                    if (streamBuffer.length === 0) {
                        clearInterval(checkDrain);
                        resolve();
                    }
                }, 30);
            });

            clearInterval(typewriterInterval);
        } catch (err) {
            console.error('Chat stream error', err);
            clearInterval(typewriterInterval);
            if (messageContent) messageContent.innerHTML += `<br><em>Erreur : ${err.message}</em>`;
        } finally {
            if (this.loadingAnimInterval) clearInterval(this.loadingAnimInterval);
            this.history.push({ role: 'user', content: text });
            this.history.push({ role: 'assistant', content: fullResponse });
            this._syncMessagesHtml(messagesContainer.innerHTML);

            requestAnimationFrame(() => {
                const loadingEl = messagesContainer.querySelector(`#${loadingId}`);
                if (loadingEl && userMsgEl && this._autoScrollEnabled && this._autoScrollEnabled()) {
                    const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                    const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                    messagesContainer.style.paddingBottom = remaining + 'px';
                }
            });
        }
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

    _scrollToBottom(container) {
        container.scrollTop = container.scrollHeight;
    }

    _syncMessagesHtml(html) {
        this.messagesHtml = html;
    }

    getState() {
        return {
            documentId: this.documentId,
            docName: this.docName,
            history: this.history,
            messagesHtml: this.messagesHtml,
            inputDraft: this.inputDraft,
        };
    }

    setState(state) {
        this.documentId = state.documentId || this.documentId;
        this.docName = state.docName || this.docName;
        this.history = state.history || [];
        this.messagesHtml = state.messagesHtml || '';
        this.inputDraft = state.inputDraft || '';
        if (this.container) this.render(this.container);
    }

    unmount() {
        if (this.loadingAnimInterval) clearInterval(this.loadingAnimInterval);
        super.unmount();
    }
}

window.ChatApp = ChatApp;
