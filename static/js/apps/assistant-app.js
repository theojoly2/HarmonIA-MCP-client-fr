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

    _appendAssistantPlaceholder() {
        const id = 'assistant-loading-' + Date.now();
        const wrapper = document.createElement('div');
        wrapper.id = id;
        wrapper.className = 'flex flex-col items-start gap-3 mb-6';
        wrapper.innerHTML = `
            <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body message-content"></div>
            <div class="flex items-center gap-2">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic">
                    ${this._sparkleSvg()}
                </div>
                <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400">Réflexion...</span>
            </div>
        `;
        this.chatEl.appendChild(wrapper);
        this._scrollToBottom();
        return { wrapper, content: wrapper.querySelector('.message-content'), label: wrapper.querySelector('.thinking-label') };
    }

    _appendToolStart(name) {
        const div = document.createElement('div');
        div.className = 'flex flex-col items-start gap-2 mb-4 max-w-[95%]';
        div.innerHTML = `
            <div class="flex items-center gap-2 px-3 py-2 rounded-full bg-blue-50 border border-blue-100 text-blue-800 text-xs font-semibold">
                <span class="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse"></span>
                Outil <span class="font-mono">${this._escape(name)}</span> en cours…
            </div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _appendToolResult(name, result) {
        const div = document.createElement('div');
        div.className = 'flex flex-col items-start gap-1 mb-4 max-w-[95%]';
        const summary = this._toolSummary(result);
        div.innerHTML = `
            <details class="assistant-tool-result bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-xs text-gray-700">
                <summary class="cursor-pointer font-semibold select-none">Résultat de <span class="font-mono">${this._escape(name)}</span>${summary}</summary>
                <pre class="mt-2 overflow-x-auto whitespace-pre-wrap">${this._escape(JSON.stringify(result, null, 2))}</pre>
            </details>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
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
        requestAnimationFrame(() => {
            this.chatEl.scrollTop = this.chatEl.scrollHeight;
        });
    }

    async _send(text) {
        if (!this.session) {
            this.session = this._slugify(text);
        }
        this.modelName = this.modelInput.value.trim();

        this.messages.push({ role: 'user', content: text });
        const userMsgEl = this._appendUserMessage(text);
        this.isStreaming = true;

        const placeholder = this._appendAssistantPlaceholder();
        const loadingInterval = setInterval(() => {
            const avatar = placeholder.wrapper.querySelector('.ai-avatar-wrapper');
            if (avatar) {
                avatar.classList.remove('trigger-magic');
                void avatar.offsetWidth;
                avatar.classList.add('trigger-magic');
            }
        }, 1200);

        let currentText = '';
        let displayedText = '';
        let streamBuffer = '';
        let toolStartEl = null;

        const typewriter = setInterval(() => {
            if (streamBuffer.length > 0) {
                const chunkSize = Math.min(1 + Math.floor(Math.random() * 4), streamBuffer.length);
                displayedText += streamBuffer.slice(0, chunkSize);
                streamBuffer = streamBuffer.slice(chunkSize);
                if (placeholder.content) placeholder.content.innerHTML = this._markdown(displayedText);
                this._scrollToBottom();
            }
        }, 20);

        try {
            await ApiClient.streamAssistant(
                this.session,
                text,
                this.modelName,
                (event) => {
                    if (event.kind === 'user') {
                        if (event.session) this.session = event.session;
                        return;
                    }
                    if (event.kind === 'thinking') {
                        return;
                    }
                    if (event.kind === 'assistant_text') {
                        if (placeholder.label) placeholder.label.remove();
                        currentText += event.content || '';
                        streamBuffer += event.content || '';
                        return;
                    }
                    if (event.kind === 'tool_start') {
                        if (placeholder.label) placeholder.label.remove();
                        if (placeholder.content && !placeholder.content.innerHTML.trim()) {
                            placeholder.wrapper.style.display = 'none';
                        }
                        toolStartEl = this._appendToolStart(event.name);
                        this.messages.push({ role: 'tool_start', name: event.name });
                        return;
                    }
                    if (event.kind === 'tool_result') {
                        if (toolStartEl) {
                            toolStartEl.remove();
                            toolStartEl = null;
                        }
                        this._appendToolResult(event.name, event.result);
                        this.messages.push({ role: 'tool_result', name: event.name, result: event.result });
                        return;
                    }
                    if (event.kind === 'assistant_done') {
                        if (placeholder.label) placeholder.label.remove();
                        if (event.content && !currentText) {
                            streamBuffer += event.content;
                        }
                        return;
                    }
                    if (event.kind === 'error') {
                        if (placeholder.label) placeholder.label.remove();
                        placeholder.content.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(event.message || '')}</em>`;
                    }
                }
            );

            await new Promise((resolve) => {
                const drain = setInterval(() => {
                    if (streamBuffer.length === 0) {
                        clearInterval(drain);
                        resolve();
                    }
                }, 30);
            });
        } catch (err) {
            console.error('Assistant stream error', err);
            if (placeholder.label) placeholder.label.remove();
            placeholder.content.innerHTML += `<br><em class="text-red-600">Erreur : ${this._escape(err.message)}</em>`;
        } finally {
            clearInterval(typewriter);
            clearInterval(loadingInterval);
            this.isStreaming = false;

            if (placeholder.content) {
                placeholder.content.innerHTML = this._markdown(displayedText + streamBuffer);
            }
            if (currentText || streamBuffer) {
                this.messages.push({ role: 'assistant', content: currentText + streamBuffer });
            }

            requestAnimationFrame(() => {
                const paddingBottom = Math.max(0, this.chatEl.clientHeight - (placeholder.wrapper ? placeholder.wrapper.offsetHeight : 0) - 20);
                this.chatEl.style.paddingBottom = paddingBottom + 'px';
                this._scrollToBottom();
            });
        }
    }
}

window.AssistantApp = AssistantApp;
