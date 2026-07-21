/**
 * GlowEffects
 * Réimplémentation de l'effet de glow radial qui suit la souris.
 * Gère .title-glow, .magic-btn, #submit-btn, .chat-send-btn, et les tags.
 */

const GlowEffects = (() => {
    let initialized = false;

    function updateGlow(element, clientX, clientY) {
        const rect = element.getBoundingClientRect();
        element.style.setProperty('--mouse-x', `${clientX - rect.left}px`);
        element.style.setProperty('--mouse-y', `${clientY - rect.top}px`);
    }

    function findGlowTarget(element) {
        // Title glow: the glow is inside .interactive-title
        const interactiveTitle = element.closest('.interactive-title');
        if (interactiveTitle) {
            const glow = interactiveTitle.querySelector('.title-glow');
            if (glow) return glow;
        }
        // Direct glow classes
        if (element.classList.contains('magic-btn')) return element;
        if (element.classList.contains('chat-send-btn')) return element;
        if (element.id === 'submit-btn') return element;
        // Tag labels: the span is the target
        const tagLabel = element.closest('.tag-label');
        if (tagLabel) {
            const span = tagLabel.querySelector('span');
            if (span) return span;
        }
        return null;
    }

    function init() {
        if (initialized) return;
        initialized = true;

        document.addEventListener('mousemove', (e) => {
            const target = findGlowTarget(e.target);
            if (target) updateGlow(target, e.clientX, e.clientY);
        });

        document.addEventListener('mouseenter', (e) => {
            const target = findGlowTarget(e.target);
            if (!target) return;
            const size = target.id === 'submit-btn' ? '30px'
                : target.classList.contains('title-glow') ? '55px'
                : target.closest('.tag-label') ? '30px'
                : target.classList.contains('chat-send-btn') ? '30px'
                : '40px';
            target.style.setProperty('--glow-size', size);
        }, true);

        document.addEventListener('mouseleave', (e) => {
            const target = findGlowTarget(e.target);
            if (target) target.style.setProperty('--glow-size', '0px');
        }, true);
    }

    return { init };
})();

window.GlowEffects = GlowEffects;
