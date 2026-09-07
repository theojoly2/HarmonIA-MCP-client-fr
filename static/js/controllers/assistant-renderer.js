/**
 * AssistantRenderer
 *
 * Encapsulates DOM rendering for the assistant chat timeline.
 * Keeps AssistantApp focused on state/streams while this helper manages
 * bubbles, cards, placeholders, SVG cards, tool cards, plan cards and
 * search result cards.
 */

class AssistantRenderer {
    constructor(messagesEl, chatEl, options = {}) {
        this.messagesEl = messagesEl;
        this.chatEl = chatEl;
        this.ui = (typeof ServiceLocator !== "undefined" && ServiceLocator.get("uiHelpers")) || window.UiHelpers || {};
        this.escape = options.escape || ((t) => t);
        this.markdown = options.markdown || ((t) => t);
        this.sparkleSvg = options.sparkleSvg || (() => '');
        this.toolStatusLabel = options.toolStatusLabel || ((n) => n);
        this.buildResultsHtml = options.buildResultsHtml || (() => '');
        this.onUpdateSearchButtons = options.onUpdateSearchButtons || (() => {});
        this.onScroll = options.onScroll || (() => {});
        this.activeSvgCard = null;
        this.activeSvgViewer = null;
        this._thinkingTimeout = null;
    }

    _scrollToBottom(force = false) {
        this.onScroll(force);
    }

    appendUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'assistant-bubble assistant-bubble-user mb-6 user-msg-anchor';
        div.innerHTML = `<div class="assistant-bubble-content">${this.escape(text)}</div>`;
        this.messagesEl.appendChild(div);
        if (this.chatEl) {
            requestAnimationFrame(() => {
                div.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
        return div;
    }

    appendSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'assistant-bubble assistant-bubble-assistant mb-6';
        div.innerHTML = `
            <div class="assistant-bubble-content markdown-body">${this.markdown(text)}</div>
        `;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
    }

    appendThinkingPlaceholder(label = 'Réflexion...') {
        this.removeThinkingPlaceholder();
        const wrapper = document.createElement('div');
        wrapper.className = 'assistant-bubble assistant-bubble-assistant mb-6 assistant-thinking-placeholder';
        wrapper.innerHTML = `
            <div class="assistant-bubble-content markdown-body" style="min-height:0;"></div>
            <div class="ai-avatar-row flex items-center gap-2">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic">
                    ${this.sparkleSvg()}
                </div>
                <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400">${this.escape(label)}</span>
            </div>
        `;
        this.messagesEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper;
    }

    updateThinkingLabel(label) {
        const target = this.messagesEl.querySelector('.assistant-thinking-placeholder');
        if (!target) return;
        const labelEl = target.querySelector('.thinking-label');
        if (labelEl) labelEl.textContent = label;
    }

    removeThinkingPlaceholder() {
        this.messagesEl.querySelectorAll('.assistant-thinking-placeholder').forEach((el) => {
            if (el.parentNode) el.remove();
        });
    }

    ensureAssistantBubble() {
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
                    ${this.sparkleSvg()}
                </div>
            </div>
        `;
        this.messagesEl.appendChild(wrapper);
        this._scrollToBottom();
        return wrapper.querySelector('.assistant-bubble-content');
    }

    closeAssistantBubble() {
        const last = this.messagesEl.lastElementChild;
        if (last && last.dataset.role === 'assistant' && last.dataset.active === 'true') {
            last.dataset.active = 'false';
        }
    }

    hideAllSparkles() {
        this.chatEl?.querySelectorAll('.sparkle-container').forEach((container) => {
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

    updateFinalSparkle() {
        const last = this.messagesEl.lastElementChild;
        if (last && last.dataset.role === 'assistant') {
            if (!last.querySelector('.ai-avatar-row')) {
                last.innerHTML += `
                    <div class="ai-avatar-row flex items-center gap-2">
                        <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic" data-hidden="false">
                            ${this.sparkleSvg()}
                        </div>
                    </div>
                `;
            }
        }
    }

    appendToolCalls(toolCalls) {
        const names = (toolCalls || [])
            .map((c) => c?.function?.name || c?.name || 'outil')
            .filter(Boolean);
        if (!names.length) return null;
        const div = document.createElement('div');
        div.className = 'assistant-tool-calls mb-4';
        div.innerHTML = `
            <div class="assistant-tool-calls-title">Appels d’outils planifiés</div>
            <div class="assistant-tool-calls-list">
                ${names.map((n) => `<span class="assistant-tool-call-name">${this.escape(n)}</span>`).join('')}
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
            return `${this.escape(k)}=${this.escape(String(val))}`;
        });
        let text = parts.join(', ');
        if (Object.keys(args).length > 3) text += ', …';
        return text;
    }

    createToolCard(name, args = {}) {
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
                    <span class="font-mono">${this.escape(name)}</span>
                </div>
                ${argSummary ? `<div class="assistant-tool-args">${argSummary}</div>` : ''}
            </div>
            <div class="assistant-tool-card-body" style="display:none;">
                <div class="assistant-tool-section">
                    <div class="assistant-tool-section-title">Arguments</div>
                    <pre>${this.escape(JSON.stringify(args, null, 2))}</pre>
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

    markToolRunning(card, isRunning) {
        if (!card) return;
        const dot = card.querySelector('.tool-status-dot');
        if (dot) dot.classList.toggle('animate-pulse', isRunning);
        card.classList.toggle('tool-running', isRunning);
        card.classList.toggle('tool-done', !isRunning);
    }

    fillToolResult(name, result, display, options = {}) {
        if (display && display.type === 'search') {
            const results = display.results || [];
            const resultsHtml = this.buildResultsHtml(results, display.result_count || results.length, { hideEmpty: false });
            this.fillSearchCard(display.query || '', resultsHtml);
            return null;
        }

        const silentTools = {
            add_class: true,
            add_attribute: true,
            add_connector: true,
            metadata_checker: true,
            reuse_check: true,
            style_guide_check: true,
            validator_check: true,
        };
        if (silentTools[name]) return null;

        const cards = this.messagesEl.querySelectorAll('[data-tool-name]');
        let card = null;
        for (let i = cards.length - 1; i >= 0; i--) {
            if (cards[i].dataset.toolName === name && !cards[i].dataset.filled) {
                card = cards[i];
                break;
            }
        }
        if (!card) card = this.createToolCard(name, {});
        card.dataset.filled = 'true';
        this.markToolRunning(card, false);
        const body = card.querySelector('.assistant-tool-card-body');
        const resultSection = card.querySelector('.assistant-tool-result-section');
        const resultContent = card.querySelector('.assistant-tool-result-content');
        const summary = options.toolSummary?.(result) || '';
        const summaryText = summary ? ` ${summary}` : '';
        const headerName = card.querySelector('.assistant-tool-name');
        if (headerName) {
            headerName.innerHTML = `
                <span class="w-1.5 h-1.5 rounded-full bg-green-600 tool-status-dot"></span>
                <span class="font-mono">${this.escape(name)}</span><span class="text-gray-500 font-normal ml-1">${summaryText}</span>
            `;
        }
        if (body) body.style.display = 'block';
        if (resultSection) resultSection.style.display = 'block';
        if (resultContent) resultContent.textContent = JSON.stringify(result, null, 2);
        this._scrollToBottom();
        return card;
    }

    appendProgressCard(cardId, toolName) {
        const label = AssistantRenderer.progressLabels[toolName] || toolName;
        const div = document.createElement('div');
        div.id = cardId;
        div.className = 'assistant-progress-card mb-4';
        div.dataset.progressCard = 'true';
        div.innerHTML = `
            <div class="assistant-progress-header">
                <svg class="text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
                <span>${this.escape(label)} en cours</span>
            </div>
            <div class="assistant-progress-body">
                <div class="assistant-progress-bar-bg">
                    <div class="assistant-progress-bar-fill" style="width:0%"></div>
                </div>
                <div class="assistant-progress-message"></div>
            </div>
        `;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    findProgressCard(cardId) {
        return this.messagesEl?.querySelector(`[id="${cardId}"]`) || null;
    }

    startFakeProgress(cardId, onLost) {
        const card = this.findProgressCard(cardId);
        if (!card) return;
        const fill = card.querySelector('.assistant-progress-bar-fill');
        card.dataset.realPercent = '0';
        let fakePercent = 0;
        let velocity = 0;
        let lastTime = performance.now();

        const step = (now) => {
            if (!this.findProgressCard(cardId)) return;
            const reported = parseInt(card.dataset.realPercent || '0', 10);
            const dt = Math.min((now - lastTime) / 1000, 0.5);
            lastTime = now;
            const headroom = reported > 0 ? Math.min(90, reported + 5) : 90;
            const distance = headroom - fakePercent;
            if (distance > 0) {
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

    stopFakeProgress(cardId) {
        const card = this.findProgressCard(cardId);
        if (!card) return;
        if (card._fakeProgressFrame) {
            cancelAnimationFrame(card._fakeProgressFrame);
            card._fakeProgressFrame = null;
        }
    }

    updateProgressCard(cardId, percent, message) {
        const card = this.findProgressCard(cardId);
        if (!card) return;
        const fill = card.querySelector('.assistant-progress-bar-fill');
        const msg = card.querySelector('.assistant-progress-message');
        card.dataset.realPercent = String(percent);
        if (fill) fill.style.width = `${percent}%`;
        if (msg) msg.textContent = message || '';
        this._scrollToBottom();
    }

    removeProgressStatus(cardId) {
        this.messagesEl.querySelectorAll(`[data-progress-status="${cardId}"]`).forEach((el) => {
            if (el.parentNode) el.remove();
        });
    }

    completeProgressCard(cardId) {
        const card = this.findProgressCard(cardId);
        if (!card) return;
        this.stopFakeProgress(cardId);
        const fill = card.querySelector('.assistant-progress-bar-fill');
        if (fill) {
            fill.style.transition = 'width 0.3s ease';
            fill.style.width = '100%';
        }
        card.classList.add('assistant-progress-done');
        this._scrollToBottom();
    }

    renderPlan(result, options = {}) {
        if (!result || typeof result !== 'object') return null;
        const parsed = (result.tool_results && typeof result.tool_results === 'object')
            ? result.tool_results
            : result;

        const planSteps = parsed.plan_steps || [];
        const toolsToCall = parsed.tools_to_call || [];
        let notes = parsed.notes || '';

        if (!Array.isArray(planSteps) || planSteps.length === 0) return null;

        const knownNames = options.knownNames || new Set();
        const displayForName = options.displayForName || ((n) => n);
        const TIMESTAMP_SUFFIX_RE = /[A-Za-z0-9_.\-]+__\d{16,20}\b/g;
        const cleanModelName = (text) => {
            if (typeof text !== 'string') return text;
            return text.replace(TIMESTAMP_SUFFIX_RE, (match) => knownNames.has(match) ? displayForName(match) : match);
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
                ${notes ? `<div class="assistant-plan-notes" style="display:none;">${this.escape(notes)}</div>` : ''}
            </div>
        `;
        const stepsList = div.querySelector('.assistant-plan-steps');
        const notesEl = div.querySelector('.assistant-plan-notes');

        planSteps.forEach((rawStep, index) => {
            const step = cleanStep(rawStep);
            const tool = toolsToCall.find((t) => t.step_index === index);
            const toolName = tool?.tool || '';
            const toolBadge = toolName ? `<span class="assistant-plan-tool-badge">${this.escape(toolName)}</span>` : '';
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
                    <div class="assistant-plan-step-text">${this.escape(stepText)}</div>
                    ${toolBadge}
                    ${needsTool ? '<span class="assistant-plan-uses-tool">nécessite un outil</span>' : ''}
                </div>
            `;
            stepsList.appendChild(li);
        });

        this.messagesEl.appendChild(div);
        this._scrollToBottom();

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

    appendSearchCard(query, resultsHtml) {
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
                <span class="assistant-search-query">${this.escape(query)}</span>
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

    fillSearchCard(query, resultsHtml) {
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
            target = this.appendSearchCard(query, resultsHtml);
            this.onUpdateSearchButtons();
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
        const queryEl = target.querySelector('.assistant-search-query');
        if (queryEl) queryEl.textContent = query;
        this.onUpdateSearchButtons();
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

    appendSvgCard(svgText, label = 'Visualisation du modèle') {
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

    updateCurrentSvgCard(svgText, label = 'Visualisation du modèle') {
        if (!svgText) return;
        if (!this.activeSvgCard || !this.activeSvgViewer) {
            this.appendSvgCard(svgText, label);
        } else {
            const state = this.activeSvgViewer.getState();
            this.activeSvgViewer.setSvg(svgText, '');
            this.activeSvgViewer.restoreState(state);
        }
        this._scrollToBottom();
    }

    freezeCurrentSvgCard() {
        if (this.activeSvgCard && this.activeSvgViewer) {
            this.activeSvgCard.dataset.svgFrozen = 'true';
        }
        this.activeSvgCard = null;
        this.activeSvgViewer = null;
    }

    get activeSvgFrozen() {
        return !!this.activeSvgCard?.dataset.svgFrozen;
    }
}

AssistantRenderer.progressLabels = {
    metadata_checker: 'Vérification des métadonnées',
    validator_check: 'Validation guide de style',
    reuse_check: 'Vérification de réutilisation',
    style_guide_check: 'Synthèse de la réponse',
};

window.AssistantRenderer = AssistantRenderer;
