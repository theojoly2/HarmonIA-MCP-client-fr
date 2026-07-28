/**
 * UI utilities: draggable, resizable, clamping, z-index management.
 */

const UiUtils = (() => {
    function makeDraggable(header, win, options = {}) {
        let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
        const onStart = (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = win.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            if (options.onStart) options.onStart();
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!isDragging) return;
            const vw = window.innerWidth, vh = window.innerHeight;
            const rect = win.getBoundingClientRect();
            const minVisible = options.minVisible || 60;
            let left = initialLeft + (e.clientX - startX);
            let top = initialTop + (e.clientY - startY);
            // Keep the entire window visible horizontally and at the top.
            left = Math.max(0, Math.min(vw - rect.width, left));
            top = Math.max(0, top);
            // Keep at least minVisible pixels visible at the bottom edge.
            top = Math.min(vh - minVisible, top);
            win.style.left = left + 'px';
            win.style.top = top + 'px';
            win.style.transform = 'none';
        };
        const onEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            if (options.onEnd) options.onEnd();
        };
        header.addEventListener('mousedown', onStart);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onEnd);
        return () => {
            header.removeEventListener('mousedown', onStart);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onEnd);
        };
    }

    function makeResizable(win, handle, options = {}) {
        let isResizing = false, startX = 0, startY = 0, initialW = 0, initialH = 0;
        const onStart = (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = win.getBoundingClientRect();
            initialW = rect.width;
            initialH = rect.height;
            if (options.onStart) options.onStart();
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!isResizing) return;
            const vw = window.innerWidth, vh = window.innerHeight;
            const rect = win.getBoundingClientRect();
            const minVisible = options.minVisible || 60;
            // Hard clamp: the window edges must stay inside the viewport.
            // Right edge cannot go past vw, bottom edge cannot go past vh.
            const maxW = Math.max(minVisible, vw - rect.left);
            const maxH = Math.max(minVisible, vh - rect.top);
            let w = Math.max(options.minWidth || 320, initialW + (e.clientX - startX));
            let h = Math.max(options.minHeight || 200, initialH + (e.clientY - startY));
            w = Math.min(w, maxW);
            h = Math.min(h, maxH);
            win.style.width = w + 'px';
            win.style.height = h + 'px';
            if (options.onResize) options.onResize(w, h);
        };
        const onEnd = () => {
            if (!isResizing) return;
            isResizing = false;
            if (options.onEnd) options.onEnd();
        };
        handle.addEventListener('mousedown', onStart);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onEnd);
        return () => {
            handle.removeEventListener('mousedown', onStart);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onEnd);
        };
    }

    function clampWindowPosition(win, minVisible = 60) {
        const rect = win.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let left = rect.left, top = rect.top;
        // Keep the entire window visible horizontally and at the top.
        left = Math.max(0, Math.min(vw - rect.width, left));
        top = Math.max(0, top);
        // Keep at least minVisible pixels visible at the bottom edge.
        top = Math.min(vh - minVisible, top);
        win.style.left = left + 'px';
        win.style.top = top + 'px';
        win.style.transform = 'none';
    }

    function clampWindowSize(win, options = {}) {
        const rect = win.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const minVisible = options.minVisible || 60;
        const minWidth = options.minWidth || 320;
        const minHeight = options.minHeight || 200;
        const maxW = Math.max(minWidth, Math.max(minVisible, vw - rect.left));
        const maxH = Math.max(minHeight, Math.max(minVisible, vh - rect.top));
        let w = Math.max(minWidth, Math.min(rect.width, maxW));
        let h = Math.max(minHeight, Math.min(rect.height, maxH));
        win.style.width = w + 'px';
        win.style.height = h + 'px';
        return { width: w, height: h };
    }

    function centerWindow(win, offsetX = 0, offsetY = 0) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const rect = win.getBoundingClientRect();
        let left = (vw - rect.width) / 2 + offsetX;
        let top = (vh - rect.height) / 2 + offsetY;
        win.style.left = left + 'px';
        win.style.top = top + 'px';
        win.style.transform = 'none';
        clampWindowPosition(win);
    }

    function createFloatingWindow({ title = '', fileName = '', icon = '', width = 800, height = 600, onClose, onFocus, onResizeStart, onResize, onResizeEnd }) {
        const win = document.createElement('div');
        win.className = 'floating-window';
        win.style.width = width + 'px';
        if (height && height !== 'auto') {
            win.style.height = height + 'px';
        } else if (height === 'auto') {
            win.style.height = 'auto';
        }
        win.style.top = '50%';
        win.style.left = '50%';
        win.style.transform = 'translate(-50%, -50%)';
        const fileLabel = fileName ? `<span class="window-file font-medium text-gray-500 text-xs truncate max-w-[12rem]">${fileName}</span>` : '';
        win.innerHTML = `
            <div class="window-header">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="window-icon">${icon}</span>
                    <div class="min-w-0 flex flex-col items-start leading-tight">
                        <h3 class="window-title font-bold text-gray-900 text-sm">${title}</h3>
                        ${fileLabel}
                    </div>
                </div>
                <button class="window-close magic-btn text-gray-400 hover:text-black p-1.5 rounded-full transition-colors focus:outline-none flex-shrink-0" title="Fermer">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="window-body flex-1 relative overflow-hidden"></div>
            <div class="resize-handle"></div>
        `;
        // Caller is responsible for appending the window to the desired container.
        const header = win.querySelector('.window-header');
        const closeBtn = win.querySelector('.window-close');
        const handle = win.querySelector('.resize-handle');
        const dragCleanup = makeDraggable(header, win, {
            onStart: () => { if (onFocus) onFocus(); }
        });
        const resizeCleanup = makeResizable(win, handle, {
            minWidth: 320,
            minHeight: 200,
            onStart: () => { if (onFocus) onFocus(); if (onResizeStart) onResizeStart(); },
            onResize: (w, h) => { if (onResize) onResize(w, h); },
            onEnd: () => { if (onResizeEnd) onResizeEnd(); }
        });
        closeBtn.addEventListener('click', () => {
            if (onClose) onClose();
            dragCleanup();
            resizeCleanup();
            win.remove();
        });
        win.addEventListener('mousedown', () => { if (onFocus) onFocus(); });
        return {
            win,
            body: win.querySelector('.window-body'),
            setTitle: (t) => { win.querySelector('.window-title').textContent = t; },
            setFileName: (name) => {
                let label = win.querySelector('.window-file');
                if (name) {
                    if (!label) {
                        const titleEl = win.querySelector('.window-title');
                        const container = titleEl.parentElement;
                        label = document.createElement('span');
                        label.className = 'window-file font-medium text-gray-500 text-xs truncate max-w-[12rem]';
                        container.appendChild(label);
                    }
                    label.textContent = name;
                } else if (label) {
                    label.remove();
                }
            }
        };
    }

    return {
        makeDraggable,
        makeResizable,
        clampWindowPosition,
        clampWindowSize,
        centerWindow,
        createFloatingWindow,
    };
})();

window.UiUtils = UiUtils;
