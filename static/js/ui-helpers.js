/**
 * UiHelpers
 * Small reusable DOM/text helpers shared by all apps.
 * No app-specific logic should live here.
 */

const UiHelpers = {
    escape(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    displayNameFromStored(storedName) {
        if (!storedName) return '';
        if (storedName.includes('__')) {
            return storedName.split('__').slice(0, -1).join('__');
        }
        return storedName;
    },

    sparkleSvg() {
        return `<svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
            <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
            <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
            <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
        </svg>`;
    },

    setButtonLoading(btn, isLoading, originalHtml = '') {
        if (!btn) return;
        if (isLoading) {
            btn.disabled = true;
            btn.dataset.originalHtml = btn.innerHTML || '';
            btn.innerHTML = `
                <span class="inline-flex items-center gap-1.5">
                    <svg class="animate-spin w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Chargement...</span>
                </span>`;
        } else {
            btn.disabled = false;
            btn.innerHTML = originalHtml || btn.dataset.originalHtml || btn.textContent || 'Action';
            delete btn.dataset.originalHtml;
        }
    },

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    buildTagsHtml(tags, selectedTags = [], options = {}) {
        if (!tags || !tags.length) return '';
        const max = options.max || 12;
        const showAll = options.showAll || false;
        const visible = showAll ? tags : tags.slice(0, max);
        const remaining = showAll ? 0 : Math.max(0, tags.length - max);
        const selectedSet = new Set(selectedTags);
        const labelClass = options.labelClass || 'assistant-tag-label';
        const pillClass = options.pillClass || 'assistant-tag-pill';
        let html = visible.map((tag) => {
            const tagName = typeof tag === 'string' ? tag : (tag.name || tag.label || '');
            const isChecked = selectedSet.has(tagName) ? 'checked' : '';
            return `
                <label class="cursor-pointer select-none ${labelClass}" title="${UiHelpers.escape(tagName)}">
                    <input type="checkbox" name="assistant-tag" value="${UiHelpers.escape(tagName)}" class="peer hidden" ${isChecked}>
                    <span class="${pillClass}">${UiHelpers.escape(tagName)}</span>
                </label>`;
        }).join('');
        if (remaining > 0 && !showAll) {
            html += `<button type="button" class="assistant-tag-more" data-action="show-all-tags">+${remaining}</button>`;
        }
        return html;
    },

    centerContent(container, contentSelector, options = {}) {
        const content = contentSelector ? container.querySelector(contentSelector) : container.firstElementChild;
        if (!content) return;
        const styles = getComputedStyle(content);
        const marginTop = parseFloat(styles.marginTop) || 0;
        const marginBottom = parseFloat(styles.marginBottom) || 0;
        const contentHeight = content.getBoundingClientRect().height + marginTop + marginBottom;
        const available = Math.max(container.clientHeight, contentHeight);
        const offset = Math.max(0, (available - contentHeight) / 2);
        const skipTransition = options.skipTransition;
        if (skipTransition) content.style.transition = 'none';
        content.style.paddingTop = offset + 'px';
        if (skipTransition) {
            void content.offsetHeight;
            content.style.transition = '';
        }
    },

    markdownPreview(text) {
        if (!text) return '';
        let preview = String(text);
        if (preview.length > 600) preview = preview.slice(0, 600) + '…';

        const latexMap = {
            '\\\\rightarrow': '→', '\\\\leftarrow': '←', '\\\\leftrightarrow': '↔',
            '\\\\Rightarrow': '⇒', '\\\\Leftarrow': '⇐', '\\\\Leftrightarrow': '⇔',
            '\\\\leq': '≤', '\\\\geq': '≥', '\\\\neq': '≠', '\\\\approx': '≈',
            '\\\\in': '∈', '\\\\notin': '∉', '\\\\subset': '⊂', '\\\\cup': '∪', '\\\\cap': '∩',
            '\\\\forall': '∀', '\\\\exists': '∃', '\\\\land': '∧', '\\\\lor': '∨',
            '\\\\infty': '∞', '\\\\pm': '±', '\\\\times': '×', '\\\\cdot': '·',
            '\\\\alpha': 'α', '\\\\beta': 'β', '\\\\gamma': 'γ', '\\\\delta': 'δ',
            '\\\\lambda': 'λ', '\\\\mu': 'μ', '\\\\pi': 'π', '\\\\sigma': 'σ',
            '\\\\ldots': '…',
        };
        for (const [latex, uni] of Object.entries(latexMap)) {
            preview = preview.split(`$${latex}$`).join(uni).split(latex).join(uni);
        }
        preview = preview.replace(/\$([^$]{1,60})\$/g, '$1');

        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(preview, { breaks: true, headerIds: false, mangle: false });
        }
        return this.escape(preview).replace(/\n/g, '<br>');
    },

    /**
     * Build the HTML for a list of search results. The shape of each result
     * matches the normalized payload returned by api/routers/search.py and
     * assistant SSE tool_result events.
     */
    buildResultsHtml(results, count, options = {}) {
        const escape = UiHelpers.escape;
        if (!results.length) {
            return options.hideEmpty ? '' : `
                <div class="text-center py-20 text-black font-bold text-lg">
                    <p>Aucun document ne correspond à cette recherche.</p>
                </div>
            `;
        }
        let html = `<p id="results-header" class="text-xs font-bold text-gray-500 mb-5 border-b border-gray-200 pb-2">${count} RÉSULTAT(S)</p>`;
        for (const r of results) {
            const addButton = r.can_add_to_assistant ? `
                <button data-action="add-to-assistant" data-doc-id="${escape(r.chunk0_id)}" data-filename="${escape(r.filename)}" data-extension="${escape(r.extension)}" class="magic-btn search-add-model-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-500 hover:text-black focus:outline-none transition-colors" title="Ajouter au contexte de l'Assistant">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"></path></svg>
                </button>` : '';
            const previewButton = r.is_pdf ? '' : `
                <button data-action="preview" data-doc-id="${escape(r.chunk0_id)}" data-document-id="${escape(r.document_id || '')}" data-name="${escape(r.safe_filename)}" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-500 hover:text-black focus:outline-none transition-colors" title="Aperçu rapide">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                </button>`;
            const chatButton = `
                <button data-action="chat" data-document-id="${escape(r.document_id || '')}" data-name="${escape(r.safe_filename)}" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-400 hover:text-black focus:outline-none" title="Analyser avec l'IA">
                    <svg class="w-5 h-5 overflow-visible" viewBox="0 0 24 24">
                        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                    </svg>
                </button>`;
            html += `
            <div class="py-6 border-b border-gray-200 last:border-0 result-item">
                <h3 class="font-bold mb-2">
                    <a href="${escape(r.safe_filename)}?download=${escape(r.chunk0_id)}" target="_blank" class="text-black hover:text-blue-600 hover:underline transition-colors" title="Ouvrir le document">
                        ${escape(r.filename)}
                    </a>
                </h3>
                <div class="text-gray-800 font-medium leading-relaxed mb-3 markdown-body">${UiHelpers.markdownPreview(r.summary)}</div>
                <div class="flex items-center justify-between gap-2 text-xs text-gray-500 mb-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="font-bold">Score: ${r.score}</span>
                        <span>•</span>
                        <span>${escape((r.tags || []).join(' • ') || 'Aucun tag')}</span>
                    </div>
                    <div class="flex items-center gap-2 result-actions">
                        ${addButton}
                        ${previewButton}
                        ${chatButton}
                    </div>
                </div>
            </div>`;
        }
        return html;
    },
};

window.UiHelpers = UiHelpers;
