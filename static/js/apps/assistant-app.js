/**
 * AssistantApp
 * Chatbot de modélisation sémantique avec tool calling.
 */

class AssistantApp extends AppBase {
    static id = 'assistant';
    static title = 'Assistant Sémantique';
    static iconSvg = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>`;

    constructor(instanceId, props = {}) {
        super(instanceId, props);
        this.session = props.session || '';
        this.modelName = props.modelName || '';
        this.messages = [];
        this.isStreaming = false;
    }

    async render(container) {
        this.container = container;
        container.innerHTML = `
            <div class="assistant-app">
                <div class="assistant-header">
                    <div class="assistant-title">Assistant Sémantique</div>
                    <div class="assistant-model">
                        <label for="assistant-model">Modèle</label>
                        <input type="text" id="assistant-model" value="${this._escape(this.modelName)}" placeholder="Nom du modèle (optionnel)" autocomplete="off">
                    </div>
                    <button type="button" id="assistant-new-session" class="assistant-btn assistant-btn-secondary">Nouvelle session</button>
                </div>
                <div class="assistant-chat" id="assistant-chat"></div>
                <div class="assistant-input-area">
                    <textarea id="assistant-input" rows="2" placeholder="Posez votre question sémantique..."></textarea>
                    <button type="button" id="assistant-send" class="assistant-btn assistant-btn-primary" disabled>Envoyer</button>
                </div>
            </div>
        `;

        this.chatEl = container.querySelector('#assistant-chat');
        this.inputEl = container.querySelector('#assistant-input');
        this.sendBtn = container.querySelector('#assistant-send');
        this.modelInput = container.querySelector('#assistant-model');

        this.sendBtn.addEventListener('click', () => this._send());
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._send();
            }
        });
        this.inputEl.addEventListener('input', () => this._toggleSend());
        this.modelInput.addEventListener('change', () => {
            this.modelName = this.modelInput.value.trim();
        });
        container.querySelector('#assistant-new-session').addEventListener('click', () => this._newSession());

        this._loadHistory();
        this._toggleSend();
    }

    _escape(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _toggleSend() {
        this.sendBtn.disabled = !this.inputEl.value.trim() || this.isStreaming;
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
        this._renderMessages();
    }

    _loadLocalHistory() {
        // When no session name is chosen yet we just keep the in-memory messages
        // until the first message is sent and a session is created server-side.
        if (!this.session) {
            return;
        }
        this._renderMessages();
    }

    async _loadHistory() {
        if (!this.session) {
            this.messages = [];
            this._renderMessages();
            return;
        }
        try {
            const data = await ApiClient.getAssistantSessions();
            const sessions = data.sessions || [];
            if (!sessions.includes(this.session)) {
                this.messages = [];
                this._renderMessages();
                return;
            }
            const history = await ApiClient.getAssistantHistory(this.session);
            this.messages = (history.messages || []).map((m) => ({
                role: m.role,
                content: m.content || '',
                tool_calls: m.tool_calls,
                name: m.name,
                result: m.result,
            }));
            this._renderMessages();
        } catch (err) {
            console.error('Assistant history load error', err);
            this.messages = [];
            this._renderMessages();
        }
    }

    _renderMessages() {
        this.chatEl.innerHTML = '';
        this.messages.forEach((msg) => this._appendMessageEl(msg));
        this._scrollToBottom();
    }

    _appendMessageEl(msg) {
        const div = document.createElement('div');
        div.className = `assistant-message assistant-message-${msg.role}`;

        if (msg.role === 'user') {
            div.innerHTML = `<div class="assistant-bubble assistant-bubble-user">${this._markdown(msg.content)}</div>`;
        } else if (msg.role === 'assistant') {
            div.innerHTML = `<div class="assistant-bubble assistant-bubble-assistant">${this._markdown(msg.content)}</div>`;
        } else if (msg.role === 'tool_start') {
            div.className = 'assistant-message assistant-message-tool';
            div.innerHTML = `<div class="assistant-tool-start">Outil <strong>${this._escape(msg.name)}</strong> en cours…</div>`;
        } else if (msg.role === 'tool_result') {
            div.className = 'assistant-message assistant-message-tool';
            const summary = this._toolSummary(msg.result);
            div.innerHTML = `
                <details class="assistant-tool-result">
                    <summary>Résultat de <strong>${this._escape(msg.name)}</strong>${summary}</summary>
                    <pre>${this._escape(JSON.stringify(msg.result, null, 2))}</pre>
                </details>
            `;
        } else if (msg.role === 'thinking') {
            div.className = 'assistant-message assistant-message-thinking';
            div.innerHTML = `<div class="assistant-thinking"><span class="assistant-spinner"></span> Réflexion en cours…</div>`;
        }

        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
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

    _markdown(text) {
        if (!text) return '';
        if (typeof marked !== 'undefined') {
            return marked.parse(text, { breaks: true, gfm: true });
        }
        return this._escape(text).replace(/\n/g, '<br>');
    }

    _scrollToBottom() {
        requestAnimationFrame(() => {
            this.chatEl.scrollTop = this.chatEl.scrollHeight;
        });
    }

    async _send() {
        const text = this.inputEl.value.trim();
        if (!text || this.isStreaming) return;

        // First message creates the session name from the user text.
        if (!this.session) {
            this.session = this._slugify(text);
        }
        this.modelName = this.modelInput.value.trim();

        this.messages.push({ role: 'user', content: text });
        this._appendMessageEl({ role: 'user', content: text });
        this.inputEl.value = '';
        this._toggleSend();
        this.isStreaming = true;

        let currentAssistant = null;
        let currentThinking = null;

        try {
            await ApiClient.streamAssistant(
                this.session,
                text,
                this.modelName,
                (event) => {
                    if (event.kind === 'user') {
                        return;
                    }
                    if (event.kind === 'thinking') {
                        if (!currentThinking) {
                            currentThinking = this._appendMessageEl({ role: 'thinking' });
                        }
                        return;
                    }
                    if (event.kind === 'assistant_text') {
                        if (currentThinking) {
                            currentThinking.remove();
                            currentThinking = null;
                        }
                        if (!currentAssistant) {
                            this.messages.push({ role: 'assistant', content: '' });
                            currentAssistant = this._appendMessageEl({ role: 'assistant', content: '' });
                        }
                        const existing = this.messages[this.messages.length - 1];
                        if (existing.role === 'assistant') {
                            existing.content += event.content || '';
                            currentAssistant.querySelector('.assistant-bubble-assistant').innerHTML = this._markdown(existing.content);
                        }
                        this._scrollToBottom();
                        return;
                    }
                    if (event.kind === 'assistant_tool_calls') {
                        if (currentThinking) {
                            currentThinking.remove();
                            currentThinking = null;
                        }
                        return;
                    }
                    if (event.kind === 'tool_start') {
                        this.messages.push({ role: 'tool_start', name: event.name });
                        this._appendMessageEl({ role: 'tool_start', name: event.name });
                        return;
                    }
                    if (event.kind === 'tool_result') {
                        this.messages.push({ role: 'tool_result', name: event.name, result: event.result });
                        this._appendMessageEl({ role: 'tool_result', name: event.name, result: event.result });
                        return;
                    }
                    if (event.kind === 'assistant_done') {
                        if (currentThinking) {
                            currentThinking.remove();
                            currentThinking = null;
                        }
                        if (event.content && !currentAssistant) {
                            this.messages.push({ role: 'assistant', content: event.content });
                            this._appendMessageEl({ role: 'assistant', content: event.content });
                        }
                        currentAssistant = null;
                        return;
                    }
                    if (event.kind === 'error') {
                        if (currentThinking) {
                            currentThinking.remove();
                            currentThinking = null;
                        }
                        this.messages.push({ role: 'assistant', content: `Erreur : ${event.message || ''}` });
                        this._appendMessageEl({ role: 'assistant', content: `Erreur : ${event.message || ''}` });
                    }
                }
            );
        } catch (err) {
            console.error('Assistant stream error', err);
            this.messages.push({ role: 'assistant', content: `Erreur : ${err.message || err}` });
            this._appendMessageEl({ role: 'assistant', content: `Erreur : ${err.message || err}` });
        } finally {
            this.isStreaming = false;
            this._toggleSend();
        }
    }
}

window.AssistantApp = AssistantApp;
