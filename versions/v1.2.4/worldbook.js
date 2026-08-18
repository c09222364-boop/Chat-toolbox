function worldbookEntryIdentifier(entry, fallback = '') {
    const value = entry?.uid ?? entry?.id ?? fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function worldbookOriginalExtensionValue(raw, camelKey, snakeKey, fallback) {
    if (raw?.[camelKey] !== undefined) return raw[camelKey];
    if (raw?.extensions?.[snakeKey] !== undefined) return raw.extensions[snakeKey];
    return fallback;
}

function synchronizeWorldbookOriginalEntry(existing, raw, uid, displayIndex) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const original = existing && typeof existing === 'object' ? { ...existing } : {};
    const extensions = {
        ...(original.extensions && typeof original.extensions === 'object' ? original.extensions : {}),
        ...(source.extensions && typeof source.extensions === 'object' ? source.extensions : {}),
    };
    const position = Number(source.position ?? extensions.position);
    const triggers = worldbookOriginalExtensionValue(source, 'triggers', 'triggers', []);

    extensions.display_index = Number.isFinite(Number(source.displayIndex)) ? Number(source.displayIndex) : displayIndex;
    extensions.exclude_recursion = Boolean(worldbookOriginalExtensionValue(source, 'excludeRecursion', 'exclude_recursion', false));
    extensions.prevent_recursion = Boolean(worldbookOriginalExtensionValue(source, 'preventRecursion', 'prevent_recursion', false));
    extensions.delay_until_recursion = Boolean(worldbookOriginalExtensionValue(source, 'delayUntilRecursion', 'delay_until_recursion', false));
    extensions.depth = Number(worldbookOriginalExtensionValue(source, 'depth', 'depth', 4));
    extensions.probability = Number(worldbookOriginalExtensionValue(source, 'probability', 'probability', 100));
    extensions.useProbability = Boolean(worldbookOriginalExtensionValue(source, 'useProbability', 'useProbability', true));
    extensions.position = Number.isInteger(position) ? position : 1;
    extensions.role = Number(worldbookOriginalExtensionValue(source, 'role', 'role', 0));
    extensions.selectiveLogic = Number(worldbookOriginalExtensionValue(source, 'selectiveLogic', 'selectiveLogic', 0));
    extensions.outlet_name = String(worldbookOriginalExtensionValue(source, 'outletName', 'outlet_name', ''));
    extensions.group = String(worldbookOriginalExtensionValue(source, 'group', 'group', ''));
    extensions.group_override = Boolean(worldbookOriginalExtensionValue(source, 'groupOverride', 'group_override', false));
    extensions.group_weight = Number(worldbookOriginalExtensionValue(source, 'groupWeight', 'group_weight', 100));
    extensions.scan_depth = worldbookOriginalExtensionValue(source, 'scanDepth', 'scan_depth', null);
    extensions.case_sensitive = worldbookOriginalExtensionValue(source, 'caseSensitive', 'case_sensitive', null);
    extensions.match_whole_words = worldbookOriginalExtensionValue(source, 'matchWholeWords', 'match_whole_words', null);
    extensions.use_group_scoring = worldbookOriginalExtensionValue(source, 'useGroupScoring', 'use_group_scoring', null);
    extensions.automation_id = String(worldbookOriginalExtensionValue(source, 'automationId', 'automation_id', ''));
    extensions.vectorized = Boolean(worldbookOriginalExtensionValue(source, 'vectorized', 'vectorized', false));
    extensions.sticky = worldbookOriginalExtensionValue(source, 'sticky', 'sticky', null);
    extensions.cooldown = worldbookOriginalExtensionValue(source, 'cooldown', 'cooldown', null);
    extensions.delay = worldbookOriginalExtensionValue(source, 'delay', 'delay', null);
    extensions.match_persona_description = Boolean(worldbookOriginalExtensionValue(source, 'matchPersonaDescription', 'match_persona_description', false));
    extensions.match_character_description = Boolean(worldbookOriginalExtensionValue(source, 'matchCharacterDescription', 'match_character_description', false));
    extensions.match_character_personality = Boolean(worldbookOriginalExtensionValue(source, 'matchCharacterPersonality', 'match_character_personality', false));
    extensions.match_character_depth_prompt = Boolean(worldbookOriginalExtensionValue(source, 'matchCharacterDepthPrompt', 'match_character_depth_prompt', false));
    extensions.match_scenario = Boolean(worldbookOriginalExtensionValue(source, 'matchScenario', 'match_scenario', false));
    extensions.match_creator_notes = Boolean(worldbookOriginalExtensionValue(source, 'matchCreatorNotes', 'match_creator_notes', false));
    extensions.triggers = Array.isArray(triggers) ? [...triggers] : [];
    extensions.ignore_budget = Boolean(worldbookOriginalExtensionValue(source, 'ignoreBudget', 'ignore_budget', false));

    return {
        ...original,
        id: uid,
        uid,
        keys: Array.isArray(source.key) ? [...source.key] : [],
        secondary_keys: Array.isArray(source.keysecondary) ? [...source.keysecondary] : [],
        comment: String(source.comment ?? ''),
        content: String(source.content ?? ''),
        constant: Boolean(source.constant),
        selective: Boolean(source.selective),
        selectiveLogic: Number(source.selectiveLogic ?? extensions.selectiveLogic ?? 0),
        insertion_order: Number(source.order ?? 0),
        enabled: !Boolean(source.disable),
        position: extensions.position === 0 ? 'before_char' : 'after_char',
        extensions,
    };
}

/**
 * Keep the character-card copy of an embedded lorebook aligned with the
 * internal SillyTavern entries object. Standalone lorebooks have no
 * originalData.entries array and pass through unchanged.
 */
export function synchronizeWorldbookOriginalData(document) {
    if (!document || typeof document !== 'object' || !Array.isArray(document.originalData?.entries)) return document;
    const entries = document.entries && typeof document.entries === 'object' ? document.entries : {};
    const originals = document.originalData.entries;
    const originalByUid = new Map();
    originals.forEach((entry, index) => {
        const uid = worldbookEntryIdentifier(entry, index);
        if (uid !== null && !originalByUid.has(uid)) originalByUid.set(uid, entry);
    });
    const synchronized = Object.entries(entries).map(([key, raw], index) => {
        const uid = worldbookEntryIdentifier(raw, key);
        if (uid === null) return null;
        return synchronizeWorldbookOriginalEntry(originalByUid.get(uid), raw, uid, index);
    }).filter(Boolean);
    document.originalData = { ...document.originalData, entries: synchronized };
    return document;
}

export function createWorldbookModule(deps) {
    const {
        host, getContext, getChat, chatKey, currentCharacterCard, deepClone,
        stProxyJson, notify, renderPanel, getRoot, requestDialog,
        escapeHTML, messageId, messageName, messageText, infoButton,
    } = deps;

    let worldbookLoading = false;
    let worldbookLoadedOnce = false;
    let worldbookLoadedContextKey = '';
    let worldbookLoadScheduledContextKey = '';
    let worldbookSaving = false;
    let worldbookBooks = [];
    let worldbookBook = '';
    let worldbookDocument = null;
    let worldbookEntries = [];
    let worldbookSearch = '';
    let worldbookVisibleLimit = 120;
    let worldbookSelected = new Set();
    let worldbookEditingUid = '';
    let worldbookDraft = null;
    let worldbookDraftDirty = false;
    let worldbookDirty = false;
    let worldbookBatchMode = false;
    let worldbookCopyTarget = '';
    let worldbookSimulation = null;
    const worldbookPendingDocuments = new Map();

    function currentCharacterWorldBookName() {
        const card = currentCharacterCard();
        return String(card?.data?.extensions?.world || card?.extensions?.world || '').trim();
    }
    
    function currentWorldbookContextKey() {
        const context = getContext();
        const characterId = context.characterId ?? context.this_chid ?? host.this_chid ?? '';
        const conversation = context.groupId
            ? `group:${context.groupId}`
            : `character:${characterId}`;
        return `${conversation}\u0000${chatKey()}\u0000${currentCharacterWorldBookName()}`;
    }
    
    async function getWorldBookNames(force = false) {
        const context = getContext();
        const readNames = () => {
            try {
                const values = typeof context.getWorldInfoNames === 'function'
                    ? context.getWorldInfoNames()
                    : context.world_names || context.worldNames || host.world_names || host.worldNames;
                return Array.isArray(values)
                    ? [...new Set(values.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b))
                    : [];
            } catch (_) {
                return [];
            }
        };
        const direct = readNames();
        if (!force && direct.length) return direct;
        // 只有缓存确实不存在时才刷新列表；打开管理页不应触发酒馆全局世界书刷新。
        try { await context.updateWorldInfoList?.(); } catch (_) {}
        const refreshed = readNames();
        if (refreshed.length) return refreshed;
        const data = await stProxyJson('/api/settings/get', {});
        return [...new Set((Array.isArray(data?.world_names) ? data.world_names : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }
    
    async function loadWorldInfoDocument(name) {
        const context = getContext();
        if (typeof context.loadWorldInfo === 'function') {
            const data = await context.loadWorldInfo(name);
            if (data && typeof data === 'object') return deepClone(data);
        }
        return deepClone(await stProxyJson('/api/worldinfo/get', { name }));
    }
    
    async function saveWorldInfoDocument(name, data, options = {}) {
        const normalized = typeof options === 'boolean' ? { immediate: options } : (options || {});
        const immediate = normalized.immediate !== false;
        const refreshList = normalized.refreshList === true;
        const verifyAfterSave = normalized.verify === true;
        const context = getContext();
        if (typeof context.saveWorldInfo !== 'function') throw new Error('酒馆没有提供可用的世界书保存接口');
        const prepared = synchronizeWorldbookOriginalData(deepClone(data));
        const saved = await context.saveWorldInfo(name, prepared, Boolean(immediate));
        if (refreshList) {
            try { await context.updateWorldInfoList?.(); } catch (_) {}
        }
        // 普通编辑保存直接采用刚提交的数据，避免每次都额外等待一次
        // /api/worldinfo/get。跨书移动、重命名等会删除来源数据的操作仍显式
        // 开启 verify，确保目标真实写入后再继续。
        if (!verifyAfterSave) {
            const result = saved && typeof saved === 'object' ? saved : prepared;
            if (!result || typeof result.entries !== 'object') throw new Error('世界书保存结果无效');
            return deepClone(result);
        }
        let verify;
        try {
            // loadWorldInfo 可能直接命中酒馆内存缓存；用服务端接口做一次真实回读。
            verify = await stProxyJson('/api/worldinfo/get', { name });
        } catch (_) {
            verify = await loadWorldInfoDocument(name);
        }
        if (!verify || typeof verify.entries !== 'object') throw new Error('保存后无法回读世界书');
        return verify;
    }
    
    /* Worldbook manager: numeric UID and native send order. */
    const WORLDBOOK_POSITIONS = Object.freeze([
        { value: 0, label: '角色定义前' },
        { value: 1, label: '角色定义后' },
        { value: 2, label: '作者注释前' },
        { value: 3, label: '作者注释后' },
        { value: 4, label: '深度（Depth）' },
        { value: 5, label: '示例消息前' },
        { value: 6, label: '示例消息后' },
        { value: 7, label: '命名出口' },
    ]);
    
    function worldbookInteger(value, fallback = 0) {
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
    }
    
    function worldbookDisplayIndex(raw, fallback) {
        const candidates = [raw?.displayIndex, raw?.extensions?.displayIndex, raw?.extensions?.display_index];
        const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
        return value === undefined ? fallback : Number(value);
    }
    
    async function loadFreshWorldInfoDocument(name) {
        try {
            return deepClone(await stProxyJson('/api/worldinfo/get', { name }));
        } catch (_) {
            return loadWorldInfoDocument(name);
        }
    }
    
    function worldbookRecords(data) {
        const source = Object.entries(data?.entries || {});
        const reserved = new Set();
        source.forEach(([key, raw]) => {
            const candidate = Number(raw?.uid ?? key);
            if (Number.isSafeInteger(candidate) && candidate >= 0) reserved.add(candidate);
        });
        const claimed = new Set();
        let nextUid = 0;
        const allocate = () => {
            while (reserved.has(nextUid) || claimed.has(nextUid)) nextUid += 1;
            const uid = nextUid++;
            claimed.add(uid);
            return uid;
        };
        return source.map(([key, raw], index) => {
            const value = raw && typeof raw === 'object' ? deepClone(raw) : {};
            const candidate = Number(value.uid ?? key);
            const uid = Number.isSafeInteger(candidate) && candidate >= 0 && !claimed.has(candidate)
                ? candidate
                : allocate();
            claimed.add(uid);
            // 酒馆可能把递归字段放在顶层或 extensions 中，读取后统一到编辑模型。
            if (value.excludeRecursion === undefined) value.excludeRecursion = Boolean(value.extensions?.exclude_recursion);
            if (value.preventRecursion === undefined) value.preventRecursion = Boolean(value.extensions?.prevent_recursion);
            value.uid = uid;
            const displayIndex = worldbookDisplayIndex(value, index);
            value.displayIndex = displayIndex;
            return { uid: String(uid), raw: value, displayIndex };
        });
    }
    
    function serializeWorldbookRecords(records) {
        const entries = {};
        for (const record of records || []) {
            const raw = deepClone(record?.raw || {});
            const uid = worldbookInteger(raw.uid ?? record?.uid, 0);
            const displayIndex = Number.isFinite(Number(record?.displayIndex))
                ? Number(record.displayIndex)
                : worldbookDisplayIndex(raw, 0);
            raw.uid = uid;
            raw.displayIndex = displayIndex;
            if (raw.extensions && typeof raw.extensions === 'object') {
                if (Object.prototype.hasOwnProperty.call(raw.extensions, 'displayIndex')) raw.extensions.displayIndex = displayIndex;
                if (Object.prototype.hasOwnProperty.call(raw.extensions, 'display_index')) raw.extensions.display_index = displayIndex;
            }
            raw.excludeRecursion = Boolean(raw.excludeRecursion);
            raw.preventRecursion = Boolean(raw.preventRecursion);
            raw.extensions = { ...(raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}) };
            raw.extensions.exclude_recursion = raw.excludeRecursion;
            raw.extensions.prevent_recursion = raw.preventRecursion;
            entries[String(uid)] = raw;
        }
        return entries;
    }
    
    function worldbookRecordLabel(record) {
        const raw = record?.raw || {};
        const keys = Array.isArray(raw.key) ? raw.key.filter(Boolean).join('、') : '';
        return String(raw.comment || raw.name || keys || `条目 ${record?.uid || ''}`);
    }
    
    function worldbookTextCharacterCount(value) {
        return Array.from(String(value || '').replace(/\s/g, '')).length;
    }
    
    function worldbookWordCount(record) {
        return worldbookTextCharacterCount(record?.raw?.content);
    }
    
    function worldbookRecordSearchText(record) {
        const raw = record?.raw || {};
        return [
            worldbookRecordLabel(record),
            record?.uid,
            ...(Array.isArray(raw.key) ? raw.key : []),
            ...(Array.isArray(raw.keysecondary) ? raw.keysecondary : []),
            raw.content || '',
            raw.group || '',
        ].join('\n').toLowerCase();
    }
    
    function worldbookUidNumber(record) {
        const value = Number(record?.raw?.uid ?? record?.uid);
        return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    }
    
    // Match SillyTavern's final prompt order for the internal worldbook list.
    // ST processes activated entries by Order descending, then unshifts the
    // before/after, author-note and example buckets. Thus the visible text
    // order within each position is Order ascending. Depth/chat interleaving
    // is intentionally not flattened here; only worldbook-internal order is
    // represented. UID is only a deterministic tie-breaker for equal Order.
    function worldbookPosition(raw) {
        const value = Number(raw?.position);
        return Number.isInteger(value) && value >= 0 && value <= 7 ? value : 1;
    }
    
    function worldbookOrder(raw) {
        const value = Number(raw?.order);
        return Number.isFinite(value) ? value : 0;
    }
    
    function worldbookDepth(raw) {
        const value = Number(raw?.depth);
        return Number.isFinite(value) ? value : 4;
    }
    
    function worldbookGroupKey(record) {
        const position = Number.isInteger(Number(record?.raw?.position)) ? Number(record.raw.position) : 1;
        return position === 4 ? `position-${position}-depth-${Number(record?.raw?.depth ?? 4)}` : `position-${position}`;
    }
    
    function sortWorldbookRecords(records) {
        const list = Array.isArray(records) ? records.slice() : [];
        return list.sort((a, b) => {
            const positionCompare = worldbookPosition(a.raw) - worldbookPosition(b.raw);
            if (positionCompare) return positionCompare;
            // At-depth entries are placed by chat depth first.  Larger depth
            // means an earlier position in the prompt history; Order only
            // controls entries sharing that same depth.
            if (worldbookPosition(a.raw) === 4) {
                const depthCompare = worldbookDepth(b.raw) - worldbookDepth(a.raw);
                if (depthCompare) return depthCompare;
            }
            return worldbookOrder(a.raw) - worldbookOrder(b.raw)
                || worldbookUidNumber(a) - worldbookUidNumber(b)
                || Number(a.displayIndex ?? 0) - Number(b.displayIndex ?? 0);
        });
    }
    
    function normalizeWorldbookDisplayIndexes(records) {
        const ordered = (Array.isArray(records) ? records.slice() : []).sort((a, b) => Number(a.displayIndex ?? 0) - Number(b.displayIndex ?? 0)
            || worldbookUidNumber(a) - worldbookUidNumber(b));
        ordered.forEach((record, index) => {
            record.displayIndex = index;
            record.raw.displayIndex = index;
            if (record.raw.extensions && typeof record.raw.extensions === 'object') {
                if (Object.prototype.hasOwnProperty.call(record.raw.extensions, 'displayIndex')) record.raw.extensions.displayIndex = index;
                if (Object.prototype.hasOwnProperty.call(record.raw.extensions, 'display_index')) record.raw.extensions.display_index = index;
            }
        });
        return records;
    }
    
    function currentWorldbookView() {
        // Manager and AI context use the same position-first comparator.
        return sortWorldbookRecords(worldbookEntries);
    }
    
    function markWorldbookDirty() {
        worldbookDirty = true;
        worldbookSimulation = null;
        if (worldbookBook) {
            worldbookPendingDocuments.set(worldbookBook, {
                ...(worldbookDocument || {}),
                entries: serializeWorldbookRecords(worldbookEntries),
            });
        }
    }
    
    function markWorldbookDraftDirty() {
        worldbookDraftDirty = true;
        if (!getRoot()) return;
        const draftStatus = getRoot().querySelector('[data-worldbook-draft-status]');
        if (draftStatus) draftStatus.textContent = '当前条目有未暂存修改';
        const saveStatus = getRoot().querySelector('[data-worldbook-save-status]');
        if (saveStatus) saveStatus.textContent = '有未保存的修改';
    }
    
    function syncWorldbookSelectionUI() {
        if (!getRoot()) return;
        getRoot().querySelectorAll('[data-worldbook-row-uid]').forEach((row) => {
            row.classList.toggle('is-selected', worldbookSelected.has(String(row.dataset.worldbookRowUid)));
        });
        const count = getRoot().querySelector('[data-worldbook-selected-count]');
        if (count) count.textContent = `已选 ${worldbookSelected.size} 条`;
        getRoot().querySelectorAll('[data-worldbook-needs-selection]').forEach((button) => {
            button.disabled = worldbookSelected.size === 0;
        });
        const copyToBook = getRoot().querySelector('[data-action="copy-worldbook-entries-to-book"]');
        if (copyToBook) copyToBook.disabled = worldbookSelected.size === 0 || !worldbookCopyTarget;
    }
    
    async function loadWorldbookManager({ force = false, book = '', contextKey = currentWorldbookContextKey() } = {}) {
        if (worldbookLoading) return;
        if (worldbookLoadScheduledContextKey === contextKey) worldbookLoadScheduledContextKey = '';
        worldbookLoading = true;
        renderPanel();
        try {
            if (force || !worldbookBooks.length) worldbookBooks = await getWorldBookNames(force);
            const boundBook = currentCharacterWorldBookName();
            if (boundBook && !worldbookBooks.includes(boundBook)) {
                const refreshed = await getWorldBookNames(true);
                if (refreshed.length) worldbookBooks = refreshed;
            }
            const contextChanged = contextKey !== worldbookLoadedContextKey;
            const preferred = String(book || (!contextChanged ? worldbookBook : '') || boundBook || '');
            worldbookBook = worldbookBooks.includes(preferred) ? preferred : (worldbookBooks[0] || '');
            const pendingDocument = worldbookPendingDocuments.get(worldbookBook);
            if (worldbookBook) {
                worldbookDocument = pendingDocument
                    ? deepClone(pendingDocument)
                    : (force
                        ? await loadFreshWorldInfoDocument(worldbookBook)
                        : await loadWorldInfoDocument(worldbookBook));
                worldbookEntries = sortWorldbookRecords(worldbookRecords(worldbookDocument));
            } else {
                worldbookDocument = null;
                worldbookEntries = [];
            }
            worldbookSelected = new Set();
            worldbookVisibleLimit = 120;
            worldbookEditingUid = '';
            worldbookDraft = null;
            worldbookDraftDirty = false;
            worldbookBatchMode = false;
            worldbookCopyTarget = worldbookBooks.find((name) => name !== worldbookBook) || '';
            worldbookDirty = Boolean(pendingDocument);
            worldbookSimulation = null;
        } catch (error) {
            notify(`读取世界书失败：${error.message}`, 'error');
        } finally {
            worldbookLoading = false;
            worldbookLoadedOnce = true;
            if (contextKey === currentWorldbookContextKey()) worldbookLoadedContextKey = contextKey;
            renderPanel();
        }
    }
    
    function canDiscardWorldbookChanges() {
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        return true;
    }
    
    async function chooseWorldbook(name) {
        if (!canDiscardWorldbookChanges()) return renderPanel();
        return loadWorldbookManager({ force: false, book: name });
    }
    
    function editWorldbookEntry(uid) {
        const record = worldbookEntries.find((item) => item.uid === String(uid));
        if (!record) return;
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        worldbookEditingUid = record.uid;
        worldbookDraft = deepClone(record.raw);
        worldbookDraftDirty = false;
        renderPanel();
    }
    
    function toggleWorldbookEntry(uid) {
        const id = String(uid || '');
        if (id && id === String(worldbookEditingUid)) {
            if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
            worldbookEditingUid = '';
            worldbookDraft = null;
            worldbookDraftDirty = false;
            renderPanel();
            return;
        }
        editWorldbookEntry(id);
    }
    
    function discardWorldbookDraft() {
        if (!worldbookEditingUid) return;
        const record = worldbookEntries.find((item) => item.uid === String(worldbookEditingUid));
        worldbookDraft = record ? deepClone(record.raw) : null;
        worldbookDraftDirty = false;
        renderPanel();
    }
    
    function applyWorldbookDraft({ quiet = false } = {}) {
        if (!worldbookDraft || !worldbookEditingUid) return false;
        const record = worldbookEntries.find((item) => item.uid === String(worldbookEditingUid));
        if (!record) return false;
        const uid = worldbookInteger(record.raw?.uid ?? record.uid, 0);
        record.raw = deepClone(worldbookDraft);
        record.raw.uid = uid;
        // 有次要关键词时启用次要关键词匹配。
        record.raw.selective = Array.isArray(record.raw.keysecondary) && record.raw.keysecondary.length > 0;
        record.raw.selectiveLogic = [0, 1, 2, 3].includes(Number(record.raw.selectiveLogic)) ? Number(record.raw.selectiveLogic) : 0;
        record.uid = String(uid);
        record.displayIndex = worldbookDisplayIndex(record.raw, record.displayIndex ?? 0);
        worldbookDraft = deepClone(record.raw);
        worldbookDraftDirty = false;
        markWorldbookDirty();
        if (!quiet) {
            renderPanel();
            notify('条目修改已暂存；请点击“保存世界书”写入文件', 'success');
        }
        return true;
    }
    
    function createWorldbookEntry() {
        if (!worldbookBook) return;
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        const used = new Set(worldbookEntries.map((record) => worldbookUidNumber(record)).filter((value) => Number.isSafeInteger(value)));
        const uid = nextWorldbookUid(used);
        normalizeWorldbookDisplayIndexes(worldbookEntries);
        const displayIndex = worldbookEntries.length;
        const raw = {
            uid, comment: '新条目', key: [], keysecondary: [], content: '',
            constant: false, selective: false, selectiveLogic: 0,
            order: 1, position: 0, disable: false,
            depth: 4, probability: 100, useProbability: true, group: '',
            excludeRecursion: false, preventRecursion: false, displayIndex,
        };
        const maxOrder = worldbookEntries
            .filter((record) => worldbookGroupKey(record) === worldbookGroupKey({ raw }))
            .reduce((max, record) => Math.max(max, Number(record.raw?.order) || 0), 0);
        raw.order = maxOrder + 1;
        worldbookEntries.push({ uid: String(uid), raw, displayIndex });
        worldbookEditingUid = String(uid);
        worldbookDraft = deepClone(raw);
        worldbookDraftDirty = false;
        markWorldbookDirty();
        renderPanel();
    }
    
    async function saveCurrentWorldbook() {
        if (!worldbookBook || worldbookSaving) return false;
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        worldbookSaving = true;
        renderPanel();
        try {
            const next = { ...(worldbookDocument || {}), entries: serializeWorldbookRecords(worldbookEntries) };
            const verified = await saveWorldInfoDocument(worldbookBook, next, { immediate: true, refreshList: false });
            const editingUid = worldbookEditingUid;
            worldbookDocument = verified;
            worldbookEntries = sortWorldbookRecords(worldbookRecords(verified));
            worldbookDirty = false;
            worldbookDraftDirty = false;
            worldbookPendingDocuments.delete(worldbookBook);
            if (editingUid) {
                const record = worldbookEntries.find((item) => item.uid === String(editingUid));
                worldbookDraft = record ? deepClone(record.raw) : null;
                worldbookEditingUid = record ? record.uid : '';
            }
            notify(`世界书“${worldbookBook}”已保存，共 ${worldbookEntries.length} 条`, 'success');
            return true;
        } catch (error) {
            notify(`保存世界书失败：${error.message}`, 'error');
            return false;
        } finally {
            worldbookSaving = false;
            renderPanel();
        }
    }
    
    async function savePendingWorldbooks() {
        const pending = [...worldbookPendingDocuments.entries()]
            .filter(([name]) => String(name) !== String(worldbookBook));
        for (const [name, document] of pending) {
            try {
                await saveWorldInfoDocument(name, document, { immediate: true, refreshList: false });
                worldbookPendingDocuments.delete(name);
            } catch (error) {
                notify(`保存世界书“${name}”失败：${error.message}`, 'error');
                return false;
            }
        }
        return true;
    }
    
    async function createWorldbookBook() {
        if ((worldbookDraftDirty || worldbookDirty) && !canDiscardWorldbookChanges()) return;
        const name = String(await requestDialog({
            kind: 'prompt',
            title: '新建世界书',
            label: '世界书名称',
            placeholder: '输入世界书名称',
            confirmLabel: '创建',
        }) || '').trim();
        if (!name) return;
        if (worldbookBooks.includes(name)) return notify('已经存在同名世界书', 'warning');
        try {
            await saveWorldInfoDocument(name, { entries: {} }, { immediate: true, refreshList: true });
            worldbookBooks = [];
            await loadWorldbookManager({ force: true, book: name });
            notify(`世界书“${name}”已创建`, 'success');
        } catch (error) {
            notify(`创建世界书失败：${error.message}`, 'error');
        }
    }
    
    async function deleteWorldbookBook(name) {
        const book = String(name || worldbookBook || '');
        if (!book) return;
        const confirmed = await requestDialog({
            title: '删除世界书',
            message: `确定删除世界书“${book}”吗？此操作会删除文件。`,
            confirmLabel: '删除',
            danger: true,
        });
        if (!confirmed) return;
        try {
            await stProxyJson('/api/worldinfo/delete', { name: book });
            worldbookBooks = [];
            await loadWorldbookManager({ force: true });
            notify(`世界书“${book}”已删除`, 'success');
        } catch (error) {
            notify(`删除世界书失败：${error.message}`, 'error');
        }
    }
    
    async function renameWorldbookBook() {
        if (!worldbookBook) return;
        const oldName = worldbookBook;
        const name = String(await requestDialog({
            kind: 'prompt',
            title: '重命名世界书',
            label: '世界书名称',
            value: oldName,
            placeholder: '输入新的世界书名称',
            confirmLabel: '保存',
        }) || '').trim();
        if (!name || name === oldName) return;
        if (worldbookBooks.includes(name)) return notify('已经存在同名世界书', 'warning');
        try {
            if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
            const next = { ...(worldbookDocument || {}), entries: serializeWorldbookRecords(worldbookEntries) };
            await saveWorldInfoDocument(name, next, { immediate: true, refreshList: true, verify: true });
            await stProxyJson('/api/worldinfo/delete', { name: oldName });
            worldbookBooks = [];
            await loadWorldbookManager({ force: true, book: name });
            notify(`世界书已重命名为“${name}”`, 'success');
        } catch (error) {
            notify(`重命名世界书失败：${error.message}`, 'error');
        }
    }
    
    async function deleteSelectedWorldbookEntries() {
        const ids = [...worldbookSelected];
        if (!ids.length) return;
        const confirmed = await requestDialog({
            title: '删除世界书条目',
            message: `确定删除选中的 ${ids.length} 个条目吗？删除会在当前世界书中暂存，并在保存时写入。`,
            confirmLabel: '删除',
            danger: true,
        });
        if (!confirmed) return;
        if (worldbookDraftDirty && !ids.includes(String(worldbookEditingUid))) applyWorldbookDraft({ quiet: true });
        worldbookEntries = worldbookEntries.filter((record) => !worldbookSelected.has(record.uid));
        normalizeWorldbookDisplayIndexes(worldbookEntries);
        worldbookSelected = new Set();
        if (ids.includes(String(worldbookEditingUid))) {
            worldbookEditingUid = '';
            worldbookDraft = null;
            worldbookDraftDirty = false;
        }
        markWorldbookDirty();
        renderPanel();
        notify(`已暂存删除 ${ids.length} 个条目；关闭世界书管理时再统一保存`, 'success');
    }
    
    function nextWorldbookUid(existing) {
        const used = new Set([...existing].map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value >= 0));
        let uid = 0;
        while (used.has(uid)) uid += 1;
        existing.add(uid);
        return uid;
    }
    
    function copySelectedWorldbookEntries() {
        if (!worldbookBook) return notify('请先选择一本世界书', 'warning');
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        const selected = currentWorldbookView().filter((record) => worldbookSelected.has(record.uid));
        if (!selected.length) return notify('请先勾选要复制的条目', 'warning');
        const used = new Set(worldbookEntries.map((record) => worldbookUidNumber(record)));
        const nextDisplayIndex = worldbookEntries.reduce((max, record) => Math.max(max, Number(record.displayIndex) || 0), -1) + 1;
        const copiedIds = [];
        selected.forEach((source, offset) => {
            const raw = deepClone(source.raw);
            const uid = nextWorldbookUid(used);
            const originalName = String(raw.comment || raw.name || `条目 ${source.uid}`);
            raw.uid = uid;
            raw.comment = `${originalName}（副本）`;
            raw.displayIndex = nextDisplayIndex + offset;
            worldbookEntries.push({ uid: String(uid), raw, displayIndex: raw.displayIndex });
            copiedIds.push(String(uid));
        });
        worldbookSelected = new Set(copiedIds);
        markWorldbookDirty();
        renderPanel();
        notify(`已在当前世界书复制 ${copiedIds.length} 个条目；深度、优先级、位置等设置均已保留`, 'success');
    }
    
    async function copySelectedWorldbookEntriesToBook() {
        if (!worldbookBook) return notify('请先选择一本世界书', 'warning');
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        const target = String(worldbookCopyTarget || '').trim();
        if (!target || target === worldbookBook) return notify('请先选择一本不同名的目标世界书', 'warning');
        const selected = currentWorldbookView().filter((record) => worldbookSelected.has(record.uid));
        if (!selected.length) return notify('请先勾选要复制的条目', 'warning');
        try {
            const document = await loadFreshWorldInfoDocument(target);
            const records = worldbookRecords(document);
            const used = new Set(records.map((record) => worldbookUidNumber(record)));
            let displayIndex = records.reduce((max, record) => Math.max(max, Number(record.displayIndex) || 0), -1) + 1;
            const names = new Set(records.map((record) => worldbookRecordLabel(record)));
            selected.forEach((source) => {
                const raw = deepClone(source.raw);
                const uid = nextWorldbookUid(used);
                const originalName = String(raw.comment || raw.name || `条目 ${source.uid}`);
                let name = `${originalName}（复制）`;
                let suffix = 2;
                while (names.has(name)) name = `${originalName}（复制 ${suffix++}）`;
                names.add(name);
                raw.uid = uid;
                raw.comment = name;
                raw.displayIndex = displayIndex++;
                records.push({ uid: String(uid), raw, displayIndex: raw.displayIndex });
            });
            await saveWorldInfoDocument(target, { ...document, entries: serializeWorldbookRecords(records) }, { immediate: true, refreshList: false, verify: true });
            notify(`已复制 ${selected.length} 个条目到“${target}”，条目设置均已保留`, 'success');
        } catch (error) {
            notify(`复制到目标世界书失败：${error.message}`, 'error');
        }
    }
    
    function mutateWorldbookEntry(uid, mutate) {
        const id = String(uid || '');
        const record = worldbookEntries.find((item) => item.uid === id);
        if (!record || typeof mutate !== 'function') return false;
        if (id === String(worldbookEditingUid) && worldbookDraft) {
            mutate(worldbookDraft);
            markWorldbookDraftDirty();
        } else {
            mutate(record.raw);
            markWorldbookDirty();
        }
        renderPanel();
        return true;
    }
    
    function cycleWorldbookLight(uid) {
        return mutateWorldbookEntry(uid, (raw) => {
            // Keep the two row controls independent: this button changes only
            // the light type, while the adjacent power button owns disable.
            // A closed entry can therefore retain/select its preferred light
            // without being opened as a side effect.
            raw.constant = !raw.constant;
        });
    }
    
    function toggleWorldbookEnabled(uid) {
        return mutateWorldbookEntry(uid, (raw) => { raw.disable = !raw.disable; });
    }
    
    function setWorldbookRecursionFlags(raw, enabled = true) {
        if (!raw || typeof raw !== 'object') return;
        raw.excludeRecursion = Boolean(enabled);
        raw.preventRecursion = Boolean(enabled);
        raw.extensions = { ...(raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}) };
        raw.extensions.exclude_recursion = Boolean(enabled);
        raw.extensions.prevent_recursion = Boolean(enabled);
    }
    
    function enableCurrentWorldbookRecursionGuards() {
        if (!worldbookDraft || !worldbookEditingUid) return;
        setWorldbookRecursionFlags(worldbookDraft, true);
        markWorldbookDraftDirty();
        renderPanel();
    }
    
    function enableSelectedWorldbookRecursionGuards() {
        if (!worldbookSelected.size) return notify('请先勾选要处理的世界书条目', 'warning');
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        let count = 0;
        worldbookEntries.forEach((record) => {
            if (!worldbookSelected.has(record.uid)) return;
            setWorldbookRecursionFlags(record.raw, true);
            count += 1;
        });
        if (count) markWorldbookDirty();
        if (worldbookEditingUid) {
            const record = worldbookEntries.find((item) => item.uid === String(worldbookEditingUid));
            if (record) worldbookDraft = deepClone(record.raw);
        }
        renderPanel();
        notify(`已为 ${count} 个条目开启“不可递归 + 阻止进一步递归”，关闭工具箱时统一保存`, 'success');
    }
    
    function toggleWorldbookBatchMode() {
        worldbookBatchMode = !worldbookBatchMode;
        if (!worldbookBatchMode) worldbookSelected = new Set();
        renderPanel();
    }
    
    function setWorldbookSelection(mode) {
        const visible = currentWorldbookView().filter((record) => {
            const query = worldbookSearch.trim().toLowerCase();
            return !query || worldbookRecordSearchText(record).includes(query);
        });
        if (mode === 'clear') worldbookSelected = new Set();
        else visible.forEach((record) => worldbookSelected.add(record.uid));
        renderPanel();
    }
    
    function worldbookKeywordHits(text, keywords, caseSensitive = false) {
        const source = caseSensitive ? String(text || '') : String(text || '').toLocaleLowerCase();
        return (Array.isArray(keywords) ? keywords : [])
            .map((keyword) => String(keyword || '').trim())
            .filter(Boolean)
            .filter((keyword) => source.includes(caseSensitive ? keyword : keyword.toLocaleLowerCase()));
    }
    
    function promptTemplateMessageRole(value, fallback = 'system') {
        const numeric = Number(value);
        if (numeric === 1) return 'user';
        if (numeric === 2) return 'assistant';
        if (numeric === 0) return 'system';
        const role = String(value || '').toLowerCase();
        if (role === 'user' || role === 'assistant' || role === 'system') return role;
        if (role === 'ai' || role === 'bot' || role === 'character') return 'assistant';
        return fallback;
    }
    
    function worldbookTemplateMessage(entry) {
        const position = worldbookPosition(entry?.raw);
        return {
            role: position === 4 ? promptTemplateMessageRole(entry?.raw?.role) : 'system',
            content: String(entry?.content || '').trim(),
            templateData: { world_info: entry?.raw },
        };
    }
    
    function resolveVariableMacros(value, context = getContext()) {
        const resolveScope = (global) => context.variables?.[global ? 'global' : 'local'];
        let result = String(value || '');
        result = result.replace(/{{\s*(set|add)(global)?var::([^:}]+)::([^}]*)}}/gi, (match, operation, global, name, macroValue) => {
            const scope = resolveScope(Boolean(global));
            const action = String(operation).toLowerCase();
            if (typeof scope?.[action] !== 'function') return match;
            scope[action](String(name).trim(), macroValue);
            return '';
        });
        result = result.replace(/{{\s*(get|inc|dec)(global)?var::([^}]+)}}/gi, (match, operation, global, name) => {
            const scope = resolveScope(Boolean(global));
            const action = String(operation).toLowerCase();
            if (typeof scope?.[action] !== 'function') return match;
            return String(scope[action](String(name).trim()) ?? '');
        });
        return result;
    }
    
    function substituteTemplateText(value) {
        const text = String(value || '');
        const context = getContext();
        try {
            if (typeof context.substituteParams === 'function') {
                const result = String(context.substituteParams(text) ?? text);
                if (!/{{\s*(?:set|get|add|inc|dec)(?:global)?var\b/i.test(result)) return result;
                const macros = context.macros;
                if (macros?.engine?.evaluate && macros?.envBuilder?.buildFromRawEnv) {
                    const evaluated = String(macros.engine.evaluate(result, macros.envBuilder.buildFromRawEnv({ content: result })) ?? result);
                    return resolveVariableMacros(evaluated, context);
                }
                return resolveVariableMacros(result, context);
            }
        } catch (error) {
            console.warn('[聊天工具箱] 酒馆宏解析失败', error);
        }
        return resolveVariableMacros(text, context);
    }
    
    function promptTemplateEjsApi() {
        const candidates = [host, window, globalThis];
        try { candidates.push(host.parent, window.parent); } catch (_) {}
        for (const candidate of candidates) {
            const api = candidate?.EjsTemplate;
            if (typeof api?.evalTemplate === 'function' && typeof api?.prepareContext === 'function') return api;
        }
        return null;
    }
    
    async function renderPromptTemplateText(value, message, index, state) {
        let text = substituteTemplateText(value);
        if (!/<%[=_\-#]?/.test(text)) return text;
        state.api ||= promptTemplateEjsApi();
        if (!state.api) throw new Error('条目中含有 EJS（<% … %>），但未检测到已启用的 Prompt Template 扩展。');
        try {
            state.env ||= await state.api.prepareContext({
                runType: 'custom',
                generateType: 'chat-toolbox-worldbook-simulator',
            }, getChat().length - 1);
            Object.assign(state.env, {
                message_id: index,
                is_last: false,
                is_user: message.role === 'user',
                is_system: message.role === 'system',
                name: undefined,
                world_info: undefined,
                ...(message.templateData || {}),
            });
            text = String(await state.api.evalTemplate(text, state.env, {
                filename: `chat-toolbox/worldbook-simulator/${index}`,
                cache: false,
            }) ?? '');
            return substituteTemplateText(text);
        } catch (error) {
            throw new Error(`第 ${index + 1} 个触发条目的 EJS 解析失败：${error?.message || error}`);
        }
    }
    
    async function simulateWorldbookTriggers() {
        if (!worldbookBook) return notify('请先选择一本世界书', 'warning');
        if (worldbookSimulation?.book === worldbookBook) {
            worldbookSimulation = null;
            renderPanel();
            return;
        }
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        const chat = getChat();
        const start = Math.max(0, chat.length - 2);
        const floors = chat.slice(start).map((message, index) => ({
            id: messageId(message, start + index),
            text: `${messageName(message)}: ${messageText(message)}`,
        }));
        const scanText = floors.map((floor) => floor.text).join('\n');
        const triggered = [];
        let scanned = 0;
        for (const record of currentWorldbookView()) {
            const raw = record.raw || {};
            if (raw.disable) continue;
            scanned += 1;
            if (raw.constant) {
                triggered.push({ uid: record.uid, label: worldbookRecordLabel(record), reason: '常驻条目', raw });
                continue;
            }
            const caseSensitive = Boolean(raw.caseSensitive ?? raw.case_sensitive);
            const primary = worldbookKeywordHits(scanText, raw.key, caseSensitive);
            if (!primary.length) continue;
            const secondaryKeys = Array.isArray(raw.keysecondary) ? raw.keysecondary.filter((item) => String(item || '').trim()) : [];
            const usesSecondary = secondaryKeys.length > 0 && raw.selective !== false;
            const secondary = usesSecondary ? worldbookKeywordHits(scanText, secondaryKeys, caseSensitive) : [];
            const logic = [0, 1, 2, 3].includes(Number(raw.selectiveLogic)) ? Number(raw.selectiveLogic) : 0;
            const secondaryPass = !usesSecondary
                || (logic === 0 && secondary.length > 0)
                || (logic === 1 && secondary.length < secondaryKeys.length)
                || (logic === 2 && secondary.length === 0)
                || (logic === 3 && secondary.length === secondaryKeys.length);
            if (!secondaryPass) continue;
            const logicLabel = ['AND ANY', 'NOT ALL', 'NOT ANY', 'AND ALL'][logic];
            const details = [`主关键词：${primary.join('、')}`];
            if (usesSecondary) {
                details.push(`次要逻辑：${logicLabel}`);
                details.push(secondary.length ? `命中次要：${secondary.join('、')}` : '命中次要：无');
            }
            triggered.push({ uid: record.uid, label: worldbookRecordLabel(record), reason: details.join('；'), raw });
        }
        const templateState = { api: null, env: null, used: false };
        let templateFailures = 0;
        for (let index = 0; index < triggered.length; index += 1) {
            const item = triggered[index];
            const message = worldbookTemplateMessage({ raw: item.raw, content: String(item.raw?.content || '') });
            try {
                const rendered = await renderPromptTemplateText(message.content, message, index, templateState);
                item.characters = worldbookTextCharacterCount(rendered);
            } catch (error) {
                item.characters = worldbookTextCharacterCount(message.content);
                item.reason = `${item.reason}；EJS 解析失败，按原文统计`;
                templateFailures += 1;
                console.warn('[聊天工具箱] 世界书模拟 EJS 解析失败', error);
            }
            delete item.raw;
        }
        const totalCharacters = triggered.reduce((sum, item) => sum + item.characters, 0);
        worldbookSimulation = {
            book: worldbookBook,
            floors: floors.map((floor) => floor.id),
            scanned,
            triggered,
            totalCharacters,
        };
        renderPanel();
        if (templateFailures) notify(`${templateFailures} 个条目的 EJS 解析失败，字数已按原文统计`, 'warning');
    }
    
    function renderWorldbookSimulation() {
        if (!worldbookSimulation || worldbookSimulation.book !== worldbookBook) return '';
        const floorText = worldbookSimulation.floors.length
            ? worldbookSimulation.floors.map((floor) => `#${floor}`).join('、')
            : '无聊天内容';
        const items = worldbookSimulation.triggered.length
            ? worldbookSimulation.triggered.map((item) => `<div class="ctb-worldbook-simulation-item"><strong>${escapeHTML(item.label)} <em>${Number(item.characters) || 0} 字</em></strong><span>${escapeHTML(item.reason)}</span></div>`).join('')
            : '<div class="ctb-hint">最近 2 层没有触发当前世界书的关键词条目。</div>';
        return `<div class="ctb-worldbook-simulation"><div class="ctb-worldbook-simulation-head"><strong>触发结果：${worldbookSimulation.triggered.length} 条 · 总字数 ${Number(worldbookSimulation.totalCharacters) || 0}</strong><span>扫描 ${escapeHTML(floorText)} · 已开启 ${worldbookSimulation.scanned} 条</span></div><div class="ctb-worldbook-simulation-list">${items}</div></div>`;
    }
    
    function renderWorldbookInlineEditor(record) {
        const draft = worldbookDraft || record.raw || {};
        const positionItems = WORLDBOOK_POSITIONS.filter((item) => item.value !== 7);
        if (Number(draft.position) === 7) positionItems.push({ value: 7, label: '命名出口（保留现有设置）' });
        const positionOptions = positionItems.map((item) => `<option value="${item.value}"${Number(draft.position ?? 0) === item.value ? ' selected' : ''}>${item.label}</option>`).join('');
        const logicOptions = [
            { value: 0, label: 'AND ANY · 任一' },
            { value: 1, label: 'NOT ALL · 不全有' },
            { value: 2, label: 'NOT ANY · 一个都没有' },
            { value: 3, label: 'AND ALL · 全部' },
        ].map((item) => `<option value="${item.value}"${Number(draft.selectiveLogic ?? 0) === item.value ? ' selected' : ''}>${item.label}</option>`).join('');
        return `<div class="ctb-worldbook-inline-editor">
            <div class="ctb-worldbook-inline-editor-head"><strong>编辑条目</strong><span data-worldbook-draft-status>${worldbookDraftDirty ? '当前条目有未暂存修改' : '已载入'}</span></div>
            <div class="ctb-worldbook-editor-grid">
                <label class="ctb-field"><span>名称</span><input class="ctb-input" id="ctb-worldbook-comment" placeholder="条目名称" value="${escapeHTML(draft.comment || '')}"></label>
                <label class="ctb-field"><span>关键词逻辑</span><select class="ctb-input" id="ctb-worldbook-selective-logic">${logicOptions}</select></label>
                <label class="ctb-field"><span>关键词</span><input class="ctb-input" id="ctb-worldbook-keys" placeholder="多个关键词用逗号分隔" value="${escapeHTML((Array.isArray(draft.key) ? draft.key : []).join(', '))}"></label>
                <label class="ctb-field"><span>次要关键词</span><input class="ctb-input" id="ctb-worldbook-keysecondary" placeholder="可选；多个关键词用逗号分隔" value="${escapeHTML((Array.isArray(draft.keysecondary) ? draft.keysecondary : []).join(', '))}"></label>
            </div>
            <label class="ctb-field"><span>条目内容</span><textarea class="ctb-input ctb-textarea ctb-manager-content" id="ctb-worldbook-content" placeholder="世界书内容">${escapeHTML(draft.content || '')}</textarea></label>
            <div class="ctb-inline ctb-manager-fields">
                <label class="ctb-mini-field">优先级 <input class="ctb-input" id="ctb-worldbook-order" type="number" value="${escapeHTML(draft.order ?? 100)}"></label>
                <label class="ctb-mini-field">深度 <input class="ctb-input" id="ctb-worldbook-depth" type="number" min="0" value="${escapeHTML(draft.depth ?? 4)}"></label>
                <label class="ctb-mini-field">位置 <select class="ctb-input" id="ctb-worldbook-position">${positionOptions}</select></label>
            </div>
            <div class="ctb-inline ctb-manager-checks">
                <label class="ctb-check"><input id="ctb-worldbook-exclude-recursion" type="checkbox"${draft.excludeRecursion ? ' checked' : ''}> 不可递归</label>
                <label class="ctb-check"><input id="ctb-worldbook-prevent-recursion" type="checkbox"${draft.preventRecursion ? ' checked' : ''}> 阻止进一步递归</label>
                <button type="button" class="ctb-button ctb-recursion-quick" data-action="enable-worldbook-recursion-guards" title="同时勾选不可递归和阻止进一步递归">一键开启递归保护</button>
            </div>
            <div class="ctb-inline ctb-manager-actions">
                <button type="button" class="ctb-button" data-action="discard-worldbook-entry">放弃本条修改</button>
                <button type="button" class="ctb-button ctb-primary" data-action="apply-worldbook-entry">暂存条目</button>
            </div>
        </div>`;
    }
    
    function renderWorldbookRows(records) {
        return records.map((record) => {
            const expanded = record.uid === String(worldbookEditingUid) && !!worldbookDraft;
            const raw = expanded ? worldbookDraft : (record.raw || {});
            const statusClass = raw.disable ? 'is-off' : raw.constant ? 'is-blue' : 'is-green';
            // 灯色与开关仍可独立编辑；关闭时界面统一置灰，但不丢失原灯色。
            const lightClass = raw.constant ? 'is-blue' : 'is-green';
            const selected = worldbookBatchMode && worldbookSelected.has(record.uid);
            const lightTitle = raw.disable
                ? (raw.constant ? '当前关闭（蓝灯设定），点击切换绿灯设定' : '当前关闭（绿灯设定），点击切换蓝灯设定')
                : raw.constant ? '当前蓝灯，点击切换绿灯' : '当前绿灯，点击切换蓝灯';
            const enabledTitle = raw.disable ? '条目已关闭，点击开启' : '条目已开启，点击关闭';
            return `<article class="ctb-worldbook-entry ${statusClass}${expanded ? ' is-expanded' : ''}${selected ? ' is-selected' : ''}" data-worldbook-row-uid="${escapeHTML(record.uid)}">
                <div class="ctb-worldbook-entry-head${worldbookBatchMode ? ' is-batch-mode' : ''}">
                    ${worldbookBatchMode ? `<input type="checkbox" data-worldbook-select-uid="${escapeHTML(record.uid)}"${selected ? ' checked' : ''} aria-label="选择条目 ${escapeHTML(worldbookRecordLabel(record))}">` : ''}
                    <div class="ctb-worldbook-status-controls" aria-label="条目状态">
                        <button type="button" class="ctb-worldbook-enabled-button${raw.disable ? ' is-off' : ' is-on'}" data-action="toggle-worldbook-enabled" data-worldbook-uid="${escapeHTML(record.uid)}" title="${escapeHTML(enabledTitle)}" aria-label="${escapeHTML(enabledTitle)}"><span class="ctb-worldbook-power-track" aria-hidden="true"></span></button>
                        <button type="button" class="ctb-worldbook-light-button ${lightClass}${raw.disable ? ' is-off' : ''}" data-action="cycle-worldbook-light" data-worldbook-uid="${escapeHTML(record.uid)}" title="${escapeHTML(lightTitle)}" aria-label="${escapeHTML(lightTitle)}"><span class="ctb-worldbook-light-dot" aria-hidden="true"></span></button>
                        <span class="ctb-worldbook-word-count" title="正文字符数">${worldbookWordCount(record)} 字</span>
                    </div>
                    <button type="button" class="ctb-worldbook-entry-toggle" data-action="toggle-worldbook-entry" data-worldbook-uid="${escapeHTML(record.uid)}" aria-expanded="${expanded ? 'true' : 'false'}">
                        <span class="ctb-worldbook-entry-main"><strong>${escapeHTML(worldbookRecordLabel(record))}</strong></span>
                        <span class="ctb-worldbook-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M3.5 6 8 10.5 12.5 6"></path></svg></span>
                    </button>
                </div>
                ${expanded ? renderWorldbookInlineEditor(record) : ''}
            </article>`;
        }).join('');
    }
    
    function renderWorldbookTab() {
        const contextKey = currentWorldbookContextKey();
        if ((!worldbookLoadedOnce || worldbookLoadedContextKey !== contextKey)
            && !worldbookLoading
            && worldbookLoadScheduledContextKey !== contextKey) {
            const boundBook = currentCharacterWorldBookName();
            worldbookLoadScheduledContextKey = contextKey;
            host.setTimeout(() => {
                if (worldbookLoadScheduledContextKey !== contextKey) return;
                worldbookLoadScheduledContextKey = '';
                if (currentWorldbookContextKey() !== contextKey || worldbookLoading) return;
                loadWorldbookManager({ book: boundBook, contextKey });
            }, 0);
        }
        const query = worldbookSearch.trim().toLowerCase();
        const filtered = currentWorldbookView().filter((record) => !query || worldbookRecordSearchText(record).includes(query));
        const visible = filtered.slice(0, worldbookVisibleLimit);
        const books = worldbookBooks.map((name) => `<option value="${escapeHTML(name)}"${name === worldbookBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const list = worldbookLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : filtered.length
                ? `<div class="ctb-manager-list" data-ctb-scroll-key="worldbook-list">${renderWorldbookRows(visible)}${filtered.length > visible.length ? `<button type="button" class="ctb-list-more" data-action="more-worldbook-entries">再显示 ${Math.min(120, filtered.length - visible.length)} 条（共 ${filtered.length} 条）</button>` : ''}</div>`
                : '<div class="ctb-world-empty">没有符合条件的条目。</div>';
        const batchTools = worldbookBatchMode ? `<div class="ctb-worldbook-batch-panel">
                    <div class="ctb-worldbook-batch-head">
                        <span class="ctb-worldbook-selected-count" data-worldbook-selected-count>已选 ${worldbookSelected.size} 条</span>
                        <div class="ctb-worldbook-batch-actions">
                            <button type="button" class="ctb-button" data-action="select-all-worldbook-entries">全选</button>
                            <button type="button" class="ctb-button" data-action="clear-worldbook-selection"${worldbookSelected.size ? '' : ' disabled'}>清空</button>
                            <button type="button" class="ctb-button" data-action="copy-worldbook-entries" data-worldbook-needs-selection${worldbookSelected.size ? '' : ' disabled'}>复制</button>
                            <button type="button" class="ctb-button" data-action="new-worldbook-entry"${worldbookBook ? '' : ' disabled'}>新条目</button>
                            <button type="button" class="ctb-button ctb-danger" data-action="delete-worldbook-entries" data-worldbook-needs-selection${worldbookSelected.size ? '' : ' disabled'}>批量删除</button>
                            <button type="button" class="ctb-button ctb-primary-soft" data-action="enable-selected-worldbook-recursion-guards" data-worldbook-needs-selection${worldbookSelected.size ? '' : ' disabled'}>一键递归保护</button>
                        </div>
                    </div>
                    <div class="ctb-worldbook-copy-row">
                        <select class="ctb-input ctb-worldbook-copy-target" id="ctb-worldbook-copy-target" data-worldbook-needs-selection${worldbookSelected.size ? '' : ' disabled'}><option value="">复制到其他世界书…</option>${worldbookBooks.filter((name) => name !== worldbookBook).map((name) => `<option value="${escapeHTML(name)}"${name === worldbookCopyTarget ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('')}</select>
                        <button type="button" class="ctb-button ctb-primary-soft" data-action="copy-worldbook-entries-to-book" data-worldbook-needs-selection${worldbookSelected.size && worldbookCopyTarget ? '' : ' disabled'}>复制到所选书</button>
                    </div>
                </div>` : '';
        return `<section class="ctb-section">
                <div class="ctb-section-title">世界书管理 ${infoButton('worldbook-save')}</div>
                <button type="button" class="ctb-button ctb-primary-soft ctb-worldbook-simulate-button" data-action="simulate-worldbook-triggers" title="读取最近 2 层正文和发言者名称，检查常驻、主关键词与次要关键词逻辑"${worldbookBook && !worldbookLoading ? '' : ' disabled'}>
                    <span><i class="fa-solid fa-bolt"></i> 模拟</span>
                    <small>${worldbookLoading ? '正在加载世界书…' : worldbookBook ? escapeHTML(worldbookBook) : '没有可用世界书'}</small>
                </button>
                <div class="ctb-inline ctb-manager-toolbar">
                    <select class="ctb-input" id="ctb-worldbook-book">${books || '<option value="">没有世界书</option>'}</select>
                    <button type="button" class="ctb-button" data-action="refresh-worldbook">刷新</button>
                    <button type="button" class="ctb-button" data-action="create-worldbook">新建书</button>
                    <button type="button" class="ctb-button" data-action="rename-worldbook"${worldbookBook ? '' : ' disabled'}>重命名</button>
                    <button type="button" class="ctb-button ctb-danger" data-action="delete-worldbook"${worldbookBook ? '' : ' disabled'}>删除书</button>
                </div>
            </section>
            <section class="ctb-section">
                <div class="ctb-inline ctb-manager-toolbar">
                    <input class="ctb-input" id="ctb-worldbook-search" placeholder="搜索条目名称、关键词或内容" value="${escapeHTML(worldbookSearch)}">
                    <button type="button" class="ctb-button" data-action="filter-worldbook">筛选</button>
                    <button type="button" class="ctb-button${worldbookBatchMode ? ' ctb-primary' : ''}" data-action="toggle-worldbook-batch">${worldbookBatchMode ? '完成' : '编辑'}</button>
                </div>
                ${renderWorldbookSimulation()}
                ${batchTools}
                <div class="ctb-worldbook-entry-list">${list}</div>
            </section>
            <div class="ctb-inline ctb-manager-savebar"><span data-worldbook-save-status>${worldbookDraftDirty || worldbookDirty ? '修改已暂存，关闭工具箱时会统一保存' : '当前世界书已同步'}</span><button type="button" class="ctb-button ctb-save" data-action="save-worldbook"${worldbookBook && !worldbookSaving ? '' : ' disabled'}>${worldbookSaving ? '保存中…' : '现在保存'}</button></div>`;
    }

    function discardChanges() {
        worldbookPendingDocuments.clear();
        worldbookDirty = false;
        worldbookDraftDirty = false;
        worldbookDraft = null;
        worldbookEditingUid = '';
        worldbookDocument = null;
        worldbookEntries = [];
        worldbookSelected = new Set();
    }

    async function beforePanelClose() {
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        if (worldbookDirty || worldbookPendingDocuments.size) {
            const decision = await requestDialog({
                title: '保存世界书并关闭',
                message: '世界书有未保存修改。你可以保存后关闭、直接放弃修改退出，或返回继续编辑。',
                buttons: [
                    { label: '保存并关闭', value: 'save', tone: 'primary' },
                    { label: '不保存退出', value: 'discard', tone: 'danger' },
                    { label: '取消继续编辑', value: 'cancel' },
                ],
            });
            if (decision === 'cancel' || decision === null) return false;
            if (decision === 'discard') {
                discardChanges();
                return true;
            }
            if (worldbookDirty && !(await saveCurrentWorldbook())) return false;
            if (!(await savePendingWorldbooks())) return false;
        }
        return true;
    }

    function handleInput(target) {
        const id = target?.id;
        if (id === 'ctb-worldbook-search') worldbookSearch = target.value;
        else if (id === 'ctb-worldbook-comment' && worldbookDraft) { worldbookDraft.comment = target.value; markWorldbookDraftDirty(); }
        else if (id === 'ctb-worldbook-keys' && worldbookDraft) { worldbookDraft.key = target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); markWorldbookDraftDirty(); }
        else if (id === 'ctb-worldbook-keysecondary' && worldbookDraft) { worldbookDraft.keysecondary = target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); markWorldbookDraftDirty(); }
        else if (id === 'ctb-worldbook-content' && worldbookDraft) { worldbookDraft.content = target.value; markWorldbookDraftDirty(); }
        else if (id === 'ctb-worldbook-order' && worldbookDraft) { worldbookDraft.order = Number(target.value) || 0; markWorldbookDraftDirty(); }
        else if (id === 'ctb-worldbook-depth' && worldbookDraft) { worldbookDraft.depth = Math.max(0, Number(target.value) || 0); markWorldbookDraftDirty(); }
        else return false;
        return true;
    }

    async function handleChange(target) {
        const id = target?.id;
        if (target?.dataset?.worldbookSelectUid !== undefined) {
            const uid = String(target.dataset.worldbookSelectUid);
            if (target.checked) worldbookSelected.add(uid);
            else worldbookSelected.delete(uid);
            syncWorldbookSelectionUI();
        } else if (id === 'ctb-worldbook-copy-target') {
            worldbookCopyTarget = String(target.value || '');
            syncWorldbookSelectionUI();
        } else if (id === 'ctb-worldbook-book') {
            await chooseWorldbook(target.value);
        } else if (id === 'ctb-worldbook-position' && worldbookDraft) {
            worldbookDraft.position = Number(target.value) || 0;
            markWorldbookDraftDirty();
            renderPanel();
        } else if (id === 'ctb-worldbook-selective-logic' && worldbookDraft) {
            worldbookDraft.selectiveLogic = [0, 1, 2, 3].includes(Number(target.value)) ? Number(target.value) : 0;
            markWorldbookDraftDirty();
        } else if (id === 'ctb-worldbook-exclude-recursion' && worldbookDraft) {
            worldbookDraft.excludeRecursion = target.checked;
            worldbookDraft.extensions = { ...(worldbookDraft.extensions && typeof worldbookDraft.extensions === 'object' ? worldbookDraft.extensions : {}) };
            worldbookDraft.extensions.exclude_recursion = target.checked;
            markWorldbookDraftDirty();
        } else if (id === 'ctb-worldbook-prevent-recursion' && worldbookDraft) {
            worldbookDraft.preventRecursion = target.checked;
            worldbookDraft.extensions = { ...(worldbookDraft.extensions && typeof worldbookDraft.extensions === 'object' ? worldbookDraft.extensions : {}) };
            worldbookDraft.extensions.prevent_recursion = target.checked;
            markWorldbookDraftDirty();
        } else return false;
        return true;
    }

    async function handleAction(action, data = {}) {
        switch (action) {
            case 'refresh-worldbook': canDiscardWorldbookChanges(); await loadWorldbookManager({ force: true, book: worldbookBook }); return true;
            case 'create-worldbook': await createWorldbookBook(); return true;
            case 'rename-worldbook': await renameWorldbookBook(); return true;
            case 'delete-worldbook': await deleteWorldbookBook(); return true;
            case 'new-worldbook-entry': createWorldbookEntry(); return true;
            case 'toggle-worldbook-batch': toggleWorldbookBatchMode(); return true;
            case 'simulate-worldbook-triggers': await simulateWorldbookTriggers(); return true;
            case 'filter-worldbook': worldbookVisibleLimit = 120; renderPanel(); return true;
            case 'more-worldbook-entries': worldbookVisibleLimit += 120; renderPanel(); return true;
            case 'toggle-worldbook-entry': toggleWorldbookEntry(data.worldbookUid); return true;
            case 'cycle-worldbook-light': cycleWorldbookLight(data.worldbookUid); return true;
            case 'toggle-worldbook-enabled': toggleWorldbookEnabled(data.worldbookUid); return true;
            case 'select-all-worldbook-entries': setWorldbookSelection('all'); return true;
            case 'clear-worldbook-selection': setWorldbookSelection('clear'); return true;
            case 'enable-worldbook-recursion-guards': enableCurrentWorldbookRecursionGuards(); return true;
            case 'enable-selected-worldbook-recursion-guards': enableSelectedWorldbookRecursionGuards(); return true;
            case 'apply-worldbook-entry': applyWorldbookDraft(); return true;
            case 'discard-worldbook-entry': discardWorldbookDraft(); return true;
            case 'save-worldbook': await saveCurrentWorldbook(); return true;
            case 'copy-worldbook-entries': copySelectedWorldbookEntries(); return true;
            case 'copy-worldbook-entries-to-book': await copySelectedWorldbookEntriesToBook(); return true;
            case 'delete-worldbook-entries': await deleteSelectedWorldbookEntries(); return true;
            default: return false;
        }
    }

    return {
        renderTab: renderWorldbookTab,
        handleInput,
        handleChange,
        handleAction,
        beforePanelClose,
    };
}
