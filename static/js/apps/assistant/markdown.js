/**
 * AssistantMarkdown
 * Pure helper for assistant LaTeX stripping, sparkle SVG and markdown rendering.
 * No DOM state; it only reads text and returns HTML.
 */

const AssistantMarkdown = (() => {
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

    function sparkleSvg() {
        return `
            <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
            </svg>
        `;
    }

    function stripLatexText(label) {
        if (!label) return '';
        return label.replace(/\\text\{([^{}]*)\}/g, '$1').trim();
    }

    function preprocessLatex(text) {
        if (!text) return '';
        const balancedArg = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
        text = text.replace(
            new RegExp('\\\\xrightarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = stripLatexText(label).trim();
                return clean ? `${clean} →` : '→';
            }
        );
        text = text.replace(
            new RegExp('\\\\xleftarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = stripLatexText(label).trim();
                return clean ? `← ${clean}` : '←';
            }
        );
        text = text.replace(
            new RegExp('\\\\xleftrightarrow' + balancedArg.source, 'g'),
            (_, label) => {
                const clean = stripLatexText(label).trim();
                return clean ? `↔ ${clean}` : '↔';
            }
        );
        const latexRegex = /\\([A-Za-z]+|\$)/g;
        text = text.replace(latexRegex, (match, command) => {
            if (command === '$') return '';
            return latexMap[command] !== undefined ? latexMap[command] : match;
        });
        text = text.replace(/\$([^$]+)\$/g, '$1');
        return text;
    }

    function markdown(text, escapeFn, streaming = false) {
        if (!text) return '';
        if (typeof marked === 'undefined') {
            return escapeFn(text).replace(/\n/g, '<br>');
        }
        if (streaming) {
            return escapeFn(text).replace(/\n/g, '<br>');
        }
        return marked.parse(preprocessLatex(text), { breaks: true, gfm: true });
    }

    return {
        sparkleSvg,
        stripLatexText,
        preprocessLatex,
        markdown,
    };
})();

window.AssistantMarkdown = AssistantMarkdown;
