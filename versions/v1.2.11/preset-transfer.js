import { renderTextDifference } from './compare-diff.js';

export function createPresetTransferModule(deps) {
    const { host, getContext, deepClone, notify, renderPanel, getRoot, escapeHTML, infoButton, requestDialog } = deps;

    let presetTransferLoading = false;
    let presetTransferLoadedOnce = false;
    let presetTransferSource = '';
    let presetTransferTarget = '';
    let presetTransferModeValue = 'single';
    let presetTransferLoadModeValue = 'all';
    let presetTransferSourceEntries = [];
    let presetTransferTargetEntries = [];
    let presetTransferSourceDocument = null;
    let presetTransferTargetDocument = null;
    let presetTransferSelected = new Set();
    let presetTransferSearch = '';
    let presetTransferVisibleLimit = 120;
    let presetTransferError = '';
    let presetTransferAnchor = { kind: 'top', anchorId: '' };
    let presetTransferDraft = null;
    let presetCompareOpen = false;

    function getPresetTransferManager() {
        const context = getContext();
        const getter = context.getPresetManager || host.SillyTavern?.getPresetManager || host.getPresetManager;
        if (typeof getter !== 'function') throw new Error('酒馆没有提供可用的预设管理接口');
        const manager = getter.call(context, 'openai');
        if (!manager) throw new Error('没有找到 Chat Completion 预设管理器，请先切换到可用的聊天补全接口');
        return manager;
    }
    
    function presetTransferNames(manager) {
        if (typeof manager.getAllPresets === 'function') {
            const names = manager.getAllPresets();
            if (Array.isArray(names)) return [...new Set(names.map(String).filter(Boolean))];
        }
        const list = manager.getPresetList?.('openai') || {};
        if (Array.isArray(list.preset_names)) return list.preset_names.map(String).filter(Boolean);
        return Object.keys(list.preset_names || {});
    }
    
    async function loadPresetTransferDocument(manager, name) {
        let data;
        if (typeof manager.getCompletionPresetByName === 'function') data = await manager.getCompletionPresetByName(name);
        if (!data && typeof manager.getPresetList === 'function') {
            const list = manager.getPresetList('openai') || {};
            const names = list.preset_names || [];
            const index = Array.isArray(names) ? names.indexOf(name) : names[name];
            if (index !== undefined && index !== -1) data = list.presets?.[index];
        }
        if (!data) throw new Error(`无法读取预设“${name}”`);
        return deepClone(data);
    }
    
    /*
     * 预设条目模型
     *
     * SillyTavern 的 Chat Completion 预设有两个容易混淆的数组：
     *   prompts: 条目实体
     *   prompt_order: 多组发送顺序，其中 character_id=100001 才是主顺序。
     *
     * 插入和移动只操作主顺序；删除时清理其它组中已经失效的引用。
     */
    function presetTransferEntryMatchesLoadMode(entry) {
        return presetTransferLoadModeValue === 'all' || Boolean(entry?.inserted && entry?.enabled);
    }
    
    function presetEntryArrayInfo(document) {
        if (Array.isArray(document?.prompts)) return { key: 'prompts', entries: document.prompts };
        if (Array.isArray(document?.entries)) return { key: 'entries', entries: document.entries };
        throw new Error('所选预设没有可转移的提示词条目');
    }
    
    function presetRawIdentifier(raw, index = 0) {
        if (raw && typeof raw === 'object') {
            const value = raw.identifier ?? raw.id ?? raw.uid;
            if (value !== undefined && value !== null && String(value)) return String(value);
        }
        return `entry-${index}`;
    }
    
    function presetMainPromptOrder(document, create = false) {
        if (!Array.isArray(document?.prompt_order)) {
            if (!create) return null;
            document.prompt_order = [];
        }
        let group = document.prompt_order.find((item) => Number(item?.character_id) === 100001);
        if (!group && create) {
            group = { character_id: 100001, order: [] };
            document.prompt_order.unshift(group);
        }
        if (group && !Array.isArray(group.order)) group.order = [];
        return group || null;
    }
    
    function presetSetRawIdentifier(raw, id, key = 'prompts') {
        if (!raw || typeof raw !== 'object') return;
        if (key === 'prompts' || Object.prototype.hasOwnProperty.call(raw, 'identifier') || !('id' in raw && !('uid' in raw))) {
            raw.identifier = String(id);
            if (key !== 'prompts' && Object.prototype.hasOwnProperty.call(raw, 'id')) delete raw.id;
            return;
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'id')) raw.id = String(id);
        else raw.uid = String(id);
    }
    
    function presetEntryDisplayContent(raw) {
        if (!raw || typeof raw !== 'object') return String(raw ?? '');
        const value = raw.content ?? raw.prompt ?? raw.text ?? '';
        return typeof value === 'string' ? value : JSON.stringify(value);
    }
    
    function presetEntryDisplayName(raw, index = 0) {
        if (!raw || typeof raw !== 'object') return `条目 ${index + 1}`;
        return String(raw.name || raw.comment || raw.title || raw.identifier || raw.id || `条目 ${index + 1}`);
    }
    
    function presetTransferRecords(document) {
        const { entries } = presetEntryArrayInfo(document);
        const byId = new Map();
        entries.forEach((raw, index) => {
            const value = raw && typeof raw === 'object' ? raw : { content: String(raw ?? '') };
            const id = presetRawIdentifier(value, index);
            // Malformed presets occasionally contain duplicate identifiers. Keep the
            // first one addressable and give the later row a deterministic display id.
            if (!byId.has(id)) byId.set(id, { raw: value, index });
            else byId.set(`${id}#${index}`, { raw: value, index });
        });
        const records = [];
        const seen = new Set();
        const main = presetMainPromptOrder(document, false);
        const append = (raw, index, id, orderItem, inserted) => {
            const safeId = String(id);
            const content = presetEntryDisplayContent(raw);
            records.push({
                id: safeId,
                raw: deepClone(raw),
                name: presetEntryDisplayName(raw, index),
                content,
                marker: Boolean(raw?.marker),
                enabled: orderItem ? orderItem.enabled !== false : raw?.enabled !== false,
                inserted: Boolean(inserted),
            });
        };
        if (main?.order?.length) {
            main.order.forEach((orderItem) => {
                const id = String(orderItem?.identifier ?? orderItem?.id ?? orderItem?.uid ?? '');
                if (!id || seen.has(id)) return;
                const found = byId.get(id);
                if (!found) return;
                append(found.raw, found.index, id, orderItem, true);
                seen.add(id);
            });
        }
        // Entries not present in the main order remain editable, but are shown after
        // the effective order so they can be deliberately inserted at an anchor.
        entries.forEach((raw, index) => {
            const id = presetRawIdentifier(raw, index);
            if (seen.has(id)) return;
            append(raw, index, id, null, false);
            seen.add(id);
        });
        return records;
    }
    
    function uniquePresetIdentifier(raw, existing) {
        const original = presetRawIdentifier(raw, 0);
        let id = original || `ctb-prompt-${Date.now().toString(36)}`;
        if (!existing.has(id)) {
            existing.add(id);
            return id;
        }
        const base = id.replace(/-copy-\d+$/, '').replace(/-\d+$/, '') || 'ctb-prompt';
        let counter = 2;
        while (existing.has(`${base}-copy-${counter}`)) counter += 1;
        id = `${base}-copy-${counter}`;
        existing.add(id);
        return id;
    }
    
    function uniquePresetName(raw, existingNames) {
        const original = presetEntryDisplayName(raw, 0) || '未命名条目';
        if (!existingNames.has(original)) {
            existingNames.add(original);
            return original;
        }
        let counter = 2;
        let name = `${original}（副本）`;
        while (existingNames.has(name)) name = `${original}（副本 ${counter++}）`;
        existingNames.add(name);
        return name;
    }
    
    function presetOrderIdentifier(item) {
        return String(item?.identifier ?? item?.id ?? item?.uid ?? '');
    }
    
    function addPresetPromptOrder(document, identifier, enabled = true, anchor = { kind: 'top', anchorId: '' }) {
        const group = presetMainPromptOrder(document, true);
        if (!group) return;
        const id = String(identifier);
        group.order = group.order.filter((item) => presetOrderIdentifier(item) !== id);
        const item = { identifier: id, enabled: enabled !== false };
        let index = anchor?.kind === 'after' && anchor.anchorId ? group.order.length : 0;
        if (anchor?.kind === 'after' && anchor.anchorId) {
            const anchorIndex = group.order.findIndex((entry) => presetOrderIdentifier(entry) === String(anchor.anchorId));
            if (anchorIndex >= 0) index = anchorIndex + 1;
        }
        group.order.splice(index, 0, item);
    }
    
    function addPresetPromptOrders(document, items, anchor = { kind: 'top', anchorId: '' }) {
        const group = presetMainPromptOrder(document, true);
        if (!group) return;
        const ids = new Set(items.map((item) => String(item.identifier)));
        group.order = group.order.filter((item) => !ids.has(presetOrderIdentifier(item)));
        let index = anchor?.kind === 'after' && anchor.anchorId ? group.order.length : 0;
        if (anchor?.kind === 'after' && anchor.anchorId) {
            const anchorIndex = group.order.findIndex((entry) => presetOrderIdentifier(entry) === String(anchor.anchorId));
            if (anchorIndex >= 0) index = anchorIndex + 1;
        }
        group.order.splice(index, 0, ...items.map((item) => ({
            identifier: String(item.identifier),
            enabled: item.enabled !== false,
        })));
    }
    
    function removePresetPromptOrder(document, identifiers) {
        const set = new Set([...identifiers].map(String));
        if (!Array.isArray(document?.prompt_order)) return;
        for (const orderGroup of document.prompt_order) {
            if (Array.isArray(orderGroup?.order)) {
                orderGroup.order = orderGroup.order.filter((item) => !set.has(presetOrderIdentifier(item)));
            }
        }
    }
    
    function presetAnchorForOperation() {
        const anchor = presetTransferAnchor || { kind: 'top', anchorId: '' };
        if (anchor.kind !== 'after' || !anchor.anchorId) return { kind: 'top', anchorId: '' };
        if (presetTransferSelected.has(String(anchor.anchorId))) {
            return { kind: 'top', anchorId: '' };
        }
        return { kind: 'after', anchorId: String(anchor.anchorId) };
    }
    
    function presetSelectedRecords() {
        const selected = presetTransferSourceEntries.filter((entry) => presetTransferSelected.has(String(entry.id)));
        // Marker rows are structural entries, not user-transferable prompts.
        return selected.filter((entry) => !entry.marker);
    }
    
    function presetInsertIndex(order, anchor) {
        if (anchor?.kind === 'top') return 0;
        if (anchor?.kind === 'after' && anchor.anchorId) {
            const index = order.findIndex((item) => presetOrderIdentifier(item) === String(anchor.anchorId));
            if (index >= 0) return index + 1;
        }
        return 0;
    }
    
    function verifyPresetOperation(document, ids, { requireOrder = true } = {}) {
        const expected = new Set([...ids].map(String));
        const records = presetTransferRecords(document);
        const actual = new Set(records.map((entry) => String(entry.id)));
        for (const id of expected) if (!actual.has(id)) throw new Error(`保存校验失败：条目 ${id} 不存在`);
        if (requireOrder) {
            const order = presetMainPromptOrder(document, false)?.order || [];
            const orderIds = new Set(order.map(presetOrderIdentifier));
            for (const id of expected) if (!orderIds.has(id)) throw new Error(`保存校验失败：条目 ${id} 未进入主发送顺序`);
        }
        return document;
    }
    
    async function savePresetTransferDocument(manager, name, document) {
        if (typeof manager.savePreset !== 'function') throw new Error('当前预设管理器不支持保存');
        const next = deepClone(document);
        await manager.savePreset(name, next, { skipUpdate: true });
        const list = manager.getPresetList?.('openai') || {};
        const names = list.preset_names || [];
        const index = Array.isArray(names) ? names.indexOf(name) : names[name];
        if (index !== undefined && index !== -1 && Array.isArray(list.presets)) {
            list.presets[index] = deepClone(next);
        }
        const verify = await loadPresetTransferDocument(manager, name);
        presetEntryArrayInfo(verify);
        return verify;
    }
    
    async function loadPresetTransfer({ force = false } = {}) {
        if (presetTransferLoading && !force) return;
        presetTransferLoading = true;
        presetTransferError = '';
        renderPanel();
        try {
            const manager = getPresetTransferManager();
            const names = presetTransferNames(manager);
            if (!names.length) throw new Error('没有读取到可用预设');
            presetTransferSource = names.includes(presetTransferSource) ? presetTransferSource : names[0];
            if (presetTransferModeValue === 'single') {
                presetTransferTarget = '';
            } else {
                presetTransferTarget = names.includes(presetTransferTarget) && presetTransferTarget !== presetTransferSource
                    ? presetTransferTarget
                    : (names.find((name) => name !== presetTransferSource) || '');
            }
            presetTransferSourceDocument = await loadPresetTransferDocument(manager, presetTransferSource);
            presetTransferSourceEntries = presetTransferRecords(presetTransferSourceDocument);
            if (presetTransferTarget) {
                presetTransferTargetDocument = await loadPresetTransferDocument(manager, presetTransferTarget);
                presetTransferTargetEntries = presetTransferRecords(presetTransferTargetDocument);
            } else {
                presetTransferTargetDocument = null;
                presetTransferTargetEntries = [];
            }
            presetTransferSelected = new Set();
            presetTransferAnchor = { kind: 'top', anchorId: '' };
            presetTransferDraft = null;
            presetTransferVisibleLimit = 120;
        } catch (error) {
            presetTransferError = error.message || String(error);
        } finally {
            presetTransferLoading = false;
            presetTransferLoadedOnce = true;
            renderPanel();
        }
    }
    
    async function choosePresetTransferSide(side, name) {
        const next = String(name || '');
        if (side === 'source') {
            const previousSource = presetTransferSource;
            presetTransferSource = next;
            if (presetTransferSource && presetTransferSource === presetTransferTarget) {
                presetTransferTarget = previousSource && previousSource !== presetTransferSource ? previousSource : '';
            }
        } else presetTransferTarget = next;
        if (presetTransferSource && presetTransferSource === presetTransferTarget) {
            presetTransferError = '来源和目标不能是同一个预设';
            return renderPanel();
        }
        return loadPresetTransfer({ force: true });
    }
    
    async function swapPresetTransferSides() {
        if (presetTransferModeValue !== 'dual' || !presetTransferTarget) return;
        const source = presetTransferSource;
        presetTransferSource = presetTransferTarget;
        presetTransferTarget = source;
        presetTransferSelected = new Set();
        presetTransferAnchor = { kind: 'top', anchorId: '' };
        presetTransferDraft = null;
        return loadPresetTransfer({ force: true });
    }
    
    async function setPresetTransferMode(mode) {
        const next = mode === 'dual' ? 'dual' : 'single';
        presetTransferModeValue = next;
        presetTransferSelected = new Set();
        presetTransferAnchor = { kind: 'top', anchorId: '' };
        presetTransferDraft = null;
        if (next === 'single') presetTransferTarget = '';
        await loadPresetTransfer({ force: true });
    }
    
    function clonePresetEntriesIntoDocument(targetDocument, targetInfo, selected, anchor, { renameCopies = false } = {}) {
        const existingIds = new Set(presetTransferRecords(targetDocument).map((entry) => String(entry.id)));
        const existingNames = new Set(presetTransferRecords(targetDocument).map((entry) => String(entry.name)));
        const clones = [];
        for (const entry of selected) {
            const raw = deepClone(entry.raw);
            const id = uniquePresetIdentifier(raw, existingIds);
            presetSetRawIdentifier(raw, id, targetInfo.key);
            if (renameCopies) raw.name = uniquePresetName(raw, existingNames);
            targetInfo.entries.push(raw);
            clones.push({ identifier: id, enabled: entry.enabled !== false });
        }
        targetDocument[targetInfo.key] = targetInfo.entries;
        addPresetPromptOrders(targetDocument, clones, anchor);
        return clones.map((item) => String(item.identifier));
    }
    
    async function duplicatePresetEntriesInternal(selected) {
        const manager = getPresetTransferManager();
        const document = await loadPresetTransferDocument(manager, presetTransferSource);
        const info = presetEntryArrayInfo(document);
        const ids = clonePresetEntriesIntoDocument(document, info, selected, presetAnchorForOperation(), { renameCopies: true });
        const verify = await savePresetTransferDocument(manager, presetTransferSource, document);
        verifyPresetOperation(verify, ids);
        return ids;
    }
    
    async function reorderPresetEntriesInternal(selected) {
        const manager = getPresetTransferManager();
        const document = await loadPresetTransferDocument(manager, presetTransferSource);
        const group = presetMainPromptOrder(document, true);
        const selectedIds = new Set(selected.map((entry) => String(entry.id)));
        const selectedOrder = group.order.filter((item) => selectedIds.has(presetOrderIdentifier(item)));
        // Uninserted entries can also be moved: use their current enabled state.
        for (const entry of selected) {
            if (!selectedOrder.some((item) => presetOrderIdentifier(item) === String(entry.id))) {
                selectedOrder.push({ identifier: String(entry.id), enabled: entry.enabled !== false });
            }
        }
        group.order = group.order.filter((item) => !selectedIds.has(presetOrderIdentifier(item)));
        const index = presetInsertIndex(group.order, presetAnchorForOperation());
        group.order.splice(index, 0, ...selectedOrder.map((item) => ({
            identifier: presetOrderIdentifier(item),
            enabled: item.enabled !== false,
        })));
        const verify = await savePresetTransferDocument(manager, presetTransferSource, document);
        verifyPresetOperation(verify, selectedIds);
        return selectedIds;
    }
    
    async function transferPresetEntries(mode) {
        const selected = presetSelectedRecords();
        if (!selected.length) return notify('请先勾选要处理的预设条目', 'warning');
        if (presetTransferModeValue === 'single') {
            presetTransferLoading = true;
            renderPanel();
            try {
                if (mode === 'copy') await duplicatePresetEntriesInternal(selected);
                else await reorderPresetEntriesInternal(selected);
                notify(`已在当前预设${mode === 'copy' ? '复制' : '移动'} ${selected.length} 个条目`, 'success');
                await loadPresetTransfer({ force: true });
            } catch (error) {
                presetTransferError = error.message || String(error);
                notify(`预设条目${mode === 'copy' ? '复制' : '移动'}失败：${error.message}`, 'error');
            } finally {
                presetTransferLoading = false;
                renderPanel();
            }
            return;
        }
        if (!presetTransferTarget || presetTransferTarget === presetTransferSource) return notify('请选择不同的目标预设', 'warning');
        presetTransferLoading = true;
        renderPanel();
        let targetCommitted = false;
        try {
            const manager = getPresetTransferManager();
            const sourceDocument = await loadPresetTransferDocument(manager, presetTransferSource);
            const targetDocument = await loadPresetTransferDocument(manager, presetTransferTarget);
            const sourceInfo = presetEntryArrayInfo(sourceDocument);
            const targetInfo = presetEntryArrayInfo(targetDocument);
            const selectedIds = new Set(selected.map((entry) => String(entry.id)));
            const createdIds = clonePresetEntriesIntoDocument(targetDocument, targetInfo, selected, presetAnchorForOperation());
            const targetVerify = await savePresetTransferDocument(manager, presetTransferTarget, targetDocument);
            verifyPresetOperation(targetVerify, createdIds);
            targetCommitted = true;
            if (mode === 'move') {
                sourceInfo.entries = sourceInfo.entries.filter((raw, index) => {
                    const id = presetRawIdentifier(raw, index);
                    return !selectedIds.has(id);
                });
                sourceDocument[sourceInfo.key] = sourceInfo.entries;
                removePresetPromptOrder(sourceDocument, selectedIds);
                const sourceVerify = await savePresetTransferDocument(manager, presetTransferSource, sourceDocument);
                const remaining = new Set(presetTransferRecords(sourceVerify).map((entry) => String(entry.id)));
                for (const id of selectedIds) if (remaining.has(id)) throw new Error(`来源预设仍保留条目 ${id}`);
            }
            notify(`已${mode === 'move' ? '移动' : '复制'} ${selected.length} 个预设条目`, 'success');
            await loadPresetTransfer({ force: true });
        } catch (error) {
            presetTransferError = error.message || String(error);
            const suffix = targetCommitted && mode === 'move' ? '（目标已保存，来源未删除）' : '';
            notify(`预设条目${mode === 'move' ? '移动' : '复制'}失败：${error.message}${suffix}`, 'error');
        } finally {
            presetTransferLoading = false;
            renderPanel();
        }
    }
    
    async function deletePresetEntries() {
        const selected = presetSelectedRecords();
        if (!selected.length) return;
        const confirmed = await requestDialog({
            title: '删除预设条目',
            message: `确定从预设“${presetTransferSource}”删除选中的 ${selected.length} 个条目吗？`,
            confirmLabel: '删除',
            danger: true,
        });
        if (!confirmed) return;
        presetTransferLoading = true;
        renderPanel();
        try {
            const manager = getPresetTransferManager();
            const document = await loadPresetTransferDocument(manager, presetTransferSource);
            const info = presetEntryArrayInfo(document);
            const ids = new Set(selected.map((entry) => entry.id));
            info.entries = info.entries.filter((raw, index) => !ids.has(presetRawIdentifier(raw, index)));
            document[info.key] = info.entries;
            removePresetPromptOrder(document, ids);
            await savePresetTransferDocument(manager, presetTransferSource, document);
            notify(`已删除 ${selected.length} 个预设条目`, 'success');
            await loadPresetTransfer({ force: true });
        } catch (error) {
            presetTransferError = error.message || String(error);
            notify(`批量删除失败：${error.message}`, 'error');
        } finally {
            presetTransferLoading = false;
            renderPanel();
        }
    }
    
    function startPresetEntryEdit(id, side = 'source', surface = 'list') {
        const normalizedSide = side === 'target' ? 'target' : 'source';
        const entries = normalizedSide === 'target' ? presetTransferTargetEntries : presetTransferSourceEntries;
        const presetName = normalizedSide === 'target' ? presetTransferTarget : presetTransferSource;
        const entry = entries.find((item) => String(item.id) === String(id));
        if (!entry || entry.marker) return notify('内置标记不能直接编辑', 'warning');
        presetTransferDraft = {
            id: String(entry.id),
            raw: deepClone(entry.raw),
            enabled: entry.enabled !== false,
            side: normalizedSide,
            presetName,
            surface: surface === 'compare' ? 'compare' : 'list',
        };
        renderPanel();
    }
    
    async function savePresetEntryDraft() {
        if (!presetTransferDraft) return;
        const draft = presetTransferDraft;
        const manager = getPresetTransferManager();
        const presetName = String(draft.presetName || presetTransferSource);
        const document = await loadPresetTransferDocument(manager, presetName);
        const info = presetEntryArrayInfo(document);
        const index = info.entries.findIndex((raw, rawIndex) => presetRawIdentifier(raw, rawIndex) === draft.id);
        if (index < 0) throw new Error('条目已不存在，无法保存');
        const current = info.entries[index];
        const next = deepClone(draft.raw);
        // Keep any fields added by newer ST versions that the editor does not expose.
        info.entries[index] = { ...(current && typeof current === 'object' ? current : {}), ...next };
        document[info.key] = info.entries;
        const group = presetMainPromptOrder(document, false);
        if (group) {
            const orderItem = group.order.find((item) => presetOrderIdentifier(item) === draft.id);
            if (orderItem) orderItem.enabled = draft.enabled !== false;
            else if (draft.enabled !== false) addPresetPromptOrder(document, draft.id, true, { kind: 'top', anchorId: '' });
        } else if (draft.enabled !== false) {
            addPresetPromptOrder(document, draft.id, true, { kind: 'top', anchorId: '' });
        }
        const verify = await savePresetTransferDocument(manager, presetName, document);
        verifyPresetOperation(verify, [draft.id], { requireOrder: false });
        presetTransferDraft = null;
    }
    
    async function commitPresetEntryDraft() {
        if (!presetTransferDraft) return;
        presetTransferLoading = true;
        renderPanel();
        try {
            await savePresetEntryDraft();
            notify('预设条目已保存', 'success');
            await loadPresetTransfer({ force: true });
        } catch (error) {
            presetTransferError = error.message || String(error);
            notify(`保存预设条目失败：${error.message}`, 'error');
        } finally {
            presetTransferLoading = false;
            renderPanel();
        }
    }
    
    function updatePresetTransferSelectionUi() {
        const rootEl = getRoot();
        if (!rootEl) return;
        const count = presetTransferSelected.size;
        if (presetTransferAnchor?.kind === 'after' && presetTransferSelected.has(String(presetTransferAnchor.anchorId))) {
            const replacement = presetTransferPlacementEntries().find((entry) => !entry.marker && !presetTransferSelected.has(String(entry.id)));
            presetTransferAnchor = replacement
                ? { kind: presetTransferAnchor.kind, anchorId: String(replacement.id) }
                : { kind: 'top', anchorId: '' };
        }
        rootEl.querySelectorAll('[data-preset-selection-count]').forEach((node) => { node.textContent = String(count); });
        rootEl.querySelectorAll('[data-preset-bulk-action]').forEach((button) => {
            const action = button.dataset.presetBulkAction;
            let disabled = count === 0;
            if (action === 'edit') disabled = count !== 1;
            if (button.dataset.ctbNeedsTarget === 'true') disabled = disabled || !presetTransferTarget;
            button.disabled = disabled || presetTransferLoading;
        });
        const referenceSelect = rootEl.querySelector('#ctb-preset-transfer-anchor');
        if (referenceSelect) {
            [...referenceSelect.options].forEach((option) => {
                option.disabled = presetTransferSelected.has(String(option.value));
            });
            referenceSelect.value = String(presetTransferAnchor.anchorId || '');
        }
        rootEl.querySelectorAll('input[data-preset-entry-id]').forEach((input) => {
            const id = String(input.dataset.presetEntryId);
            input.checked = presetTransferSelected.has(id);
            input.closest('.ctb-preset-entry')?.classList.toggle('is-selected', input.checked);
        });
    }
    
    function presetCompareSummary(source, target) {
        const nameKey = (entry) => String(entry?.name || '').trim();
        const compareKey = (entry) => JSON.stringify({
            content: presetEntryDisplayContent(entry),
            role: String(entry?.raw?.role || ''),
            enabled: entry?.enabled !== false,
        });
        const left = new Map(source.filter((entry) => !entry.marker && nameKey(entry)).map((entry) => [nameKey(entry), entry]));
        const right = new Map(target.filter((entry) => !entry.marker && nameKey(entry)).map((entry) => [nameKey(entry), entry]));
        const rows = [];
        left.forEach((entry, name) => {
            // A comparison is meaningful only when both presets contain the
            // exact same entry name.  Unique source/target rows are omitted.
            if (right.has(name) && compareKey(entry) !== compareKey(right.get(name))) {
                rows.push({ kind: '内容不同', name, left: entry, right: right.get(name) });
            }
        });
        return rows;
    }
    
    function presetTransferPlacementEntries() {
        const entries = presetTransferModeValue === 'dual' ? presetTransferTargetEntries : presetTransferSourceEntries;
        return entries.filter(presetTransferEntryMatchesLoadMode);
    }
    
    function renderPresetPlacementControls() {
        const entries = presetTransferPlacementEntries();
        const candidates = entries.filter((entry) => !entry.marker && !presetTransferSelected.has(String(entry.id)));
        const requestedKind = presetTransferAnchor?.kind === 'after' ? 'after' : 'top';
        const needsReference = requestedKind === 'after';
        const currentReference = candidates.some((entry) => String(entry.id) === String(presetTransferAnchor?.anchorId || ''))
            ? String(presetTransferAnchor.anchorId)
            : String(candidates[0]?.id || '');
        const referenceOptions = candidates.length
            ? candidates.map((entry) => `<option value="${escapeHTML(entry.id)}"${String(entry.id) === currentReference ? ' selected' : ''}>${escapeHTML(entry.name || '未命名条目')}</option>`).join('')
            : '<option value="">没有可用目标条目</option>';
        const placementScope = presetTransferModeValue === 'dual' ? '目标预设' : '当前预设';
        const placeButton = (kind, label) => `<button type="button" class="ctb-button ctb-placement-choice${requestedKind === kind ? ' is-active' : ''}" data-action="set-preset-anchor" data-preset-anchor-kind="${kind}" data-preset-anchor-id="${kind === 'after' ? escapeHTML(currentReference) : ''}">${label}</button>`;
        return `<div class="ctb-preset-placement" aria-label="条目放置位置"><div class="ctb-preset-placement-label"><strong>放到哪里</strong><span>复制或移动后写入${placementScope}</span></div><div class="ctb-preset-placement-main"><div class="ctb-placement-choices">${placeButton('top', '列表开头')}${placeButton('after', '所选条目后')}</div>${needsReference ? `<label class="ctb-placement-reference"><span>插入到哪条后面</span><select class="ctb-input" id="ctb-preset-transfer-anchor" aria-label="插入到哪条后面"${candidates.length ? '' : ' disabled'}>${referenceOptions}</select></label>` : ''}</div></div>`;
    }
    
    function renderPresetDraftFields(saveLabel = '保存条目') {
        const draft = presetTransferDraft;
        if (!draft) return '';
        return `<label class="ctb-field"><span>名称</span><input class="ctb-input" id="ctb-preset-draft-name" value="${escapeHTML(draft.raw?.name || draft.raw?.comment || '')}"></label>
            <label class="ctb-field"><span>角色</span><select class="ctb-input" id="ctb-preset-draft-role"><option value="system"${draft.raw?.role === 'system' ? ' selected' : ''}>system</option><option value="user"${draft.raw?.role === 'user' ? ' selected' : ''}>user</option><option value="assistant"${draft.raw?.role === 'assistant' ? ' selected' : ''}>assistant</option></select></label>
            <label class="ctb-field"><span>内容</span><textarea class="ctb-input ctb-preset-draft-content" id="ctb-preset-draft-content">${escapeHTML(presetEntryDisplayContent(draft.raw))}</textarea></label>
            <label class="ctb-check"><input type="checkbox" id="ctb-preset-draft-enabled"${draft.enabled !== false ? ' checked' : ''}>加入主发送顺序并启用</label>
            <div class="ctb-inline ctb-preset-draft-actions"><button type="button" class="ctb-button ctb-primary" data-action="save-preset-edit">${saveLabel}</button><button type="button" class="ctb-button" data-action="cancel-preset-edit">收起</button></div>`;
    }
    
    function renderPresetTransferTab() {
        if (!presetTransferLoadedOnce && !presetTransferLoading) host.setTimeout(() => loadPresetTransfer(), 0);
        let names = [];
        try { names = presetTransferNames(getPresetTransferManager()); } catch (_) {}
        const mode = presetTransferModeValue;
        const loadMode = presetTransferLoadModeValue;
        const sourceOptions = names.map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferSource ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const targetOptions = names.filter((name) => name !== presetTransferSource).map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferTarget ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const query = presetTransferSearch.trim().toLowerCase();
        const filterEntries = (entries) => entries.filter((entry) => presetTransferEntryMatchesLoadMode(entry)
            && (!query || `${entry.name}\n${entry.content}\n${entry.id}`.toLowerCase().includes(query)));
        const source = filterEntries(presetTransferSourceEntries);
        const target = filterEntries(presetTransferTargetEntries);
        const renderLoadFilter = (side) => `<select class="ctb-input" id="ctb-preset-transfer-load-${side}" aria-label="预设条目加载范围"><option value="all"${loadMode === 'all' ? ' selected' : ''}>加载全部条目</option><option value="enabled"${loadMode === 'enabled' ? ' selected' : ''}>仅加载已启用</option></select>`;
        const renderRows = (rows, side, { selectable = false } = {}) => {
            if (!rows.length) return `<div class="ctb-world-empty">${loadMode === 'enabled' ? '没有已启用且符合条件的条目。' : '没有符合条件的条目。'}</div>`;
            const body = rows.slice(0, presetTransferVisibleLimit).map((entry) => {
                const id = String(entry.id);
                const checked = presetTransferSelected.has(id);
                const expanded = !entry.marker && presetTransferDraft?.surface !== 'compare' && presetTransferDraft?.side === side && String(presetTransferDraft?.id) === id;
                const checkbox = selectable ? `<input type="checkbox" data-preset-entry-id="${escapeHTML(id)}"${checked ? ' checked' : ''}${entry.marker ? ' disabled' : ''}>` : '';
                const toggleAttrs = entry.marker ? ' disabled' : ` data-action="toggle-preset-entry" data-preset-entry-id="${escapeHTML(id)}" data-preset-side="${side}" aria-expanded="${expanded ? 'true' : 'false'}"`;
                return `<article class="ctb-preset-entry${checked ? ' is-selected' : ''}${entry.marker ? ' is-locked' : ''}${expanded ? ' is-expanded' : ''}">
                    <div class="ctb-preset-entry-head">${checkbox}<button type="button" class="ctb-preset-entry-title"${toggleAttrs}>${escapeHTML(entry.name)}</button><span class="ctb-preset-entry-status">${entry.inserted ? (entry.enabled ? '启用' : '停用') : '未加入主顺序'}</span><button type="button" class="ctb-preset-entry-chevron"${toggleAttrs} aria-label="${expanded ? '收起' : '展开'} ${escapeHTML(entry.name)}"><svg viewBox="0 0 16 16" focusable="false"><path d="M3.5 6 8 10.5 12.5 6"></path></svg></button></div>
                    ${expanded ? `<div class="ctb-preset-entry-editor">${renderPresetDraftFields()}</div>` : ''}
                </article>`;
            }).join('');
            const more = rows.length > presetTransferVisibleLimit ? `<button type="button" class="ctb-list-more" data-action="more-preset-transfer-entries">再显示 ${Math.min(120, rows.length - presetTransferVisibleLimit)} 条（共 ${rows.length} 条）</button>` : '';
            return `${body}${more}`;
        };
        const sourceList = renderRows(source, 'source', { selectable: true });
        const targetList = renderRows(target, 'target');
        const draft = presetTransferDraft;
        const compareFilter = (entry) => !entry.marker && (!query || `${entry.name}\n${entry.content}\n${entry.id}`.toLowerCase().includes(query));
        const compareRows = mode === 'dual' ? presetCompareSummary(presetTransferSourceEntries.filter(compareFilter), presetTransferTargetEntries.filter(compareFilter)) : [];
        const renderCompareSide = (entry, side, highlightedContent, row) => {
            const label = side === 'target' ? '目标' : '来源';
            const editing = !!draft && draft.surface === 'compare' && draft.side === side && String(draft.id) === String(entry?.id);
            if (editing) return `<div class="ctb-preset-compare-side is-editing"><small>${label} · 直接编辑</small><div class="ctb-preset-compare-editor">${renderPresetDraftFields('保存此侧')}</div></div>`;
            const roleDifferent = String(row.left.raw?.role || '') !== String(row.right.raw?.role || '');
            const enabledDifferent = row.left.enabled !== row.right.enabled || row.left.inserted !== row.right.inserted;
            return `<div class="ctb-preset-compare-side"><div class="ctb-preset-compare-side-head"><small>${label}</small><button type="button" class="ctb-button ctb-preset-compare-edit" data-action="edit-preset-entry" data-preset-entry-id="${escapeHTML(entry.id)}" data-preset-side="${side}" data-preset-surface="compare">编辑并保存</button></div><div class="ctb-preset-compare-meta"><span${roleDifferent ? ' class="is-different"' : ''}>角色：${escapeHTML(entry.raw?.role || 'system')}</span><span${enabledDifferent ? ' class="is-different"' : ''}>${entry.inserted ? (entry.enabled ? '启用' : '停用') : '未加入主顺序'}</span></div><p>${highlightedContent || '（空内容）'}</p></div>`;
        };
        const compare = mode === 'dual' && presetCompareOpen ? `<div class="ctb-preset-compare-list" data-ctb-scroll-key="preset-compare-list">${compareRows.length ? compareRows.slice(0, 120).map((row) => {
            const highlighted = renderTextDifference(presetEntryDisplayContent(row.left), presetEntryDisplayContent(row.right), escapeHTML);
            return `<div class="ctb-preset-compare-row"><div class="ctb-preset-compare-title"><span>${escapeHTML(row.kind)}</span><strong>${escapeHTML(row.name)}</strong></div>${renderCompareSide(row.left, 'source', highlighted.left, row)}${renderCompareSide(row.right, 'target', highlighted.right, row)}</div>`;
        }).join('') : '<div class="ctb-readonly-note">两个预设没有名称相同但正文、角色或启用状态不同的条目。</div>'}</div>` : '';
        const transferControls = mode === 'dual'
            ? `<button type="button" class="ctb-button ctb-primary" data-preset-bulk-action="copy" data-ctb-needs-target="true" data-action="copy-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>复制到目标</button><button type="button" class="ctb-button" data-preset-bulk-action="move" data-ctb-needs-target="true" data-action="move-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>移动到目标</button>`
            : `<button type="button" class="ctb-button ctb-primary" data-preset-bulk-action="copy" data-action="copy-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>复制到所选位置</button><button type="button" class="ctb-button" data-preset-bulk-action="move" data-action="move-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>移动到所选位置</button>`;
        const sourceCount = loadMode === 'enabled' ? `${source.length} / ${presetTransferSourceEntries.length} 条` : `${source.length} 条`;
        const targetCount = loadMode === 'enabled' ? `${target.length} / ${presetTransferTargetEntries.length} 条` : `${target.length} 条`;
        const presetLists = `<section class="ctb-section ctb-preset-transfer-grid${mode === 'single' ? ' is-single' : ''}"><div><div class="ctb-section-title">${mode === 'single' ? '当前预设' : '来源预设'} <span>${sourceCount}</span></div><select class="ctb-input" id="ctb-preset-transfer-source">${sourceOptions || '<option value="">没有预设</option>'}</select>${renderLoadFilter('source')}<div class="ctb-preset-entry-list" data-ctb-scroll-key="preset-source-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : sourceList}</div></div>${mode === 'dual' ? `<div><div class="ctb-section-title">目标预设 <span>${targetCount}</span></div><select class="ctb-input" id="ctb-preset-transfer-target">${targetOptions || '<option value="">没有其他预设</option>'}</select>${renderLoadFilter('target')}<div class="ctb-preset-entry-list" data-ctb-scroll-key="preset-target-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : targetList}</div></div>` : ''}</section>`;
        const compareSelectors = `<section class="ctb-section ctb-preset-transfer-grid ctb-preset-compare-selectors"><div><div class="ctb-section-title">来源预设</div><select class="ctb-input" id="ctb-preset-transfer-source">${sourceOptions || '<option value="">没有预设</option>'}</select></div><div><div class="ctb-section-title">目标预设</div><select class="ctb-input" id="ctb-preset-transfer-target">${targetOptions || '<option value="">没有其他预设</option>'}</select></div></section>`;
        const presetActions = `<section class="ctb-section ctb-preset-actions"><div class="ctb-inline ctb-manager-toolbar"><span>已选 <span data-preset-selection-count>${presetTransferSelected.size}</span> 条</span>${transferControls}<button type="button" class="ctb-button ctb-danger" data-preset-bulk-action="delete" data-action="delete-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>批量删除</button></div>${renderPresetPlacementControls()}</section>`;
        return `<section class="ctb-section"><div class="ctb-section-title">预设条目转移 ${infoButton('preset-transfer')}</div></section>
            <section class="ctb-section"><div class="ctb-inline ctb-manager-toolbar"><button type="button" class="ctb-button${mode === 'single' ? ' ctb-primary' : ''}" data-action="set-preset-transfer-mode" data-mode="single">单预设编辑</button><button type="button" class="ctb-button${mode === 'dual' ? ' ctb-primary' : ''}" data-action="set-preset-transfer-mode" data-mode="dual">双预设对比/转移</button>${mode === 'dual' ? '<button type="button" class="ctb-button" data-action="swap-preset-sides">交换左右</button>' : ''}<input class="ctb-input" id="ctb-preset-transfer-search" placeholder="搜索条目" value="${escapeHTML(presetTransferSearch)}"><button type="button" class="ctb-button" data-action="filter-preset-transfer">筛选</button><button type="button" class="ctb-button" data-action="refresh-preset-transfer">刷新预设</button>${mode === 'dual' ? `<button type="button" class="ctb-button" data-action="toggle-preset-compare">${presetCompareOpen ? '关闭差异' : `比较差异${compareRows.length ? `（${compareRows.length}）` : ''}`}</button>` : ''}</div>${presetTransferError ? `<div class="ctb-readonly-note ctb-world-error">${escapeHTML(presetTransferError)}</div>` : ''}</section>
            ${presetCompareOpen && mode === 'dual' ? `${compareSelectors}${compare}` : `${presetLists}${presetActions}`}`;
    }

    function handleInput(target) {
        const id = target?.id;
        if (id === 'ctb-preset-draft-name' && presetTransferDraft) presetTransferDraft.raw.name = target.value;
        else if (id === 'ctb-preset-transfer-search') presetTransferSearch = target.value;
        else if (id === 'ctb-preset-draft-content' && presetTransferDraft) presetTransferDraft.raw.content = target.value;
        else return false;
        return true;
    }

    async function handleChange(target) {
        const id = target?.id;
        if (target?.dataset?.presetEntryId !== undefined) {
            const idValue = String(target.dataset.presetEntryId);
            if (target.checked) presetTransferSelected.add(idValue);
            else presetTransferSelected.delete(idValue);
            updatePresetTransferSelectionUi();
        } else if (id === 'ctb-preset-transfer-source') {
            await choosePresetTransferSide('source', target.value);
        } else if (id === 'ctb-preset-transfer-target') {
            await choosePresetTransferSide('target', target.value);
        } else if (id === 'ctb-preset-transfer-anchor') {
            presetTransferAnchor.anchorId = String(target.value || '');
            renderPanel();
        } else if (id === 'ctb-preset-transfer-load-source' || id === 'ctb-preset-transfer-load-target') {
            presetTransferLoadModeValue = target.value === 'enabled' ? 'enabled' : 'all';
            presetTransferSelected = new Set();
            presetTransferAnchor = { kind: 'top', anchorId: '' };
            presetTransferDraft = null;
            presetTransferVisibleLimit = 120;
            renderPanel();
        } else if (id === 'ctb-preset-draft-role' && presetTransferDraft) {
            presetTransferDraft.raw.role = target.value;
        } else if (id === 'ctb-preset-draft-enabled' && presetTransferDraft) {
            presetTransferDraft.enabled = target.checked;
        } else return false;
        return true;
    }

    async function handleAction(action, data = {}) {
        switch (action) {
            case 'refresh-preset-transfer': await loadPresetTransfer({ force: true }); return true;
            case 'filter-preset-transfer': presetTransferVisibleLimit = 120; renderPanel(); return true;
            case 'more-preset-transfer-entries': presetTransferVisibleLimit += 120; renderPanel(); return true;
            case 'set-preset-transfer-mode': await setPresetTransferMode(data.mode); return true;
            case 'swap-preset-sides': await swapPresetTransferSides(); return true;
            case 'toggle-preset-compare': presetCompareOpen = !presetCompareOpen; renderPanel(); return true;
            case 'set-preset-anchor':
                presetTransferAnchor = {
                    kind: data.presetAnchorKind === 'after' ? 'after' : 'top',
                    anchorId: data.presetAnchorKind === 'after' ? String(data.presetAnchorId || '') : '',
                };
                renderPanel();
                return true;
            case 'toggle-preset-entry': {
                const id = String(data.presetEntryId || '');
                const side = data.presetSide === 'target' ? 'target' : 'source';
                if (presetTransferDraft?.surface === 'list' && presetTransferDraft.side === side && String(presetTransferDraft.id) === id) {
                    presetTransferDraft = null;
                    renderPanel();
                } else startPresetEntryEdit(id, side, 'list');
                return true;
            }
            case 'edit-preset-entry': startPresetEntryEdit(data.presetEntryId, data.presetSide || 'source', data.presetSurface || 'list'); return true;
            case 'save-preset-edit': await commitPresetEntryDraft(); return true;
            case 'cancel-preset-edit': presetTransferDraft = null; renderPanel(); return true;
            case 'copy-preset-entries': await transferPresetEntries('copy'); return true;
            case 'move-preset-entries': await transferPresetEntries('move'); return true;
            case 'delete-preset-entries': await deletePresetEntries(); return true;
            default: return false;
        }
    }

    return {
        renderTab: renderPresetTransferTab,
        handleInput,
        handleChange,
        handleAction,
    };
}
