/**
 * AssistantTypewriter
 * Encapsulates the character-by-character streaming display logic for the assistant.
 * Keeps AssistantApp focused on orchestration while this helper manages the timer,
 * buffer and DOM bubble.
 */

class AssistantTypewriter {
    constructor(options = {}) {
        this.charInterval = options.charInterval || 10;
        this.markdown = options.markdown || ((text) => text);
        this.adjustPadding = options.adjustPadding || (() => {});
        this.messagesEl = options.messagesEl || null;
        this.sparkleSvg = options.sparkleSvg || (() => '');
        this.renderer = options.renderer || null;
        this._buffer = '';
        this._displayed = '';
        this._timerId = null;
        this._running = false;
        this._currentBubbleContent = null;
    }

    _ensureBubble() {
        if (this._currentBubbleContent) return this._currentBubbleContent;
        if (this.renderer) {
            this.renderer.removeThinkingPlaceholder();
            this.renderer.closeAssistantBubble();
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
        this._currentBubbleContent = wrapper.querySelector('.assistant-bubble-content');
        return this._currentBubbleContent;
    }

    start() {
        if (this._timerId) return;
        this._running = true;
        this._timerId = setInterval(() => {
            if (this._buffer.length === 0) return;
            const chunkSize = Math.min(3 + Math.floor(Math.random() * 8), this._buffer.length);
            this._displayed += this._buffer.slice(0, chunkSize);
            this._buffer = this._buffer.slice(chunkSize);
            const bubble = this._ensureBubble();
            if (bubble) {
                bubble.innerHTML = this.markdown(this._displayed, false);
            }
            this.adjustPadding();
        }, this.charInterval);
    }

    stop() {
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
        this._running = false;
    }

    flush() {
        this.stop();
        if (this._buffer.length > 0) {
            this._displayed += this._buffer;
            this._buffer = '';
        }
        const bubble = this._ensureBubble();
        if (bubble) {
            bubble.innerHTML = this.markdown(this._displayed, false);
        }
        this.adjustPadding();
    }

    reset() {
        this.stop();
        this._displayed = '';
        this._buffer = '';
        this._currentBubbleContent = null;
    }

    append(text) {
        this._buffer += text;
    }

    get displayedText() {
        return this._displayed;
    }
}

window.AssistantTypewriter = AssistantTypewriter;
