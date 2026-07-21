/**
 * GlowEffects
 * Réimplémentation fidèle de l'effet de glow radial qui suit la souris.
 * Gère .title-glow, .magic-btn, #submit-btn, .chat-send-btn, et les tags.
 */

const GlowEffects = (() => {
    let initialized = false;

    function updateGlow(element, clientX, clientY) {
        const rect = element.getBoundingClientRect();
        element.style.setProperty('--mouse-x', `${clientX - rect.left}px`);
        element.style.setProperty('--mouse-y', `${clientY - rect.top}px`);
    }

    function getGlowTarget(element) {
        // Tag labels: the span is the target (must come before closest checks)
        const tagLabel = element.closest('.tag-label');
        if (tagLabel) {
            const span = tagLabel.querySelector('.tag-glow');
            if (span) return span;
        }

        // Direct glow classes first
        if (element.classList.contains('magic-btn')) return element;
        if (element.classList.contains('chat-send-btn')) return element;
        if (element.id === 'submit-btn') return element;

        // Title glow: the glow element itself
        if (element.classList.contains('title-glow')) return element;

        // If hovering inside an interactive-title but not on the glow span itself
        const interactiveTitle = element.closest('.interactive-title');
        if (interactiveTitle) {
            const glow = interactiveTitle.querySelector('.title-glow');
            if (glow) return glow;
        }

        return null;
    }

    function getGlowSize(target) {
        if (target.id === 'submit-btn') return '30px';
        if (target.classList.contains('title-glow')) return '55px';
        if (target.classList.contains('tag-glow') || target.closest('.tag-label')) return '30px';
        if (target.classList.contains('chat-send-btn')) return '30px';
        return '40px';
    }

    function bindDynamicElement(el) {
        if (el.dataset.glowBound) return;
        el.dataset.glowBound = '1';
        el.addEventListener('mousemove', (e) => updateGlow(el, e.clientX, e.clientY));
        el.addEventListener('mouseenter', () => el.style.setProperty('--glow-size', getGlowSize(el)));
        el.addEventListener('mouseleave', () => el.style.setProperty('--glow-size', '0px'));
    }

    function scanAndBind() {
        document.querySelectorAll('.interactive-title, .title-glow, #submit-btn, .magic-btn, .chat-send-btn, .tag-label').forEach(el => {
            bindDynamicElement(el);
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;

        // Bind existing elements immediately
        scanAndBind();

        // Watch for new elements added to the DOM (dynamic re-renders)
        const observer = new MutationObserver(() => {
            scanAndBind();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    return { init, scanAndBind };
})();

window.GlowEffects = GlowEffects;
