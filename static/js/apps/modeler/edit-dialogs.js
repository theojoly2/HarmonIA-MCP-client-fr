/**
 * ModelerEditDialogs
 * Helper for modeler edit floating dialogs and mutation requests.
 * Stateless except for the bound app instance it receives.
 */

const ModelerEditDialogs = (() => {
    function closeOpenDialogs() {
        document.querySelectorAll('.modeler-edit-float').forEach((dialog) => dialog.remove());
    }

    function hasOpenDialog() {
        return document.querySelectorAll('.modeler-edit-float').length > 0;
    }

    function syncScroll(win) {
        const body = win.querySelector('.window-body');
        if (!body) return;
        const scrollArea = body.querySelector('.modeler-edit-body');
        if (scrollArea) {
            scrollArea.style.maxHeight = (body.clientHeight) + 'px';
        }
        body.style.height = (win.clientHeight - (win.querySelector('.window-header')?.offsetHeight || 40) - (win.querySelector('.resize-handle')?.offsetHeight || 0)) + 'px';
    }

    function escape(text) {
        return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showFloatingDialog({ title, fields, onSubmit, onOpen }) {
        closeOpenDialogs();

        const floatWin = UiUtils.createFloatingWindow({
            title,
            width: 420,
            height: 520,
            onClose: () => {},
            onFocus: () => {},
            onResize: () => { syncScroll(floatWin.win); },
            onResizeEnd: () => { syncScroll(floatWin.win); }
        });
        floatWin.win.classList.add('modeler-edit-float');
        floatWin.win.style.minHeight = '260px';
        floatWin.win.style.maxHeight = '85vh';
        const root = document.getElementById('floating-root') || document.body;
        root.appendChild(floatWin.win);
        const baseTop = 160;
        const floatRect = floatWin.win.getBoundingClientRect();
        const left = (window.innerWidth - floatRect.width) / 2;
        floatWin.win.style.left = left + 'px';
        floatWin.win.style.top = baseTop + 'px';
        floatWin.win.style.transform = 'none';
        UiUtils.clampWindowPosition(floatWin.win);

        const body = floatWin.body;
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.overflow = 'hidden';
        const optionsHtml = (opts) => opts || '';
        const infoIcon = (help) => help ? `<span class="modeler-field-help" title="${escape(help)}">i</span>` : '';
        const inputsHtml = fields.map((f) => {
            const label = `<label class="block text-sm font-semibold text-gray-700 mb-1 ${escape(f.labelClass || '')}" for="${f.id}"><span class="flex items-center gap-1.5">${escape(f.label)}${f.required ? ' *' : ''}${infoIcon(f.help)}</span></label>`;
            let input;
            if (f.type === 'textarea') {
                input = `<textarea id="${f.id}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none" rows="3" ${f.required ? 'required' : ''}>${escape(f.value || '')}</textarea>`;
            } else if (f.type === 'select') {
                input = `<select id="${f.id}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none bg-white" ${f.required ? 'required' : ''}>${optionsHtml(f.options)}</select>`;
            } else {
                input = `<input type="text" id="${f.id}" value="${escape(f.value || '')}" class="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-black outline-none" ${f.required ? 'required' : ''}>`;
            }
            return `<div class="mb-3 ${escape(f.className || '')}">${label}${input}</div>`;
        }).join('');
        body.innerHTML = `
            <div class="modeler-edit-body" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 1.25rem;">
                <form id="modeler-edit-form">
                    ${inputsHtml}
                    <div class="modeler-edit-error hidden" id="dialog-error"></div>
                    <button type="submit" class="modeler-edit-submit">Enregistrer</button>
                </form>
            </div>
        `;
        requestAnimationFrame(() => syncScroll(floatWin.win));

        const form = body.querySelector('#modeler-edit-form');
        const submitBtn = body.querySelector('.modeler-edit-submit');

        if (onOpen) {
            onOpen(body);
        }

        const close = () => floatWin.win.remove();
        const closeBtn = floatWin.win.querySelector('.window-close');
        if (closeBtn) closeBtn.addEventListener('click', close);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            // Dynamically toggle required attributes for conditional fields
            fields.forEach((f) => {
                if (f.requiredWhenVisible) {
                    const wrapper = body.querySelector(`#${f.id}`)?.closest('.mb-3');
                    const el = body.querySelector(`#${f.id}`);
                    if (wrapper && el) {
                        const visible = !wrapper.classList.contains('hidden');
                        if (visible) {
                            el.setAttribute('required', '');
                        } else {
                            el.removeAttribute('required');
                        }
                    }
                }
            });
            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }
            const values = {};
            fields.forEach((f) => {
                const el = body.querySelector(`#${f.id}`);
                values[f.id] = el ? el.value.trim() : '';
            });
            submitBtn.disabled = true;
            submitBtn.textContent = 'Enregistrement...';
            Promise.resolve(onSubmit(values, body)).then(close).catch((err) => {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Enregistrer';
                const errorEl = body.querySelector('#dialog-error');
                if (errorEl) {
                    errorEl.textContent = err.message || 'Une erreur est survenue.';
                    errorEl.classList.remove('hidden');
                }
            });
        });
    }

    async function applyMutation(app, endpoint, overlay, body, fallbackMessage) {
        const submitBtn = overlay.querySelector('.modeler-edit-submit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Enregistrement...';
        }
        try {
            app._setLoading(true);
            await ModelGateway.applyMutation(app.storedName || app.fileName, endpoint, body);
            EventBus.emit('modeler:reload-svg', { instanceId: app.instanceId });
        } catch (err) {
            console.error(`Mutation ${endpoint} error`, err);
            alert(err.message || fallbackMessage);
        } finally {
            app._setLoading(false);
            if (submitBtn && overlay.parentNode) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Enregistrer';
            }
        }
    }

    return {
        closeOpenDialogs,
        hasOpenDialog,
        showFloatingDialog,
        applyMutation,
        escape,
    };
})();

window.ModelerEditDialogs = ModelerEditDialogs;
