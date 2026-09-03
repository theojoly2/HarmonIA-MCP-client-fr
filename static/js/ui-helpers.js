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
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                </button>`;
            html += `
            <div class="py-6 border-b border-gray-200 last:border-0 result-item">
                <h3 class="font-bold mb-2">
                    <a href="${escape(r.safe_filename)}?download=${escape(r.chunk0_id)}" target="_blank" class="text-black hover:text-blue-600 hover:underline transition-colors" title="Ouvrir le document">
                        ${escape(r.filename)}
                    </a>
                </h3>
                <div class="text-gray-800 font-medium leading-relaxed mb-3 markdown-body">${UiHelpers.markdownPreview(r.summary)}</div>
                <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-3">
                    <span class="font-bold">Score: ${r.score}</span>
                    <span>•</span>
                    <span>${escape((r.tags || []).join(' • ') || 'Aucun tag')}</span>
                </div>
                <div class="flex items-center gap-2 result-actions">
                    ${addButton}
                    ${previewButton}
                    ${chatButton}
                </div>
            </div>`;
        }
        return html;
    },
};

window.UiHelpers = UiHelpers;
