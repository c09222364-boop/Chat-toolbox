// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      0.9.8
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改、逐段改写、小剧场、世界书管理与预设条目转移
// @match        *://*/*
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.9.8';
    const PREFIX = 'ctb-v090';
    const STYLE_ID = `${PREFIX}-style`;
    const ROOT_ID = `${PREFIX}-root`;
    const FLOAT_ID = `${PREFIX}-float`;
    const ENTRY_ID = `${PREFIX}-menu-entry`;
    const SETTINGS_ID = `${PREFIX}-extension-settings`;
    const INSTANCE_KEY = '__ChatToolbox_v090__';
    const COMMAND_HANDLER_KEY = '__ChatToolboxCommandHandler_v090__';
    const COMMAND_REGISTERED_KEY = '__ChatToolboxCommandRegistered_v090__';
    const LEGACY_INSTANCE_KEYS = ['__ChatToolbox_v080__', '__ChatToolbox_v020__'];
    const STORAGE_KEY = 'chat-toolbox-v020-settings';
    const MAX_RESULTS = 2000;

    let doc = document;
    let host = window;
    try {
        if (window.parent && window.parent !== window && window.parent.document) {
            doc = window.parent.document;
            host = window.parent;
        }
    } catch (_) {}

    // 让从旧版脚本直接升级的用户不会同时留下旧的节点。
    try { host.__ChatSearchReplace_v010__?.(); } catch (_) {}
    for (const legacyKey of LEGACY_INSTANCE_KEYS) {
        try { host[legacyKey]?.(); } catch (_) {}
    }
    try { host[INSTANCE_KEY]?.(); } catch (_) {}

    let root = null;
    let menuObserver = null;
    let injectionTimer = null;
    let onPageHide = null;
    let onUnload = null;
    let commandHandler = null;
    let destroyed = false;
    let activeTab = 'search';
    const panelScrollState = new Map();
    let panelTabsScrollLeft = 0;
    let theaterHistoryView = 'recent';
    let theaterReader = null;
    let theaterRenderSequence = 0;
    const theaterRenderCache = new Map();
    let results = [];
    let currentResultIndex = -1;
    let infoMessage = null;
    let lastUndo = null; // 只在本页脚本内存中保留一份；不会写入聊天文件或 localStorage。
    let dirtyChanges = new Map();
    let searchSaveState = { saving: false, phase: '', startedAt: 0 };
    let searchSaveTimer = null;
    let postEditDraft = null;
    let postEditLoading = false;
    let postEditEditing = false;
    let postEditReview = [];
    let postEditReviewEditingIndex = -1;
    let postEditPromptPreview = '';
    let postEditPreviewLoading = false;
    let channelLoadingId = '';
    let channelEditor = null;
    let rewriteDraft = null;
    let rewriteLoading = false;
    let rewriteReview = [];
    let rewriteApplyLoading = false;
    let rewritePromptPreview = '';
    let rewritePreviewLoading = false;
    let rewriteWorldPickerOpen = false;
    let rewriteWorldLoading = false;
    let rewriteWorldError = '';
    let rewriteWorldBooks = [];
    let rewriteWorldBook = '';
    const rewriteWorldEntryCache = new Map();
    let theaterLoading = false;
    let theaterResult = '';
    let theaterCurrentId = '';
    let theaterHistory = [];
    let theaterWorldPickerOpen = false;
    let theaterWorldLoading = false;
    let theaterWorldError = '';
    let theaterWorldBooks = [];
    let theaterWorldBook = '';
    const theaterWorldEntryCache = new Map();
    let theaterNativePresetLoading = false;
    let theaterNativePresetLoadedOnce = false;
    let theaterNativePresetNames = [];
    let theaterNativePresetName = '';
    let theaterNativePresetEntries = [];
    let theaterNativePresetError = '';
    let worldbookLoading = false;
    let worldbookLoadedOnce = false;
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
    // Keep staged edits when the user changes the selected book.  They are
    // still written only from the close/save checkpoint, never on row changes.
    const worldbookPendingDocuments = new Map();
    let presetTransferLoading = false;
    let presetTransferLoadedOnce = false;
    let presetTransferApi = 'openai';
    let presetTransferSource = '';
    let presetTransferTarget = '';
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
    // The compare view can edit either side through the same draft editor used
    // by the single-preset view.  `side` and `presetName` travel with the draft
    // so a target edit is never accidentally written back to the source.
    let initAttempts = 0;
    // Keep plugin notifications inside the toolbox so API/save errors do not
    // leak into SillyTavern's page-level toastr layer while the panel is open.
    let transientNotice = null;
    let pendingConfirm = null;
    let settings = defaults();
    const ui = {
        query: '',
        replacement: '',
        scope: 'mes',
        regex: false,
        floor: '',
        bookmarkEditing: false,
        bookmarkName: '',
        exportFilename: '',
        exportStart: '',
        exportEnd: '',
        exportTags: '',
        exportIncludeUser: false,
        exportShowName: true,
        exportShowFloor: false,
        exportClean: true,
        exportTagPickerOpen: false,
        exportTagOptions: [],
    };

    const INFO = Object.freeze({
        'search-results': '点击某条结果会跳转到对应楼层；上、下按钮只切换当前结果。',
        'json-readonly': '完整消息 JSON 用于偶尔定位 name、is_user 等结构字段。为避免破坏聊天文件，本范围只能查找。',
        'export-range': '两个楼层留空时导出全部；只填写一个时以该端为界。',
        'export-tags': '填入 content、small_theater 等标签名可只导出标签内部文字；留空则导出整条正文。',
        'export-epub': 'EPUB 会按消息生成章节。首次使用若浏览器没有打包组件，会提示加载一次。',
        'undo': '撤销只保留本次页面会话的最后一次操作，不会写进聊天文件；刷新或重开页面后失效。',
        'post-edit-api': '生成渠道、密钥和规则预设保存在酒馆的插件设置中；酒馆设置不可用时才退回浏览器本地缓存。它们不会写进任何聊天记录。',
        'post-edit-overview': '对所选 AI 楼层做一次低成本的完整词句修订，不带入其他楼层；结果先对照审核，确认后才保存。',
        'post-edit-scope': '填写 content 时，会自动读取并只替换所选楼层 <content> 与 </content> 之间的文字；标签本身和楼层其他内容都保留。',
        'rewrite-scope': '逐段改写会结合选定的历史、角色卡、用户设定和世界书理解剧情，但 API 只返回段落补丁。每段都要由你采用或忽略，未采用的段落不会变化。',
        'rewrite-context': '发送顺序固定为：角色卡 → 用户设定 → 你手动勾选的世界书具体条目 → 所选楼层之前最近 N 楼。这里只发送明确勾选的条目，不会自动混入整本世界书或其他已触发条目。',
        'rewrite-floor-tag': '楼层决定要改写哪一条 AI 回复；正文标签只截取该楼层对应标签内的文字，标签本身与其余内容不会交给模型改写。',
        'channel-main': '“跟随酒馆主接口”不需要重复填写地址和密钥；自定义渠道通过酒馆的 OpenAI 兼容代理请求。',
        'system-cache': '这里的提示词只保存在聊天工具箱的插件设置缓存中，不会写入聊天记录；留空时使用内置默认提示词。',
        'theater-scope': '小剧场只在插件里独立生成和保存最近结果，不会插入聊天楼层，也不会改动原聊天。',
        'worldbook-save': '世界书编辑采用先在界面修改、再一次保存的方式。移动条目时会先保存目标世界书，确认成功后才从来源删除。',
        'preset-transfer': '预设转移分为单预设编辑和双预设对比。复制或移动时可放到列表开头，或放到指定条目后；只处理提示词条目及主 prompt_order，不会修改其他预设参数。',
    });

    function defaults() {
        return {
            uiTheme: 'blue',
            modules: {
                search: true,
                export: true,
                postEdit: true,
                rewrite: true,
                theater: true,
                worldbook: true,
                presetTransfer: true,
            },
            bookmarks: {},
            ai: {
                channels: [],
            },
            postEdit: {
                channelId: 'main',
                tag: 'content',
                floor: '',
                systemPrompt: defaultPostEditSystemPrompt(),
                rules: '',
                selectedPresetId: '',
                presetName: '',
                presets: [],
            },
            rewrite: {
                channelId: 'main',
                tag: 'content',
                floor: '',
                systemPrompt: defaultRewriteSystemPrompt(),
                contextFloors: 4,
                contextTags: '',
                includeCharacter: true,
                includePersona: true,
                worldEntries: [],
                globalInstruction: '',
            },
            theater: {
                channelId: 'main',
                prompt: '',
                contextFloors: 6,
                contextTags: '',
                includeCharacter: true,
                includePersona: true,
                worldEntries: [],
                presetName: '',
                selectedPresetId: '',
                presets: [],
                nativePresetName: '',
                nativePresetEntryIds: [],
                history: [],
                favorites: [],
            },
            presetTransfer: {
                apiId: 'openai',
                source: '',
                target: '',
                mode: 'single',
                loadMode: 'all',
            },
        };
    }

    const MODULES = Object.freeze([
        { key: 'search', tab: 'search', label: '查找/替换' },
        { key: 'export', tab: 'export', label: '文本导出' },
        { key: 'postEdit', tab: 'post-edit', label: '词句修改' },
        { key: 'rewrite', tab: 'rewrite', label: '段落改写' },
        { key: 'theater', tab: 'theater', label: '小剧场' },
        { key: 'worldbook', tab: 'worldbook', label: '世界书管理' },
        { key: 'presetTransfer', tab: 'preset-transfer', label: '预设条目转移' },
    ]);

    function enabledModules() {
        return MODULES.filter((module) => settings.modules?.[module.key] !== false);
    }

    function ensureActiveTab() {
        const enabled = enabledModules();
        if (!enabled.some((module) => module.tab === activeTab)) {
            activeTab = enabled[0]?.tab || '';
        }
        return enabled;
    }

    function normalizeSavedChannel(channel) {
        if (!channel || typeof channel !== 'object') return null;
        const rawMaxTokens = Number(channel.maxTokens);
        const rawTimeout = Number(channel.timeoutSec);
        return {
            id: String(channel.id || `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
            name: String(channel.name || '自定义渠道'),
            url: String(channel.url || ''),
            key: String(channel.key || ''),
            model: String(channel.model || ''),
            models: Array.isArray(channel.models) ? [...new Set(channel.models.map(String).filter(Boolean))] : [],
            temperature: Math.max(0, Math.min(2, Number(channel.temperature) || 0)),
            // 65535 是旧版本的危险默认值，会让部分后端超时或拒绝请求。
            maxTokens: !Number.isFinite(rawMaxTokens) || rawMaxTokens <= 0 || rawMaxTokens >= 65535
                ? 4096
                : Math.max(256, Math.min(32768, Math.round(rawMaxTokens))),
            timeoutSec: !Number.isFinite(rawTimeout) || rawTimeout <= 0
                ? 120
                : Math.max(10, Math.min(600, Math.round(rawTimeout))),
        };
    }

    function loadSettings() {
        try {
            const contextStored = getContext()?.extensionSettings?.[STORAGE_KEY];
            const localStored = contextStored && typeof contextStored === 'object'
                ? {}
                : JSON.parse(host.localStorage?.getItem(STORAGE_KEY) || '{}');
            const stored = contextStored && typeof contextStored === 'object' ? contextStored : localStored;
            const base = defaults();
            const next = base;
            next.ai.channels = (Array.isArray(stored.ai?.channels) ? stored.ai.channels : [])
                .map(normalizeSavedChannel)
                .filter(Boolean);
            if (!next.ai.channels.length && stored.postEdit?.endpoint) {
                const legacyId = `legacy-${Date.now().toString(36)}`;
                next.ai.channels.push(normalizeSavedChannel({
                    id: legacyId,
                    name: '原 API 设置',
                    url: String(stored.postEdit.endpoint || ''),
                    key: String(stored.postEdit.apiKey || ''),
                    model: String(stored.postEdit.model || ''),
                    models: [],
                    temperature: Number(stored.postEdit.temperature) || 0.2,
                    maxTokens: 4096,
                    timeoutSec: 120,
                }));
            }
            const validChannel = (id) => id === 'main' || next.ai.channels.some((channel) => channel.id === id);
            const postChannelId = String(stored.postEdit?.channelId || (stored.postEdit?.endpoint ? next.ai.channels[0]?.id : 'main'));
            const rewriteChannelId = String(stored.rewrite?.channelId || 'main');
            const theaterChannelId = String(stored.theater?.channelId || 'main');
            next.postEdit.channelId = validChannel(postChannelId) ? postChannelId : 'main';
            next.postEdit.systemPrompt = typeof stored.postEdit?.systemPrompt === 'string' ? stored.postEdit.systemPrompt : base.postEdit.systemPrompt;
            next.postEdit.rules = typeof stored.postEdit?.rules === 'string' ? stored.postEdit.rules : '';
            next.postEdit.presets = Array.isArray(stored.postEdit?.presets) ? stored.postEdit.presets : [];
            next.rewrite.channelId = validChannel(rewriteChannelId) ? rewriteChannelId : 'main';
            next.rewrite.systemPrompt = typeof stored.rewrite?.systemPrompt === 'string' ? stored.rewrite.systemPrompt : base.rewrite.systemPrompt;
            next.theater.channelId = validChannel(theaterChannelId) ? theaterChannelId : 'main';
            next.theater.presets = Array.isArray(stored.theater?.presets) ? stored.theater.presets : [];
            next.theater.favorites = Array.isArray(stored.theater?.favorites) ? stored.theater.favorites.slice(0, 50) : [];
            return next;
        } catch (_) {
            return defaults();
        }
    }

    function persistentSettingsSnapshot() {
        return {
            ai: { channels: settings.ai.channels.map(normalizeSavedChannel).filter(Boolean) },
            postEdit: {
                channelId: settings.postEdit.channelId || 'main',
                systemPrompt: String(settings.postEdit.systemPrompt ?? defaultPostEditSystemPrompt()),
                rules: String(settings.postEdit.rules || ''),
                presets: Array.isArray(settings.postEdit.presets) ? settings.postEdit.presets : [],
            },
            rewrite: {
                channelId: settings.rewrite.channelId || 'main',
                systemPrompt: String(settings.rewrite.systemPrompt ?? defaultRewriteSystemPrompt()),
            },
            theater: {
                channelId: settings.theater.channelId || 'main',
                presets: Array.isArray(settings.theater.presets) ? settings.theater.presets : [],
                favorites: Array.isArray(settings.theater.favorites) ? settings.theater.favorites.slice(0, 50) : [],
            },
        };
    }

    function saveSettings() {
        const persistent = persistentSettingsSnapshot();
        let savedToExtension = false;
        try {
            const context = getContext();
            if (context.extensionSettings && typeof context.extensionSettings === 'object') {
                context.extensionSettings[STORAGE_KEY] = JSON.parse(JSON.stringify(persistent));
                context.saveSettingsDebounced?.();
                savedToExtension = true;
            }
        } catch (_) {}
        if (!savedToExtension) {
            try { host.localStorage?.setItem(STORAGE_KEY, JSON.stringify(persistent)); } catch (_) {}
        }
    }

    function notify(message, level = 'info') {
        const toastr = host.toastr;
        if (root && !root.hidden) {
            transientNotice = { message: String(message), level: String(level || 'info') };
            renderPanel();
            const snapshot = transientNotice;
            host.setTimeout(() => {
                if (transientNotice === snapshot) {
                    transientNotice = null;
                    renderPanel();
                }
            }, level === 'error' ? 9000 : 4200);
            return;
        }
        if (toastr && typeof toastr[level] === 'function') toastr[level](message);
        else console.log(`[聊天工具箱] ${message}`);
    }

    function defaultPostEditSystemPrompt() {
        return '你是中文文学文本的词句修订器。逐段检查正文，只修改词句表达，不续写剧情，不新增或删减事实、人物、事件、对白含义与段落顺序。对每一段都给出修改原因，并返回可直接替换的完整修订正文。只输出 JSON，不输出 Markdown。';
    }

    function defaultRewriteSystemPrompt() {
        return '你是中文小说的精确段落改写器。理解给出的剧情和设定，但只改写明确列出的段落；不得续写、删改事实、改变人物关系或段落顺序。每个 replacement 必须对应一个原段落，可以保留段内换行，但不要额外创建段落。只输出 JSON：{"changes":[{"paragraph":2,"replacement":"改写后的完整段落"}]}。必须为每个请求段落返回一项，不要输出分析或 Markdown。';
    }

    function infoButton(key, extraClass = '', inline = false) {
        const className = `ctb-info${extraClass ? ` ${extraClass}` : ''}`;
        const expanded = infoMessage === key;
        if (inline) {
            return `<span class="${className}" data-action="show-info" data-info-key="${key}" role="button" tabindex="0" aria-expanded="${expanded}" aria-label="${expanded ? '关闭说明' : '显示说明'}" title="${expanded ? '关闭说明' : '显示说明'}"><span aria-hidden="true">i</span></span>`;
        }
        return `<button typ…86249 tokens truncated…d': return executeSearch();
            case 'previous-result': return selectResult(currentResultIndex - 1, false);
            case 'next-result': return selectResult(currentResultIndex + 1, false);
            case 'jump-result': return selectResult(Number(data.resultIndex), true);
            case 'replace-current': return replaceCurrent();
            case 'replace-all': return replaceAll();
            case 'save-search-changes': return saveSearchChanges();
            case 'undo': return undoLast();
            case 'export-txt': return exportTXT();
            case 'export-epub': return exportEPUB();
            case 'scan-export-tags': scanExportTags(); return renderPanel();
            case 'close-export-tags': ui.exportTagPickerOpen = false; return renderPanel();
            case 'add-channel': return beginNewChannel(data.feature);
            case 'edit-channel': return beginEditChannel(data.feature, data.channelId);
            case 'save-channel': return saveChannelEditor();
            case 'cancel-channel': return cancelChannelEditor();
            case 'delete-channel': {
                const index = settings.ai.channels.findIndex((channel) => channel.id === data.channelId);
                if (index < 0 || !host.confirm('确定删除这个生成渠道吗？引用它的 AI 功能都会改为跟随酒馆主接口。')) return;
                settings.ai.channels.splice(index, 1);
                if (settings.postEdit.channelId === data.channelId) settings.postEdit.channelId = 'main';
                if (settings.rewrite.channelId === data.channelId) settings.rewrite.channelId = 'main';
                if (settings.theater.channelId === data.channelId) settings.theater.channelId = 'main';
                channelEditor = null;
                saveSettings();
                return renderPanel();
            }
            case 'fetch-models': return fetchChannelModels(data.channelId);
            case 'save-post-preset': return savePostEditPreset();
            case 'delete-post-preset': return deletePostEditPreset();
            case 'prepare-post-edit': return preparePostEditFloor();
            case 'preview-post-edit-prompt': return previewPostEditPrompt();
            case 'close-post-edit-preview': postEditPromptPreview = ''; return renderPanel();
            case 'run-post-edit': return runPostEdit();
            case 'apply-post-edit': return applyPostEdit();
            case 'post-edit-decision': {
                const review = postEditReview[Number(data.reviewIndex)];
                if (review) review.decision = data.decision;
                return renderPanel();
            }
            case 'post-edit-all': postEditReview.forEach((review) => { review.decision = data.decision; }); return renderPanel();
            case 'toggle-post-edit-review-editor':
                postEditReviewEditingIndex = postEditReviewEditingIndex === Number(data.reviewIndex) ? -1 : Number(data.reviewIndex);
                return renderPanel();
            case 'toggle-post-edit-editor': postEditEditing = !postEditEditing; return renderPanel();
            case 'clear-post-edit': postEditDraft = null; postEditEditing = false; postEditReview = []; postEditPromptPreview = ''; postEditReviewEditingIndex = -1; return renderPanel();
            case 'toggle-rewrite-world-picker':
                rewriteWorldPickerOpen = !rewriteWorldPickerOpen;
                if (rewriteWorldPickerOpen) return loadRewriteWorldBooks();
                return renderPanel();
            case 'refresh-rewrite-world-books': return loadRewriteWorldBooks({ force: true });
            case 'close-rewrite-world-picker': rewriteWorldPickerOpen = false; return renderPanel();
            case 'clear-rewrite-world-selection':
                settings.rewrite.worldEntries = [];
                return renderPanel();
            case 'select-rewrite-world-book-all': return setCurrentWorldBookSelection(true);
            case 'clear-rewrite-world-book': return setCurrentWorldBookSelection(false);
            case 'prepare-rewrite': return prepareRewriteFloor();
            case 'preview-rewrite-prompt': return previewRewritePrompt();
            case 'close-rewrite-preview': rewritePromptPreview = ''; return renderPanel();
            case 'run-rewrite': return runRewrite();
            case 'rewrite-select-all': {
                rewriteDraft?.paragraphs?.forEach((paragraph) => { paragraph.selected = data.selected === 'true'; });
                return renderPanel();
            }
            case 'rewrite-decision': {
                const review = rewriteReview[Number(data.reviewIndex)];
                if (review) review.decision = data.decision;
                return renderPanel();
            }
            case 'rewrite-all': rewriteReview.forEach((review) => { review.decision = data.decision; }); return renderPanel();
            case 'apply-rewrite': return applyRewrite();
            case 'toggle-theater-world-picker':
                theaterWorldPickerOpen = !theaterWorldPickerOpen;
                if (theaterWorldPickerOpen) return loadTheaterWorldBooks();
                return renderPanel();
            case 'refresh-theater-world-books': return loadTheaterWorldBooks({ force: true });
            case 'close-theater-world-picker': theaterWorldPickerOpen = false; return renderPanel();
            case 'clear-theater-world-selection': settings.theater.worldEntries = []; syncTheaterSelectionUi(); return undefined;
            case 'select-theater-world-all': return setTheaterWorldBookSelection(true);
            case 'clear-theater-world-book': return setTheaterWorldBookSelection(false);
            case 'refresh-theater-native-presets': return loadTheaterNativePresets({ force: true });
            case 'select-theater-native-preset-all': return setTheaterNativePresetSelection(true);
            case 'clear-theater-native-preset': return setTheaterNativePresetSelection(false);
            case 'save-theater-preset': return saveTheaterPreset();
            case 'delete-theater-preset': return deleteTheaterPreset();
            case 'run-theater': return runTheater();
            case 'preview-theater-prompt': return previewTheaterPrompt();
            case 'close-theater-preview': theaterPromptPreview = ''; return renderPanel();
            case 'set-theater-history-view': theaterHistoryView = data.theaterView === 'favorites' ? 'favorites' : 'recent'; return renderPanel();
            case 'use-theater-history': return loadTheaterHistory(data.theaterId, data.theaterSource);
            case 'toggle-theater-favorite': return toggleTheaterFavorite(data.theaterId, data.theaterSource);
            case 'delete-theater-history': return deleteTheaterHistory(data.theaterId, data.theaterSource);
            case 'open-theater-reader': {
                const item = theaterRecordById(data.theaterId, data.theaterSource);
                if (item) theaterReader = { title: item.prompt || item.time || '小剧场阅读', output: item.output || '' };
                return renderPanel();
            }
            case 'open-theater-current-reader':
                theaterReader = { title: settings.theater.prompt || '小剧场阅读', output: theaterResult };
                return renderPanel();
            case 'close-theater-reader': theaterReader = null; return renderPanel();
            case 'refresh-worldbook':
                canDiscardWorldbookChangesV2();
                return loadWorldbookManager({ force: true, book: worldbookBook });
            case 'create-worldbook': return createWorldbookBook();
            case 'rename-worldbook': return renameWorldbookBook();
            case 'delete-worldbook': return deleteWorldbookBook();
            case 'new-worldbook-entry': return createWorldbookEntry();
            case 'toggle-worldbook-batch': return toggleWorldbookBatchModeV2();
            case 'filter-worldbook': worldbookVisibleLimit = 120; return renderPanel();
            case 'more-worldbook-entries': worldbookVisibleLimit += 120; return renderPanel();
            case 'edit-worldbook-entry': return editWorldbookEntry(data.worldbookUid);
            case 'toggle-worldbook-entry': return toggleWorldbookEntry(data.worldbookUid);
            case 'cycle-worldbook-light': return cycleWorldbookLightV2(data.worldbookUid);
            case 'toggle-worldbook-enabled': return toggleWorldbookEnabledV2(data.worldbookUid);
            case 'select-all-worldbook-entries': return setWorldbookSelectionV2('all');
            case 'clear-worldbook-selection': return setWorldbookSelectionV2('clear');
            case 'enable-worldbook-recursion-guards': return enableCurrentWorldbookRecursionGuardsV2();
            case 'enable-selected-worldbook-recursion-guards': return enableSelectedWorldbookRecursionGuardsV2();
            case 'apply-worldbook-entry': return applyWorldbookDraft();
            case 'discard-worldbook-entry': return discardWorldbookDraftV2();
            case 'save-worldbook': return saveCurrentWorldbook();
            case 'copy-worldbook-entries': return copySelectedWorldbookEntriesV2();
            case 'copy-worldbook-entries-to-book': return copySelectedWorldbookEntriesToBookV2();
            case 'delete-worldbook-entries': return deleteSelectedWorldbookEntries();
            case 'refresh-preset-transfer': return loadPresetTransfer({ force: true });
            case 'filter-preset-transfer': presetTransferVisibleLimit = 120; return renderPanel();
            case 'more-preset-transfer-entries': presetTransferVisibleLimit += 120; return renderPanel();
            case 'set-preset-transfer-mode': return setPresetTransferMode(data.mode);
            case 'swap-preset-sides': return swapPresetTransferSides();
            case 'toggle-preset-compare': presetCompareOpen = !presetCompareOpen; return renderPanel();
            case 'set-preset-anchor':
                presetTransferAnchor = {
                    kind: data.presetAnchorKind === 'after' ? 'after' : 'top',
                    anchorId: data.presetAnchorKind === 'after' ? String(data.presetAnchorId || '') : '',
                };
                return renderPanel();
            case 'toggle-preset-entry': {
                const id = String(data.presetEntryId || '');
                const side = data.presetSide === 'target' ? 'target' : 'source';
                if (presetTransferDraft?.surface === 'list' && presetTransferDraft.side === side && String(presetTransferDraft.id) === id) {
                    presetTransferDraft = null;
                    return renderPanel();
                }
                return startPresetEntryEdit(id, side, 'list');
            }
            case 'edit-preset-entry': return startPresetEntryEdit(data.presetEntryId, data.presetSide || 'source', data.presetSurface || 'list');
            case 'save-preset-edit': return commitPresetEntryDraft();
            case 'cancel-preset-edit': presetTransferDraft = null; return renderPanel();
            case 'copy-preset-entries': return transferPresetEntries('copy');
            case 'move-preset-entries': return transferPresetEntries('move');
            case 'delete-preset-entries': return deletePresetEntries();
            default: return undefined;
        }
    }

    function findMenuRoot() {
        const selectors = ['#options', '#options_menu', '#options-menu', '#options-content', '#options-content-wrapper', '.options-content', '#option_list'];
        for (const selector of selectors) {
            const menu = doc.querySelector(selector);
            if (menu) return menu;
        }
        return null;
    }

    function findExtensionsSettingsRoot() {
        const selectors = [
            '#extensions_settings',
            '#extensions_settings2',
            '.extensions_settings',
        ];
        const candidates = [];
        for (const selector of selectors) {
            doc.querySelectorAll(selector).forEach((node) => {
                if (node.id !== SETTINGS_ID && !node.closest(`#${ROOT_ID}`) && !candidates.includes(node)) candidates.push(node);
            });
        }
        // The Extensions drawer is often `display:none` until the user opens
        // it.  Injecting only into a visible node made the feature switches
        // disappear entirely on first load.  Prefer a visible root, but keep
        // a connected hidden root as a reliable fallback; the panel becomes
        // visible together with the host drawer.
        return candidates.find((node) => node.isConnected && !node.hidden && node.getClientRects?.().length)
            || candidates.find((node) => node.isConnected && !node.hidden)
            || candidates.find((node) => node.isConnected)
            || null;
    }

    function injectExtensionSettings() {
        if (destroyed || !doc.body) return false;
        const target = findExtensionsSettingsRoot();
        if (!target) return false;
        const duplicatePanels = [...doc.querySelectorAll(`#${SETTINGS_ID}`)];
        let panel = duplicatePanels.find((node) => node.parentElement === target) || duplicatePanels[0] || null;
        const kept = panel;
        duplicatePanels.forEach((node) => { if (node !== kept) node.remove(); });
        if (panel?.querySelector('.ctb-extension-settings-header')) {
            panel.remove();
            panel = null;
        }
        if (!panel) {
            panel = doc.createElement('div');
            panel.id = SETTINGS_ID;
            panel.className = 'ctb-extension-settings inline-drawer';
            panel.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>聊天工具箱</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ctb-extension-settings-grid">
                        <div class="ctb-extension-settings-title">功能开关</div>
                        ${MODULES.map((module) => `<label><input type="checkbox" data-ctb-module="${module.key}"> <span>${module.label}</span></label>`).join('')}
                    </div>
                </div>`;
            panel.addEventListener('change', (event) => {
                const input = event.target.closest('[data-ctb-module]');
                if (!input) return;
                const key = input.dataset.ctbModule;
                if (!MODULES.some((module) => module.key === key)) return;
                settings.modules[key] = Boolean(input.checked);
                ensureActiveTab();
                renderPanel();
            });
        }
        panel.className = 'ctb-extension-settings inline-drawer';
        panel.hidden = false;
        panel.querySelectorAll('[data-ctb-module]').forEach((input) => {
            input.checked = settings.modules?.[input.dataset.ctbModule] !== false;
        }, { timeoutSec: channel.timeoutSec });
        if (panel.parentElement !== target) target.appendChild(panel);
        return true;
    }

    function injectMenuEntry() {
        if (destroyed || !doc.body) return false;
        const menu = doc.querySelector('#options .options-content') || findMenuRoot();
        if (!menu) return false;
        let entry = doc.getElementById(ENTRY_ID);
        if (!entry) {
            entry = doc.createElement('a');
            entry.id = ENTRY_ID;
            entry.href = '#';
            entry.className = 'list-group-item';
            entry.innerHTML = '<i class="fa-lg fa-solid fa-toolbox"></i><span>聊天工具箱</span>';
            entry.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); showPanel('search'); });
        }
        if (entry.parentElement !== menu) menu.appendChild(entry);
        return true;
    }

    function scheduleHostInjection() {
        if (destroyed || injectionTimer) return;
        injectionTimer = host.setTimeout(() => {
            injectionTimer = null;
            injectMenuEntry();
            injectExtensionSettings();
        }, 180);
    }

    function registerSlashCommand() {
        try {
            commandHandler = () => {
                if (!destroyed) showPanel('search');
            };
            // The parser keeps command objects beyond an extension reload.
            // Reusing one stable callback prevents old closures from retaining
            // a destroyed panel; a new instance simply replaces this handler.
            host[COMMAND_HANDLER_KEY] = commandHandler;
            if (host[COMMAND_REGISTERED_KEY]) return;
            const parser = host.SillyTavern?.SlashCommandParser;
            const command = host.SillyTavern?.SlashCommand;
            if (parser && command?.fromProps) {
                parser.addCommandObject(command.fromProps({
                    name: 'chat-toolbox',
                    callback: (...args) => host[COMMAND_HANDLER_KEY]?.(...args),
                    helpString: '打开聊天工具箱',
                }));
                host[COMMAND_REGISTERED_KEY] = true;
            }
        } catch (_) {}
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopSearchSaveClock();
        if (injectionTimer) host.clearTimeout(injectionTimer);
        injectionTimer = null;
        menuObserver?.disconnect();
        if (onPageHide) host.removeEventListener('pagehide', onPageHide);
        if (onUnload) host.removeEventListener('unload', onUnload);
        host.removeEventListener('keydown', handleGlobalKeydown, true);
        onPageHide = null;
        onUnload = null;
        if (host[COMMAND_HANDLER_KEY] === commandHandler) {
            host[COMMAND_HANDLER_KEY] = null;
        }
        commandHandler = null;
        theaterReader = null;
        theaterRenderCache.clear();
        theaterHistory = [];
        doc.getElementById(STYLE_ID)?.remove();
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(FLOAT_ID)?.remove();
        doc.getElementById(ENTRY_ID)?.remove();
        doc.getElementById(SETTINGS_ID)?.remove();
        if (host[INSTANCE_KEY] === destroy) delete host[INSTANCE_KEY];
    }

    function init() {
        if (!doc.body) return host.setTimeout(init, 80);
        const context = getContext();
        if ((!context || !context.extensionSettings) && initAttempts++ < 30) return host.setTimeout(init, 100);
        settings = loadSettings();
        theaterHistory = [];
        presetTransferApi = settings.presetTransfer?.apiId || 'openai';
        presetTransferSource = settings.presetTransfer?.source || '';
        presetTransferTarget = settings.presetTransfer?.target || '';
        saveSettings();
        createUI();
        injectMenuEntry();
        injectExtensionSettings();
        host.setTimeout(scheduleHostInjection, 800);
        host.setTimeout(scheduleHostInjection, 900);
        host.setTimeout(scheduleHostInjection, 2200);
        host.setTimeout(scheduleHostInjection, 2300);
        menuObserver = new MutationObserver(() => scheduleHostInjection());
        menuObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        registerSlashCommand();
        onPageHide = destroy;
        onUnload = destroy;
        host.addEventListener('pagehide', onPageHide, { once: true });
        host.addEventListener('unload', onUnload, { once: true });
        host.addEventListener('keydown', handleGlobalKeydown, true);
        host[INSTANCE_KEY] = destroy;
        console.info(`[聊天工具箱] v${VERSION} 已加载`);
    }

    init();
})();

