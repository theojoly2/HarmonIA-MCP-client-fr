/**
 * ModelerAssistantPanel
 * Chat assistant intégré au Modéliseur. Discute du modèle affiché dans le
 * canvas principal : les mutations (add_class, add_attribute, add_connector)
 * sont appliquées au modèle courant via le MCP, et le canvas est rechargé.
 * Aucune carte SVG n'est affichée dans le chat : la visualisation reste dans
 * le grand canvas du modéliseur.
 */
class ModelerAssistantPanel {
    constructor(container, options = {}) {
        this.container = container;
        this.modelName = options.modelName || '';
        this.onRequestReload = options.onRequestReload || (async () => {});
        this.session = '';
        this.messages = [];
        this.isStreaming = false;
        this._pendingEvents = [];
        this._lastRenderedEventIndex = -1;
        this._currentStreamingText = '';
        this._streamAbortController = null;
        this._resizeObserver = null;
        this.render();
    }

    render() {
        this.container.innerHTML = `
            <div class="modeler-assistant h-full flex flex-col bg-white">
                <div id="ma-chat" class="flex-1 overflow-y-auto relative px-3 py-3"></div>
                <div class="flex-shrink-0 border-t border-gray-100 p-3 bg-white">
                    <form id="ma-form" class="flex items-end gap-2">
                        <textarea id="ma-input" rows="1" autocomplete="off"
                            placeholder="Demandez une modification du modèle..."
                            class="flex-1 resize-none max-h-32 bg-transparent border border-gray-300 rounded-xl focus:border-black focus:outline-none text-sm text-gray-900 placeholder-gray-500 px-3 py-2"></textarea>
                        <button type="submit" id="ma-send" class="w-9 h-9 flex-shrink-0 text-white bg-black hover:bg-gray-800 rounded-xl flex items-center justify-center transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path>
                            </svg>
                        </button>
                    </form>
                </div>
            </div>
        `;
        this.chatEl = this.container.querySelector('#ma-chat');
        this.inputEl = this.container.querySelector('#ma-input');
        this.sendBtn = this.container.querySelector('#ma-send');

        this._bindInputEvents();
        this.container.querySelector('#ma-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputEl.value.trim();
            if (!text || this.isStreaming) return;
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
            this._send(text);
        });

        this._appendWelcome();
        this._observeResize();
    }

    _bindInputEvents() {
        if (!this.inputEl) return;
        this.inputEl.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 128) + 'px';
        });
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.inputEl.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
        });
    }

    _observeResize() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (!this.container || typeof ResizeObserver === 'undefined') return;
        this._resizeObserver = new ResizeObserver(() => {
            this._scrollToBottom(true);
        });
        this._resizeObserver.observe(this.container);
    }

    _setSendEnabled(enabled) {
        if (!this.sendBtn) return;
        this.sendBtn.disabled = !enabled;
        this.sendBtn.style.backgroundColor = enabled ? '' : '#9ca3af';
    }

    _appendWelcome() {
        const div = document.createElement('div');
        div.className = 'flex flex-col items-center justify-center h-full text-center px-4 py-8';
        div.innerHTML = `
            <div class="w-10 h-10 text-gray-900 mb-3">${this._sparkleSvg()}</div>
            <p class="text-sm font-semibold text-gray-900">Assistant Sémantique</p>
            <p class="text-xs text-gray-500 mt-1">Posez une question ou demandez une modification du modèle affiché.</p>
        `;
        this.chatEl.appendChild(div);
    }

    _escape(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _sparkleSvg() {
        return `
            <svg class="w-full h-full overflow-visible" viewBox="0 0 24 24">
                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
            </svg>
        `;
    }

    _markdown(text) {
        if (!text) return '';
        if (typeof marked === 'undefined') {
            return this._escape(text).replace(/\n/g, '<br>');
        }
        return marked.parse(text, { breaks: true, gfm: true });
    }

    _removeWelcome() {
        if (this.chatEl.children.length === 1 && this.chatEl.children[0].querySelector('.sparkle-main')) {
            this.chatEl.innerHTML = '';
        }
    }

    _appendUserMessage(text) {
        this._removeWelcome();
        const div = document.createElement('div');
        div.className = 'flex justify-end mb-3';
        div.innerHTML = `
            <div class="bg-black text-white text-sm px-3 py-2 rounded-2xl rounded-tr-md max-w-[90%]">${this._escape(text)}</div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
    }

    _appendAssistantMessage(text, active = true) {
        const div = document.createElement('div');
        div.className = 'flex justify-start mb-3';
        div.dataset.role = 'assistant';
        div.dataset.active = active ? 'true' : 'false';
        div.innerHTML = `
            <div class="bg-gray-50 border border-gray-100 text-gray-900 text-sm px-3 py-2 rounded-2xl rounded-tl-md max-w-[90%] markdown-body">${this._markdown(text)}</div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _appendStatus(label) {
        const div = document.createElement('div');
        div.className = 'flex items-center gap-2 mb-3 text-xs font-bold tracking-widest uppercase text-gray-400';
        div.innerHTML = `<span class="w-4 h-4 text-gray-900 flex-shrink-0">${this._sparkleSvg()}</span><span>${this._escape(label)}</span>`;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _removeStatuses() {
        this.chatEl.querySelectorAll('[data-role="status"]').forEach((el) => el.remove());
    }

    _updateCurrentAssistantText(text) {
        const last = this.chatEl.lastElementChild;
        if (last && last.dataset.role === 'assistant' && last.dataset.active === 'true') {
            last.querySelector('.markdown-body').innerHTML = this._markdown(text);
        } else {
            this._appendAssistantMessage(text, true);
        }
        this._scrollToBottom();
    }

    _closeAssistantBubble() {
        const last = this.chatEl.lastElementChild;
        if (last && last.dataset.role === 'assistant') {
            last.dataset.active = 'false';
        }
    }

    _appendSearchCard(query, resultsHtml) {
        const div = document.createElement('div');
        div.className = 'mb-3 bg-white border border-gray-200 rounded-xl overflow-hidden';
        div.innerHTML = `
            <div class="px-3 py-2 border-b border-gray-100 flex items-center gap-2 text-xs font-semibold text-gray-700">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                <span class="truncate">${this._escape(query || '')}</span>
            </div>
            <div class="max-h-48 overflow-y-auto p-2 text-sm">${resultsHtml || '<span class="text-gray-400">Recherche en cours...</span>'}</div>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
    }

    _fillSearchCard(query, resultsHtml) {
        const cards = Array.from(this.chatEl.children).filter((el) => el.querySelector('.border-b.border-gray-100'));
        let target = cards[cards.length - 1];
        if (!target) target = this._appendSearchCard(query, resultsHtml);
        const body = target.querySelector('.max-h-48');
        if (body) body.innerHTML = resultsHtml || '<span class="text-gray-400">Aucun résultat.</span>';
        this._scrollToBottom();
    }

    _appendPlan(result) {
        const parsed = (result.tool_results && typeof result.tool_results === 'object')
            ? result.tool_results
            : result;
        const steps = Array.isArray(parsed.plan_steps) ? parsed.plan_steps : [];
        if (!steps.length) return;
        const div = document.createElement('div');
        div.className = 'mb-3 bg-blue-50 border border-blue-100 rounded-xl p-3';
        div.innerHTML = `
            <div class="flex items-center gap-2 text-xs font-bold text-blue-700 mb-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
                Plan d'action
            </div>
            <ol class="list-decimal list-inside text-xs text-gray-700 space-y-1">
                ${steps.map((s) => `<li>${this._escape(typeof s === 'string' ? s : (s.step || ''))}</li>`).join('')}
            </ol>
        `;
        this.chatEl.appendChild(div);
        this._scrollToBottom();
    }

    _scrollToBottom(instant = false) {
        if (!this.chatEl) return;
        requestAnimationFrame(() => {
            this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
        });
    }

    async _send(text) {
        if (!this.modelName) {
            this._appendAssistantMessage('Aucun modèle n\'est chargé. Importez ou créez un modèle pour discuter avec l\'assistant.');
            return;
        }
        this._removeWelcome();
        this.messages.push({ role: 'user', content: text });
        this._appendUserMessage(text);
        this.isStreaming = true;
        this._setSendEnabled(false);
        this._pendingEvents = [];
        this._lastRenderedEventIndex = -1;
        this._currentStreamingText = '';

        let placeholder = this._appendStatus('Réflexion...');
        const placeholderRef = { value: placeholder };

        let currentText = '';
        this._streamAbortController?.abort();
        this._streamAbortController = new AbortController();

        const resetBubble = () => {
            this._closeAssistantBubble();
            currentText = '';
            this._currentStreamingText = '';
        };

        const saveHtmlSnapshot = () => {};

        const liveHandler = async (event) => {
            const eventsToReplay = this._pendingEvents.slice(this._lastRenderedEventIndex + 1);
            this._lastRenderedEventIndex = this._pendingEvents.length - 1;
            for (const ev of eventsToReplay) {
                this._processEvent(ev, { resetBubble, placeholderRef, saveHtmlSnapshot });
            }
            this._processEvent(event, { resetBubble, placeholderRef, saveHtmlSnapshot });
        };

        try {
            await ApiClient.streamAssistant(this.session || '', text, this.modelName, [], liveHandler);
        } catch (err) {
            console.error('Modeler assistant stream error', err);
            this._appendAssistantMessage(`Erreur : ${this._escape(err.message)}`);
        } finally {
            this.isStreaming = false;
            this._setSendEnabled(true);
            this._closeAssistantBubble();
            if (currentText) {
                this.messages.push({ role: 'assistant', content: currentText });
            }
            placeholder.remove?.();
            this._streamAbortController = null;
        }
    }

    _processEvent(event, { resetBubble, placeholderRef, saveHtmlSnapshot }) {
        if (event.kind === 'user') {
            if (event.session) this.session = event.session;
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            return;
        }

        if (event.kind === 'thinking') {
            if (placeholderRef.value) placeholderRef.value.remove();
            placeholderRef.value = this._appendStatus('Réflexion...');
            return;
        }

        if (event.kind === 'assistant_text') {
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            currentText = (currentText || '') + (event.content || '');
            this._currentStreamingText = currentText;
            this._updateCurrentAssistantText(currentText);
            return;
        }

        if (event.kind === 'assistant_done') {
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            if (event.content && !currentText) {
                currentText = event.content;
                this._currentStreamingText = currentText;
                this._appendAssistantMessage(currentText, false);
            }
            return;
        }

        if (event.kind === 'assistant_message') {
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            this._appendAssistantMessage(event.content || '', false);
            return;
        }

        if (event.kind === 'assistant_tool_calls') {
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            return;
        }

        if (event.kind === 'tool_start') {
            resetBubble();
            if (placeholderRef.value) placeholderRef.value.remove();
            if (event.name === 'retrieve_documents') {
                this._appendSearchCard(event.arguments?.search_terms || '', null);
            }
            const status = this._toolStatusLabel(event.name);
            placeholderRef.value = status ? this._appendStatus(status) : null;
            return;
        }

        if (event.kind === 'progress_start') {
            resetBubble();
            if (placeholderRef.value) placeholderRef.value.remove();
            placeholderRef.value = this._appendStatus(this._toolStatusLabel(event.tool_name));
            return;
        }

        if (event.kind === 'progress_done') {
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            return;
        }

        if (event.kind === 'tool_result') {
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            if (event.name === 'plan_workflow_with_tools') {
                this._appendPlan(event.result);
            } else if (event.name === 'retrieve_documents') {
                this._fillSearchCard(event.display?.query || '', event.display?.results_html || '');
            }
            return;
        }

        if (event.kind === 'model_svg') {
            // Le SVG du modèle muté est affiché dans le grand canvas, pas ici.
            this.onRequestReload();
            return;
        }

        if (event.kind === 'loop_done') {
            resetBubble();
            return;
        }

        if (event.kind === 'error') {
            resetBubble();
            if (placeholderRef.value) {
                placeholderRef.value.remove();
                placeholderRef.value = null;
            }
            this._appendAssistantMessage(`Erreur : ${this._escape(event.message || '')}`, false);
            return;
        }
    }

    _toolStatusLabel(name) {
        const labels = {
            plan_workflow_with_tools: 'Planification...',
            retrieve_documents: 'Recherche...',
            add_class: 'Création de classe...',
            add_attribute: 'Ajout d\'attribut...',
            add_connector: 'Création de relation...',
            style_guide_check: 'Synthèse...',
            metadata_checker: 'Vérification...',
            reuse_check: 'Réutilisation...',
            validator_check: 'Validation...',
        };
        return labels[name] || `${name}...`;
    }

    destroy() {
        if (this._streamAbortController) {
            this._streamAbortController.abort();
            this._streamAbortController = null;
        }
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        this.container.innerHTML = '';
    }
}

window.ModelerAssistantPanel = ModelerAssistantPanel;
