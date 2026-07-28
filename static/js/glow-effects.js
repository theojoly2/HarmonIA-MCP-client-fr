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
        // Direct glow classes first
        if (element.id === 'submit-btn') return element;
        if (element.classList.contains('chat-send-btn')) return element;

        // Shell buttons: history toggle, user menu, app tabs, login button
        if (element.id === 'history-toggle' || element.classList.contains('shell-user-menu-btn') || element.classList.contains('shell-action-btn')) {
            return element;
        }
        const navTab = element.closest('.nav-tab');
        if (navTab) return navTab;

        // Title glow: the glow element itself
        if (element.classList.contains('title-glow')) return element;

        // If hovering inside an interactive-title but not on the glow span itself
        const interactiveTitle = element.closest('.interactive-title');
        if (interactiveTitle) {
            const glow = interactiveTitle.querySelector('.title-glow');
            if (glow) return glow;
        }

        // Tag labels: the span is the target (events are attached to the label)
        const tagLabel = element.closest('.tag-label');
        if (tagLabel) {
            const span = tagLabel.querySelector('span');
            if (span) return span;
        }

        return null;
    }

    function getGlowSize(target) {
        if (target.id === 'submit-btn') return '30px';
        if (target.id === 'login-btn') return '30px';
        if (target.classList.contains('title-glow')) return '55px';
        if (target.closest('.tag-label')) return '30px';
        if (target.classList.contains('chat-send-btn')) return '30px';
        if (target.classList.contains('shell-tag-style')) return '40px';
        if (target.classList.contains('shell-submit-style')) return '30px';
        return '55px';
    }

    function bindDynamicElement(el, targetOverride = null) {
        if (el.dataset.glowBound) return;
        el.dataset.glowBound = '1';
        const target = targetOverride || el;
        el.addEventListener('mousemove', (e) => updateGlow(target, e.clientX, e.clientY));
        el.addEventListener('mouseenter', () => target.style.setProperty('--glow-size', getGlowSize(target)));
        el.addEventListener('mouseleave', () => target.style.setProperty('--glow-size', '0px'));
    }

    function scanAndBind() {
        document.querySelectorAll('.interactive-title, .title-glow, #submit-btn, .chat-send-btn, #login-btn').forEach(el => {
            bindDynamicElement(el);
        });
        // Shell buttons (with .shell-glow marker class for explicit selection)
        document.querySelectorAll('.shell-glow').forEach(el => {
            bindDynamicElement(el);
        });
        // Tags: attach listeners to the label, but update the span's CSS variables
        document.querySelectorAll('.tag-label').forEach(label => {
            const span = label.querySelector('span');
            if (!span) return;
            bindDynamicElement(label, span);
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
