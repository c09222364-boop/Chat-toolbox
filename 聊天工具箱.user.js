// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      1.0.6
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改、逐段改写、小剧场、世界书管理与预设条目转移
// @match        *://*/*
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.0.6';
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
    let postEditPromptPreview = null;
    let postEditPreviewLoading = false;
    let channelLoadingId = '';
    let channelEditor = null;
    let rewriteDraft = null;
    let rewriteLoading = false;
    let rewriteReview = [];
    let rewriteApplyLoading = false;
    let rewritePromptPreview = null;
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
                worldPresetName: '',
                selectedWorldPresetId: '',
                worldPresets: [],
                presetName: '',
                selectedPresetId: '',
                presets: [],
                nativePresetName: '',
                nativePresetEntryIds: [],
                favorites: [],
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

    function normalizeWorldEntrySelections(values) {
        const seen = new Set();
        const selections = [];
        for (const item of Array.isArray(values) ? values : []) {
            const world = String(item?.world || '').trim();
            const uid = String(item?.uid ?? '').trim();
            if (!world || !uid) continue;
            const key = worldEntrySelectionKey(world, uid);
            if (seen.has(key)) continue;
            seen.add(key);
            selections.push({ world, uid });
        }
        return selections;
    }

    function normalizeTheaterWorldPreset(preset) {
        if (!preset || typeof preset !== 'object') return null;
        const name = String(preset.name || '').trim();
        const worldEntries = normalizeWorldEntrySelections(preset.worldEntries);
        if (!name || !worldEntries.length) return null;
        return {
            id: String(preset.id || `theater-world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
            name,
            worldEntries,
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
            next.theater.worldPresets = (Array.isArray(stored.theater?.worldPresets) ? stored.theater.worldPresets : [])
                .map(normalizeTheaterWorldPreset)
                .filter(Boolean);
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
                worldPresets: (Array.isArray(settings.theater.worldPresets) ? settings.theater.worldPresets : [])
                    .map(normalizeTheaterWorldPreset)
                    .filter(Boolean),
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
        return `<button type="button" class="${className}" data-action="show-info" data-info-key="${key}" aria-expanded="${expanded}" aria-label="${expanded ? '关闭说明' : '显示说明'}" title="${expanded ? '关闭说明' : '显示说明'}"><span aria-hidden="true">i</span></button>`;
    }

    function renderInfoPopup() {
        if (!infoMessage || !INFO[infoMessage]) return '';
        return `<div class="ctb-info-popup" role="status"><span>${escapeHTML(INFO[infoMessage])}</span><button type="button" data-action="close-info" aria-label="关闭说明">×</button></div>`;
    }

    function renderTransientNotice() {
        if (!transientNotice) return '';
        const tone = transientNotice.level === 'error' ? 'error' : transientNotice.level === 'warning' ? 'warning' : transientNotice.level === 'success' ? 'success' : 'info';
        return `<div class="ctb-notice-overlay" role="alertdialog" aria-modal="true"><div class="ctb-notice-card is-${tone}"><div class="ctb-notice-title">${tone === 'error' ? '插件错误' : tone === 'warning' ? '提示' : tone === 'success' ? '已完成' : '聊天工具箱'}</div><div class="ctb-notice-message">${escapeHTML(transientNotice.message)}</div><button type="button" class="ctb-button ctb-primary" data-action="close-notice">知道了</button></div></div>`;
    }

    function renderConfirmDialog() {
        if (!pendingConfirm) return '';
        const isWorldbookClose = pendingConfirm.action === 'close-worldbook';
        const actions = isWorldbookClose
            ? '<button type="button" class="ctb-button ctb-primary" data-action="confirm-dialog">保存并关闭</button><button type="button" class="ctb-button ctb-danger" data-action="discard-worldbook-close">不保存退出</button><button type="button" class="ctb-button" data-action="cancel-dialog">取消继续编辑</button>'
            : '<button type="button" class="ctb-button ctb-primary" data-action="confirm-dialog">确认</button><button type="button" class="ctb-button" data-action="cancel-dialog">取消</button>';
        return `<div class="ctb-notice-overlay" role="dialog" aria-modal="true"><div class="ctb-notice-card is-warning"><div class="ctb-notice-title">${escapeHTML(pendingConfirm.title || '请确认')}</div><div class="ctb-notice-message">${escapeHTML(pendingConfirm.message)}</div><div class="ctb-inline ctb-confirm-actions">${actions}</div></div></div>`;
    }

    function escapeHTML(value) {
        const node = doc.createElement('div');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    }

    function escapeXml(value) {
        return String(value ?? '').replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]));
    }

    function escapeRegex(value) {
        return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function escapeCss(value) {
        if (host.CSS?.escape) return host.CSS.escape(String(value));
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function getContext() {
        return host.SillyTavern?.getContext?.() || {};
    }

    function getChat() {
        const context = getContext();
        if (Array.isArray(context.chat)) return context.chat;
        if (Array.isArray(host.SillyTavern?.chat)) return host.SillyTavern.chat;
        return [];
    }

    function messageId(message, index) {
        const value = message?.message_id ?? message?.mes_id ?? message?.id;
        if (value !== undefined && value !== null && value !== '') {
            const number = Number(value);
            return Number.isFinite(number) ? number : String(value);
        }
        return index;
    }

    function messageText(message) {
        return String(message?.mes ?? message?.message ?? '');
    }

    function setMessageText(message, value) {
        if (!message || typeof message !== 'object') return;
        const previous = messageText(message);
        if ('mes' in message || !('message' in message)) message.mes = value;
        if ('message' in message) message.message = value;
        if (typeof message.extra?.display_text === 'string' && message.extra.display_text === previous) {
            message.extra.display_text = value;
        }
        const swipeId = Number(message.swipe_id);
        if (Array.isArray(message.swipes) && Number.isInteger(swipeId) && swipeId >= 0 && swipeId < message.swipes.length) {
            message.swipes[swipeId] = value;
        }
    }

    function normalizeBlankLines(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            // 统一为“最多一个空行”：连续三个及以上换行（中间允许有空格）压成两个。
            .replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n');
    }

    function collapseExtraBlankLines(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .replace(/(?:\n[ \t]*){3,}/g, '\n\n');
    }

    function messageName(message) {
        if (message?.name !== undefined && message?.name !== null && String(message.name)) return String(message.name);
        return isUserMessage(message) ? (host.SillyTavern?.name1 || '用户') : (host.SillyTavern?.name2 || '角色');
    }

    function isUserMessage(message) {
        return Boolean(message?.is_user || message?.role === 'user');
    }

    function isAssistantMessage(message) {
        return Boolean(message) && !isUserMessage(message) && !message.is_system && message.role !== 'system';
    }

    function currentChatName() {
        const context = getContext();
        const raw = context.chatMetadata?.title || host.SillyTavern?.chatMetadata?.title || context.chatId || host.SillyTavern?.getCurrentChatId?.() || '当前聊天';
        return String(raw).replace(/\.(jsonl?|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '').trim() || '当前聊天';
    }

    function chatKey() {
        const context = getContext();
        return String(context.chatId || context.chatMetadata?.chat_id || context.chatMetadata?.title || currentChatName());
    }

    function getRows() {
        return getChat().map((raw, rawIndex) => ({
            raw,
            rawIndex,
            id: messageId(raw, rawIndex),
            name: messageName(raw),
            text: messageText(raw),
            isUser: isUserMessage(raw),
        }));
    }

    function maxFloor() {
        const rows = getRows();
        if (!rows.length) return 0;
        return rows.reduce((max, row) => Math.max(max, Number(row.id) || row.rawIndex), 0);
    }

    function fieldValue(row, scope) {
        if (scope === 'name' || scope === 'mes') {
            const staged = dirtyChanges.get(dirtyKey(row.rawIndex, scope));
            if (staged) return staged.after;
            return scope === 'name' ? row.name : row.text;
        }
        if (scope === 'json') {
            try { return JSON.stringify(row.raw); } catch (_) { return ''; }
        }
        return row.text;
    }

    function compileRegex(input) {
        const raw = String(input ?? '').trim();
        if (!raw) throw new Error('请输入要查找的内容');
        const slashForm = raw.match(/^\/([\s\S]*)\/([a-z]*)$/i);
        let source = raw;
        let flags = 'gi';
        if (slashForm) {
            source = slashForm[1];
            flags = slashForm[2] || 'g';
        }
        if (!flags.includes('g')) flags += 'g';
        try { return new RegExp(source, flags); }
        catch (error) { throw new Error(`正则语法错误：${error.message}`); }
    }

    function previewFor(text, start, length) {
        const source = String(text ?? '');
        const left = Math.max(0, start - 22);
        const right = Math.min(source.length, start + Math.max(length, 1) + 58);
        const compact = (value) => String(value ?? '').replace(/\s+/g, ' ');
        return {
            before: compact(`${left ? '…' : ''}${source.slice(left, start)}`),
            match: compact(source.slice(start, start + length)),
            after: compact(`${source.slice(start + length, right)}${right < source.length ? '…' : ''}`),
        };
    }

    function executeSearch({ preserveIndex = false, silent = false } = {}) {
        const query = String(ui.query || '');
        const previousIndex = currentResultIndex;
        if (!query.trim()) {
            results = [];
            currentResultIndex = -1;
            renderPanel();
            if (!silent) notify('请输入要查找的内容', 'warning');
            return;
        }

        try {
            const found = [];
            const regex = ui.regex ? compileRegex(query) : null;
            for (const row of getRows()) {
                const value = fieldValue(row, ui.scope);
                if (!value) continue;
                let occurrence = 0;
                if (regex) {
                    regex.lastIndex = 0;
                    for (const match of value.matchAll(regex)) {
                        const matched = match[0] ?? '';
                        const start = match.index ?? 0;
                        occurrence += 1;
                        found.push({ ...row, scope: ui.scope, start, length: matched.length, match: matched, preview: previewFor(value, start, matched.length), regex: true, occurrence });
                        if (found.length >= MAX_RESULTS) break;
                        // 对空匹配留给 matchAll 的规范推进；这里避免异常输入把界面塞满。
                        if (!matched && start >= value.length) break;
                    }
                } else {
                    const needle = query.toLocaleLowerCase();
                    const haystack = value.toLocaleLowerCase();
                    let from = 0;
                    while (from <= haystack.length) {
                        const start = haystack.indexOf(needle, from);
                        if (start < 0) break;
                        const match = value.slice(start, start + query.length);
                        occurrence += 1;
                        found.push({ ...row, scope: ui.scope, start, length: match.length, match, preview: previewFor(value, start, match.length), regex: false, occurrence });
                        if (found.length >= MAX_RESULTS) break;
                        from = start + Math.max(query.length, 1);
                    }
                }
                if (found.length >= MAX_RESULTS) break;
            }
            results = found;
            currentResultIndex = found.length ? (preserveIndex ? Math.min(Math.max(previousIndex, 0), found.length - 1) : 0) : -1;
            renderPanel();
            if (!silent && !found.length) notify('没有找到匹配内容', 'info');
            else if (!silent && found.length >= MAX_RESULTS) notify(`结果超过 ${MAX_RESULTS} 条，仅显示前 ${MAX_RESULTS} 条`, 'warning');
        } catch (error) {
            results = [];
            currentResultIndex = -1;
            renderPanel();
            notify(error.message, 'error');
        }
    }

    function selectedResult() {
        return results[currentResultIndex] || null;
    }

    function selectResult(index, jump) {
        if (!results.length) return;
        currentResultIndex = (index + results.length) % results.length;
        renderPanel();
        const row = root?.querySelector(`[data-result-index="${currentResultIndex}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
        if (jump) {
            jumpToFloor(selectedResult());
            closePanel();
        }
    }

    function jumpToFloor(resultOrFloor) {
        const result = typeof resultOrFloor === 'object' ? resultOrFloor : null;
        const floor = result ? result.id : resultOrFloor;
        if (floor === '' || floor === undefined || floor === null) return;
        try { host.TavernHelper?.triggerSlash?.(`/chat-jump ${floor}`); } catch (_) {}
        const selector = `.mes[mesid="${escapeCss(floor)}"]`;
        const node = doc.querySelector(selector) || (result ? doc.querySelectorAll('.mes')[result.rawIndex] : null);
        if (node) {
            node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            node.classList.add('ctb-jump-highlight');
            host.setTimeout(() => node.classList.remove('ctb-jump-highlight'), 1300);
        }
    }

    async function saveChat() {
        const context = getContext();
        try {
            if (typeof context.saveChat === 'function') {
                await context.saveChat();
                return true;
            }
            if (typeof host.saveChatConditional === 'function') {
                await host.saveChatConditional();
                return true;
            }
            if (host.TavernHelper?.triggerSlash) {
                await host.TavernHelper.triggerSlash('/savechat');
                return true;
            }
        } catch (error) {
            console.warn('[聊天工具箱] 保存失败', error);
        }
        return false;
    }

    async function verifySavedEntries(entries, { timeoutMs = 6000 } = {}) {
        try {
            const context = getContext();
            let endpoint;
            let body;
            if (context.groupId) {
                endpoint = '/api/chats/group/get';
                body = { id: context.chatId };
            } else {
                const character = context.characters?.[context.characterId];
                const avatar = character?.avatar;
                const fileName = String(context.chatId || '').replace(/\.jsonl?$/i, '');
                if (!avatar || !fileName) return null;
                endpoint = '/api/chats/get';
                body = { ch_name: character?.name || '', file_name: fileName, avatar_url: avatar };
            }
            const controller = typeof host.AbortController === 'function' ? new host.AbortController() : null;
            const timeout = controller ? host.setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 6000)) : null;
            let response;
            try {
                response = await (host.fetch || fetch)(endpoint, {
                    method: 'POST',
                    headers: stRequestHeaders(),
                    body: JSON.stringify(body),
                    cache: 'no-store',
                    ...(controller ? { signal: controller.signal } : {}),
                });
            } finally {
                if (timeout) host.clearTimeout(timeout);
            }
            if (!response.ok) return null;
            const data = await response.json().catch(() => null);
            if (!Array.isArray(data)) return null;
            const messages = data[0]?.chat_metadata ? data.slice(1) : data;
            return entries.every((entry) => {
                const message = messages[entry.rawIndex];
                if (!message) return false;
                const actual = entry.field === 'name' ? String(message.name ?? '') : messageText(message);
                const expected = entry.normalize === false
                    ? String(entry.after)
                    : entry.field === 'mes' ? normalizeBlankLines(entry.after) : String(entry.after);
                return actual === expected;
            });
        } catch (error) {
            if (error?.name !== 'AbortError') console.warn('[聊天工具箱] 保存核验暂时不可用', error);
            return null;
        }
    }

    function refreshVisibleMessage(rawIndex) {
        const message = getChat()[rawIndex];
        if (!message) return false;
        const context = getContext();
        const updater = typeof context.updateMessageBlock === 'function'
            ? context.updateMessageBlock.bind(context)
            : typeof host.updateMessageBlock === 'function'
                ? host.updateMessageBlock.bind(host)
                : null;
        if (updater) {
            try {
                updater(rawIndex, message, { rerenderMessage: true });
                return true;
            } catch (error) {
                console.warn('[聊天工具箱] 酒馆原生楼层重渲染失败，使用兼容渲染', error);
            }
        }
        const node = doc.querySelector(`.mes[mesid="${escapeCss(rawIndex)}"]`) || doc.querySelectorAll('.mes')[rawIndex];
        if (!node) return false;
        const textNode = node.querySelector('.mes_text');
        if (textNode) {
            const formatter = host.messageFormatting;
            const text = messageText(message);
            if (typeof formatter === 'function') {
                try { textNode.innerHTML = formatter(text, messageName(message), !!message.is_system, isUserMessage(message), rawIndex, {}, false); }
                catch (_) { textNode.textContent = text; }
            } else textNode.textContent = text;
        }
        node.querySelectorAll('.ch_name, .mes_name, .name_text').forEach((nameNode) => { nameNode.textContent = messageName(message); });
        return true;
    }

    function emitMessageEdited(rawIndex) {
        const context = getContext();
        const type = context.eventTypes?.MESSAGE_EDITED || context.event_types?.MESSAGE_EDITED;
        if (!type || typeof context.eventSource?.emit !== 'function') return;
        Promise.resolve(context.eventSource.emit(type, rawIndex)).catch((error) => console.warn('[聊天工具箱] 消息编辑事件发送失败', error));
    }

    function emitMessageUpdated(rawIndex) {
        const context = getContext();
        const type = context.eventTypes?.MESSAGE_UPDATED || context.event_types?.MESSAGE_UPDATED;
        if (!type || typeof context.eventSource?.emit !== 'function') return;
        Promise.resolve(context.eventSource.emit(type, rawIndex)).catch((error) => console.warn('[聊天工具箱] 消息更新事件发送失败', error));
    }

    async function refreshChangedRows(rawIndexes) {
        const total = rawIndexes.length;
        for (let start = 0; start < total; start += 20) {
            const chunk = rawIndexes.slice(start, start + 20);
            chunk.forEach((rawIndex) => {
                refreshVisibleMessage(rawIndex);
                emitMessageEdited(rawIndex);
                emitMessageUpdated(rawIndex);
            });
            searchSaveState.phase = `聊天文件已保存，正在更新页面 ${Math.min(start + chunk.length, total)} / ${total}…`;
            updateSearchSaveStatus();
            if (start + chunk.length < total) {
                await new Promise((resolve) => (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(resolve));
            }
        }
    }

    function dirtyKey(rawIndex, field) {
        return `${rawIndex}:${field}`;
    }

    function actualFieldValue(rawIndex, field) {
        const message = getChat()[rawIndex];
        return field === 'name' ? String(message?.name ?? '') : messageText(message);
    }

    function stageValue(rawIndex, field, value) {
        const key = dirtyKey(rawIndex, field);
        const existing = dirtyChanges.get(key);
        const before = existing ? existing.before : actualFieldValue(rawIndex, field);
        if (String(value) === String(before)) dirtyChanges.delete(key);
        else dirtyChanges.set(key, { rawIndex, field, before, after: String(value), chatKey: chatKey() });
    }

    function rememberUndo(entries, label, saved = false) {
        lastUndo = { entries, label, saved, at: Date.now() };
    }

    async function undoLast() {
        if (!lastUndo?.entries?.length) {
            notify('本次页面会话没有可撤销的操作', 'info');
            return;
        }
        const backup = lastUndo;
        if (backup.staged) {
            backup.entries.forEach((entry) => stageValue(entry.rawIndex, entry.field, entry.before));
            lastUndo = null;
            executeSearch({ preserveIndex: true, silent: true });
            notify(`已撤销暂存操作：${backup.label}`, 'success');
            return;
        }
        const chat = getChat();
        backup.entries.forEach((entry) => {
            const message = chat[entry.rawIndex];
            if (!message) return;
            if (entry.field === 'name') message.name = entry.before;
            else setMessageText(message, entry.before);
            refreshVisibleMessage(entry.rawIndex);
        });
        const saved = backup.saved ? await saveChat() : true;
        lastUndo = null;
        renderPanel();
        notify(saved ? `已撤销：${backup.label}${backup.saved ? '，并已保存' : '（尚未保存）'}` : '已撤销，但没有找到自动保存接口，请手动保存', saved ? 'success' : 'warning');
    }

    function resultReplacement(result) {
        const value = fieldValue(result, result.scope);
        if (value.slice(result.start, result.start + result.length) !== result.match) throw new Error('结果内容已经变化，请重新查找后再替换');
        let replacement = ui.replacement;
        if (result.regex) {
            const re = compileRegex(ui.query);
            re.lastIndex = 0;
            replacement = result.match.replace(re, ui.replacement);
        }
        const next = value.slice(0, result.start) + replacement + value.slice(result.start + result.length);
        return result.scope === 'mes' ? normalizeBlankLines(next) : next;
    }

    function selectNextAfterReplacement(previous) {
        if (!results.length) {
            currentResultIndex = -1;
            renderPanel();
            return;
        }
        // 如果替换文本本身仍命中查询，跳过这个仍存在的命中；否则允许后续命中因文本变短而落到相同 start。
        const sameMatch = results.findIndex((item) => item.rawIndex === previous.rawIndex && item.start === previous.start && item.match === previous.match);
        let next;
        if (sameMatch >= 0) {
            next = sameMatch + 1 < results.length ? sameMatch + 1 : 0;
        } else {
            next = results.findIndex((item) => item.rawIndex > previous.rawIndex || (item.rawIndex === previous.rawIndex && item.start >= previous.start));
            if (next < 0) next = 0;
        }
        currentResultIndex = next < 0 ? 0 : next;
        renderPanel();
        const row = root?.querySelector(`[data-result-index="${currentResultIndex}"]`);
        row?.scrollIntoView?.({ block: 'nearest' });
    }

    function replaceCurrent() {
        if (ui.scope === 'json') return notify('完整消息 JSON 仅用于查找，不能直接替换', 'warning');
        const result = selectedResult();
        if (!result) return notify('请先查找并选择一个结果', 'warning');
        const message = getChat()[result.rawIndex];
        if (!message) return notify('原消息已经不存在，请重新查找', 'warning');
        try {
            const next = resultReplacement(result);
            const before = fieldValue(result, result.scope);
            if (next === before) return notify('替换后内容没有变化', 'info');
            stageValue(result.rawIndex, result.scope, next);
            rememberUndo([{ rawIndex: result.rawIndex, field: result.scope, before }], `替换楼层 #${result.id}`);
            lastUndo.staged = true;
            executeSearch({ preserveIndex: false, silent: true });
            selectNextAfterReplacement(result);
            notify(`已暂存并定位到下一处；聊天界面尚未改动，当前 ${dirtyChanges.size} 条待保存`, 'success');
        } catch (error) {
            notify(error.message, 'error');
        }
    }

    function replaceAll() {
        if (ui.scope === 'json') return notify('完整消息 JSON 仅用于查找，不能直接替换', 'warning');
        if (!ui.query.trim()) return notify('请输入查找内容', 'warning');
        if (!results.length) return notify('没有可替换的匹配结果', 'info');
        if (!pendingConfirm) {
            pendingConfirm = {
                title: '确认整体替换',
                message: `确定要替换当前范围内的 ${results.length} 个匹配吗？替换只会先暂存，仍需点击“保存修改”才写入聊天文件。`,
                action: 'replace-all',
            };
            return renderPanel();
        }
        return replaceAllNow();
    }

    function replaceAllNow() {
        try {
            const re = ui.regex ? compileRegex(ui.query) : new RegExp(escapeRegex(ui.query), 'gi');
            const changed = [];
            getRows().forEach((row) => {
                const current = fieldValue(row, ui.scope);
                re.lastIndex = 0;
                if (!re.test(current)) return;
                re.lastIndex = 0;
                const replaced = current.replace(re, ui.replacement);
                const next = ui.scope === 'mes' ? normalizeBlankLines(replaced) : replaced;
                if (next === current) return;
                changed.push({ rawIndex: row.rawIndex, field: ui.scope, before: current });
                stageValue(row.rawIndex, ui.scope, next);
            });
            if (!changed.length) return notify('替换后内容没有变化', 'info');
            rememberUndo(changed, `整体替换 ${changed.length} 条消息`);
            lastUndo.staged = true;
            executeSearch({ preserveIndex: true, silent: true });
            notify(`已暂存 ${changed.length} 条消息；聊天界面尚未改动，确认后点击“保存修改”`, 'success');
        } catch (error) {
            notify(error.message, 'error');
        }
    }

    function stageBlankLineCleanup() {
        const changed = [];
        getRows().forEach((row) => {
            const current = fieldValue(row, 'mes');
            const next = collapseExtraBlankLines(current);
            if (next === current) return;
            changed.push({ rawIndex: row.rawIndex, field: 'mes', before: current });
            stageValue(row.rawIndex, 'mes', next);
        });
        if (!changed.length) return notify('当前聊天没有三个及以上的连续换行', 'info');
        rememberUndo(changed, `去除多余空行 ${changed.length} 条消息`);
        lastUndo.staged = true;
        if (ui.scope === 'mes' && ui.query.trim()) executeSearch({ preserveIndex: true, silent: true });
        else renderPanel();
        notify(`已把 ${changed.length} 条消息中的多余空行暂存为一个空行；确认后点击“保存修改”`, 'success');
    }

    async function saveSearchChanges() {
        if (!dirtyChanges.size) return notify('当前没有需要保存的修改', 'info');
        if (searchSaveState.saving) return;
        const entries = Array.from(dirtyChanges.values()).map((entry) => ({ ...entry }));
        const chat = getChat();
        for (const entry of entries) {
            if (entry.chatKey !== chatKey()) return notify('当前聊天已经切换。为避免写错文件，本次暂存没有保存', 'error');
            if (!chat[entry.rawIndex]) return notify(`楼层索引 ${entry.rawIndex} 已不存在，请刷新后重新查找`, 'error');
            if (actualFieldValue(entry.rawIndex, entry.field) !== entry.before) {
                return notify(`有楼层在暂存后发生了变化。为避免覆盖新内容，本次没有保存，请重新查找`, 'error');
            }
        }
        searchSaveState = { saving: true, phase: '正在把暂存稿写入聊天内存…', startedAt: Date.now() };
        renderPanel();
        startSearchSaveClock();
        const metadata = getContext().chatMetadata;
        const previousTainted = metadata?.tainted;
        try {
            entries.forEach((entry) => {
                const message = chat[entry.rawIndex];
                if (entry.field === 'name') message.name = entry.after;
                else setMessageText(message, normalizeBlankLines(entry.after));
            });
            if (metadata && typeof metadata === 'object') metadata.tainted = true;
            searchSaveState.phase = '正在一次保存整个聊天文件…';
            updateSearchSaveStatus();
            const saved = await saveChat();
            if (!saved) throw new Error('酒馆没有返回可用的保存结果');
            searchSaveState.phase = '正在快速核验保存结果（最多 1.5 秒）…';
            updateSearchSaveStatus();
            const verified = await verifySavedEntries(entries, { timeoutMs: 1500 });
            if (verified === false) throw new Error('聊天文件回读结果与暂存稿不一致，可能是酒馆保存超时');
            const count = entries.length;
            dirtyChanges.clear();
            rememberUndo(entries.map((entry) => ({ rawIndex: entry.rawIndex, field: entry.field, before: entry.before })), `保存 ${count} 条替换`, true);
            const changedRows = [...new Set(entries.map((entry) => entry.rawIndex))];
            await refreshChangedRows(changedRows);
            searchSaveState.phase = '保存完成';
            notify(`已一次写入并保存 ${count} 条修改`, 'success');
        } catch (error) {
            entries.forEach((entry) => {
                const message = chat[entry.rawIndex];
                if (!message) return;
                if (entry.field === 'name') message.name = entry.before;
                else setMessageText(message, entry.before);
                refreshVisibleMessage(entry.rawIndex);
            });
            if (metadata && typeof metadata === 'object') metadata.tainted = previousTainted;
            notify(`保存失败，已恢复聊天内存；暂存稿仍保留：${error.message}`, 'error');
        } finally {
            stopSearchSaveClock();
            searchSaveState = { saving: false, phase: '', startedAt: 0 };
            executeSearch({ preserveIndex: true, silent: true });
        }
    }

    function updateSearchSaveStatus() {
        const node = root?.querySelector('#ctb-save-status');
        if (!node || !searchSaveState.saving) return;
        const seconds = Math.max(0, Math.floor((Date.now() - searchSaveState.startedAt) / 1000));
        node.textContent = `${searchSaveState.phase} 已等待 ${seconds} 秒，请勿刷新页面。`;
    }

    function startSearchSaveClock() {
        stopSearchSaveClock();
        updateSearchSaveStatus();
        searchSaveTimer = host.setInterval(updateSearchSaveStatus, 500);
    }

    function stopSearchSaveClock() {
        if (searchSaveTimer) host.clearInterval(searchSaveTimer);
        searchSaveTimer = null;
    }

    function currentBookmarks() {
        const key = chatKey();
        const values = settings.bookmarks[key];
        return Array.isArray(values) ? values : [];
    }

    function saveBookmark() {
        const id = Number(ui.floor);
        if (!Number.isFinite(id) || id < 0) return notify('请输入有效楼层号', 'warning');
        const list = currentBookmarks();
        const label = String(ui.bookmarkName || `楼层 ${id}`).trim() || `楼层 ${id}`;
        const existing = list.find((bookmark) => Number(bookmark.id) === id);
        if (existing) existing.label = label;
        else list.push({ id, label });
        settings.bookmarks[chatKey()] = list;
        ui.bookmarkEditing = false;
        renderPanel();
    }

    function removeBookmark(index) {
        const list = currentBookmarks();
        list.splice(index, 1);
        settings.bookmarks[chatKey()] = list;
        renderPanel();
    }

    function parseTags(value) {
        return [...new Set(String(value || '')
            .split(/[,，\n]/)
            .map((tag) => tag.trim().replace(/^<\/?|\/?>(?=$)/g, ''))
            .filter((tag) => /^[A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*$/.test(tag)))];
    }

    function extractTags(text, tags) {
        if (!tags.length) return text;
        const parts = [];
        tags.forEach((tag) => {
            const re = new RegExp(`<${escapeRegex(tag)}(?:\\s[^<>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, 'gi');
            for (const match of text.matchAll(re)) parts.push({ index: match.index ?? 0, content: match[1] });
        });
        return parts.sort((a, b) => a.index - b.index).map((part) => part.content).join('\n\n');
    }

    function scanExportTags() {
        const ignored = new Set(['a', 'b', 'blockquote', 'body', 'code', 'details', 'div', 'em', 'head', 'html', 'i', 'li', 'ol', 'p', 'pre', 'script', 'small', 'span', 'strong', 'style', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
        const map = new Map();
        for (const row of getRows()) {
            const text = String(row.text || '');
            const openings = new Map();
            const closings = new Map();
            for (const match of text.matchAll(/<([A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
                if (/\/\s*>$/.test(match[0])) continue;
                const key = match[1].toLocaleLowerCase();
                if (ignored.has(key)) continue;
                const item = openings.get(key) || { name: match[1], count: 0 };
                item.count += 1;
                openings.set(key, item);
            }
            for (const match of text.matchAll(/<\/([A-Za-z_\u4e00-\u9fff][\w:.\-\u4e00-\u9fff]*)\s*>/g)) {
                const key = match[1].toLocaleLowerCase();
                closings.set(key, (closings.get(key) || 0) + 1);
            }
            openings.forEach((item, key) => {
                const paired = Math.min(item.count, closings.get(key) || 0);
                if (!paired) return;
                const total = map.get(key) || { name: item.name, count: 0 };
                total.count += paired;
                map.set(key, total);
            });
        }
        ui.exportTagOptions = Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        ui.exportTagPickerOpen = true;
    }

    function setExportTagSelected(name, selected) {
        const current = parseTags(ui.exportTags);
        const key = String(name).toLocaleLowerCase();
        const next = current.filter((tag) => tag.toLocaleLowerCase() !== key);
        if (selected) next.push(name);
        ui.exportTags = next.join(', ');
        const input = root?.querySelector('#ctb-export-tags');
        if (input) input.value = ui.exportTags;
    }

    function cleanText(text) {
        const textarea = doc.createElement('textarea');
        let output = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(br|p|div|li|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
        textarea.innerHTML = output;
        output = textarea.value;
        return output.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function exportRows() {
        const start = ui.exportStart === '' ? 0 : Number(ui.exportStart);
        const end = ui.exportEnd === '' ? Infinity : Number(ui.exportEnd);
        const tags = parseTags(ui.exportTags);
        return getRows().filter((row) => {
            const id = Number(row.id);
            return Number.isFinite(id) && id >= start && id <= end && (ui.exportIncludeUser || !row.isUser);
        }).map((row) => {
            const extracted = extractTags(row.text, tags);
            return { ...row, text: ui.exportClean ? cleanText(extracted) : extracted.trim() };
        }).filter((row) => row.text);
    }

    function download(content, filename, mime = 'text/plain;charset=utf-8') {
        const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
        const url = host.URL.createObjectURL(blob);
        const link = doc.createElement('a');
        link.href = url;
        link.download = filename;
        doc.body.appendChild(link);
        link.click();
        link.remove();
        host.setTimeout(() => host.URL.revokeObjectURL(url), 1500);
    }

    function exportFilename(extension) {
        const base = String(ui.exportFilename || currentChatName()).replace(/\.(txt|epub)$/i, '').trim() || '聊天导出';
        return `${base}.${extension}`;
    }

    function rowExportText(row) {
        const prefixes = [];
        if (ui.exportShowFloor) prefixes.push(`#${row.id}`);
        if (ui.exportShowName) prefixes.push(`【${row.name}】`);
        return `${prefixes.length ? `${prefixes.join(' ')}\n` : ''}${row.text}`;
    }

    function exportTXT() {
        const rows = exportRows();
        if (!rows.length) return notify('当前条件下没有可导出的内容', 'warning');
        download(rows.map(rowExportText).join('\n\n--------------------\n\n'), exportFilename('txt'));
        notify(`已导出 TXT（${rows.length} 条消息）`, 'success');
    }

    function loadScript(src, id) {
        if (doc.getElementById(id)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.id = id;
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            doc.head.appendChild(script);
        });
    }

    async function exportEPUB() {
        const rows = exportRows();
        if (!rows.length) return notify('当前条件下没有可导出的内容', 'warning');
        if (!host.JSZip) {
            notify('正在加载 EPUB 打包组件…', 'info');
            try { await loadScript('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js', `${PREFIX}-jszip`); }
            catch (_) { return notify('EPUB 打包组件加载失败，请检查网络后重试', 'error'); }
        }
        if (!host.JSZip) return notify('没有找到 EPUB 打包组件', 'error');
        const title = String(ui.exportFilename || currentChatName()).replace(/\.(txt|epub)$/i, '') || '聊天导出';
        const author = host.SillyTavern?.name1 || 'SillyTavern User';
        const chapters = rows.map((row, index) => ({
            title: `第 ${index + 1} 节`,
            content: rowExportText(row).split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escapeXml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('\n'),
        }));
        try {
            const zip = new host.JSZip();
            const uuid = `urn:uuid:${Date.now()}-${Math.random().toString(36).slice(2)}`;
            zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
            zip.folder('META-INF').file('container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
            const oebps = zip.folder('OEBPS');
            oebps.file('cover.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)}</title><style>body{text-align:center;margin-top:30%;font-family:sans-serif}h1{font-size:2.2em}</style></head><body><h1>${escapeXml(title)}</h1><p>${escapeXml(author)}</p></body></html>`);
            let manifest = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>';
            let spine = '<itemref idref="cover"/>';
            let nav = '<navPoint id="cover" playOrder="1"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint>';
            chapters.forEach((chapter, index) => {
                const id = `chapter-${index + 1}`;
                const filename = `chapter-${index + 1}.xhtml`;
                const chapterTitle = escapeXml(chapter.title);
                oebps.file(filename, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapterTitle}</title><style>body{font-family:serif;padding:5%;line-height:1.7}h2{text-align:center;border-bottom:1px solid #aaa;padding-bottom:.5em}p{text-indent:2em;margin:.7em 0}</style></head><body><h2>${chapterTitle}</h2>${chapter.content}</body></html>`);
                manifest += `<item id="${id}" href="${filename}" media-type="application/xhtml+xml"/>`;
                spine += `<itemref idref="${id}"/>`;
                nav += `<navPoint id="nav-${id}" playOrder="${index + 2}"><navLabel><text>${chapterTitle}</text></navLabel><content src="${filename}"/></navPoint>`;
            });
            oebps.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(author)}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="BookID">${escapeXml(uuid)}</dc:identifier></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`);
            oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(uuid)}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${nav}</navMap></ncx>`);
            const blob = await zip.generateAsync({ type: 'blob' });
            download(blob, exportFilename('epub'), 'application/epub+zip');
            notify(`已导出 EPUB（${rows.length} 节）`, 'success');
        } catch (error) {
            console.error('[聊天工具箱] EPUB 导出失败', error);
            notify(`EPUB 导出失败：${error.message}`, 'error');
        }
    }

    function latestAssistant() {
        const chat = getChat();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) return { raw: chat[i], rawIndex: i, id: messageId(chat[i], i), text: messageText(chat[i]) };
        }
        return null;
    }

    function assistantAtFloor(value) {
        const wanted = String(value ?? '').trim();
        if (!wanted) return latestAssistant();
        const rows = getRows();
        const row = rows.find((item) => isAssistantMessage(item.raw) && (String(item.id) === wanted || String(item.rawIndex) === wanted));
        return row ? { raw: row.raw, rawIndex: row.rawIndex, id: row.id, text: row.text } : null;
    }

    function postEditTagMatch(text, rawTag) {
        const tag = String(rawTag || '').trim().replace(/^<|>$/g, '');
        if (!/^[A-Za-z][\w.-]*$/.test(tag)) throw new Error('正文标签名无效，请填写 content 这类单独标签名');
        const regex = new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}\\s*>`, 'i');
        const match = regex.exec(String(text ?? ''));
        if (!match) return null;
        const openingLength = match[0].indexOf('>') + 1;
        const innerStart = match.index + openingLength;
        return {
            tag,
            fullStart: match.index,
            fullEnd: match.index + match[0].length,
            innerStart,
            innerEnd: innerStart + match[1].length,
            content: match[1],
        };
    }

    function preparePostEditFloor({ silent = false } = {}) {
        const selected = assistantAtFloor(settings.postEdit.floor);
        if (!selected) {
            if (!silent) notify('没有找到该楼层的 AI 回复', 'warning');
            return false;
        }
        try {
            const match = postEditTagMatch(selected.text, settings.postEdit.tag);
            if (!match) {
                if (!silent) notify(`楼层 #${selected.id} 中没有找到 <${settings.postEdit.tag || 'content'}>…</${settings.postEdit.tag || 'content'}>`, 'warning');
                return false;
            }
            postEditDraft = {
                rawIndex: selected.rawIndex,
                floor: selected.id,
                originalFull: selected.text,
                originalContent: match.content,
                revisedContent: '',
                tag: match.tag,
            };
            postEditEditing = false;
            postEditReview = [];
            postEditReviewEditingIndex = -1;
            postEditPromptPreview = null;
            settings.postEdit.floor = String(selected.id);
            if (!silent) {
                renderPanel();
                notify(`已读取楼层 #${selected.id} 的 <${match.tag}> 正文`, 'success');
            }
            return true;
        } catch (error) {
            if (!silent) notify(error.message, 'error');
            return false;
        }
    }

    function textFromValue(value, seen = new Set(), depth = 0) {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined || depth > 6) return '';
        if (typeof value !== 'object') return '';
        if (seen.has(value)) return '';
        seen.add(value);
        if (Array.isArray(value)) {
            return value.map((item) => textFromValue(item, seen, depth + 1)).filter(Boolean).join('\n');
        }
        const parts = [];
        // Covers SillyTavern generateRaw strings, OpenAI-compatible responses,
        // Anthropic/Gemini blocks, and proxy responses wrapped in data/result.
        for (const key of ['text', 'content', 'output_text', 'response', 'message', 'output', 'data', 'result']) {
            if (value[key] === undefined) continue;
            const text = textFromValue(value[key], seen, depth + 1);
            if (text) parts.push(text);
            if (parts.length) break;
        }
        if (!parts.length && Array.isArray(value.choices)) {
            const text = textFromValue(value.choices, seen, depth + 1);
            if (text) parts.push(text);
        }
        return parts.join('\n');
    }

    function contentBlockText(value) {
        return textFromValue(value);
    }

    function apiOutputText(json) {
        const text = textFromValue(json).trim();
        if (text) return text;
        throw new Error('API 响应中没有找到可用文本');
    }

    function makeChannel(name = '自定义渠道') {
        return {
            id: `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            url: '',
            key: '',
            model: '',
            models: [],
            temperature: 0.2,
            maxTokens: 4096,
            timeoutSec: 120,
        };
    }

    function channelById(id) {
        return settings.ai?.channels?.find((channel) => channel.id === id) || null;
    }

    function cloneChannel(channel) {
        return JSON.parse(JSON.stringify(channel));
    }

    function channelDraftById(id) {
        if (channelEditor?.draft?.id === id) return channelEditor.draft;
        return channelById(id);
    }

    function beginNewChannel(feature) {
        channelEditor = {
            feature,
            isNew: true,
            draft: makeChannel(`自定义渠道 ${settings.ai.channels.length + 1}`),
        };
        renderPanel();
    }

    function beginEditChannel(feature, channelId) {
        const channel = channelById(channelId);
        if (!channel) return;
        channelEditor = { feature, isNew: false, draft: cloneChannel(channel) };
        renderPanel();
    }

    function saveChannelEditor() {
        if (!channelEditor?.draft) return;
        const draft = channelEditor.draft;
        draft.name = String(draft.name || '').trim();
        draft.url = String(draft.url || '').trim();
        if (!draft.name) return notify('请填写渠道名称', 'warning');
        if (!draft.url) return notify('请填写 API 地址', 'warning');
        if (channelEditor.isNew) settings.ai.channels.push(cloneChannel(draft));
        else {
            const index = settings.ai.channels.findIndex((channel) => channel.id === draft.id);
            if (index < 0) return notify('要保存的渠道已经不存在', 'error');
            settings.ai.channels.splice(index, 1, cloneChannel(draft));
        }
        settings[channelEditor.feature].channelId = draft.id;
        const name = draft.name;
        channelEditor = null;
        saveSettings();
        renderPanel();
        notify(`渠道“${name}”已保存`, 'success');
    }

    function cancelChannelEditor() {
        channelEditor = null;
        renderPanel();
    }

    function selectedChannel(feature) {
        const id = settings[feature]?.channelId || 'main';
        return id === 'main' ? null : channelById(id);
    }

    function normalizeProxyUrl(value) {
        let url = String(value || '').trim().replace(/\/+$/, '');
        url = url.replace(/\/chat\/completions$/i, '');
        if (!url) throw new Error('请填写自定义渠道地址');
        try {
            const parsed = new URL(url);
            if (!parsed.pathname || parsed.pathname === '/') url = `${url}/v1`;
        } catch (_) {}
        return url;
    }

    function stRequestHeaders() {
        const context = getContext();
        try {
            if (typeof context.getRequestHeaders === 'function') return context.getRequestHeaders();
            if (typeof host.getRequestHeaders === 'function') return host.getRequestHeaders();
        } catch (_) {}
        return { 'Content-Type': 'application/json' };
    }

    async function stProxyJson(path, body, { timeoutSec = 120 } = {}) {
        const Controller = host.AbortController || globalThis.AbortController;
        const controller = typeof Controller === 'function' ? new Controller() : null;
        const timeoutMs = Math.max(10, Math.min(600, Number(timeoutSec) || 120)) * 1000;
        const timer = controller ? host.setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const response = await (host.fetch || fetch)(path, {
                method: 'POST',
                headers: stRequestHeaders(),
                body: JSON.stringify(body),
                ...(controller ? { signal: controller.signal } : {}),
            });
            const raw = await response.text();
            let json = {};
            try { json = raw ? JSON.parse(raw) : {}; } catch (_) { json = raw; }
            if (!response.ok) {
                const detail = typeof json === 'string' ? json.slice(0, 300) : json?.error?.message || json?.message;
                throw new Error(detail || `酒馆代理请求失败（HTTP ${response.status}）`);
            }
            return json;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动取消`);
            throw error;
        } finally {
            if (timer) host.clearTimeout(timer);
        }
    }

    async function callAiText(feature, messages) {
        const channel = selectedChannel(feature);
        if (!channel) {
            const context = getContext();
            const generateRaw = context.generateRaw || host.generateRaw || host.SillyTavern?.generateRaw;
            if (typeof generateRaw !== 'function') throw new Error('当前酒馆版本没有公开“跟随主接口”的生成方法，请添加自定义渠道');
            const normalized = Array.isArray(messages) ? messages : [];
            const systemPrompt = normalized
                .filter((message) => message?.role === 'system')
                .map((message) => contentBlockText(message?.content))
                .filter(Boolean)
                .join('\n\n');
            const conversation = normalized
                .filter((message) => message?.role !== 'system')
                .map((message) => ({ role: String(message?.role || 'user'), content: contentBlockText(message?.content) }))
                .filter((message) => message.content.trim());
            if (!conversation.length) throw new Error('没有可发送给模型的提示词');
            const output = await generateRaw.call(context, {
                prompt: conversation,
                systemPrompt,
                responseLength: feature === 'theater' ? 4096 : 8192,
            });
            return apiOutputText(output);
        }
        if (!channel.model) throw new Error('请先拉取并选择模型');
        const json = await stProxyJson('/api/backends/chat-completions/generate', {
            chat_completion_source: 'openai',
            reverse_proxy: normalizeProxyUrl(channel.url),
            proxy_password: String(channel.key || ''),
            model: channel.model,
            messages,
            temperature: Math.max(0, Math.min(2, Number(channel.temperature) || 0)),
            max_tokens: Math.max(256, Math.min(32768, Number(channel.maxTokens) || 4096)),
            stream: false,
            presence_penalty: 0,
            frequency_penalty: 0,
        });
        return apiOutputText(json);
    }

    async function fetchChannelModels(channelId) {
        const channel = channelDraftById(channelId);
        if (!channel || channelLoadingId) return;
        channelLoadingId = channelId;
        renderPanel();
        try {
            const json = await stProxyJson('/api/backends/chat-completions/status', {
                chat_completion_source: 'openai',
                reverse_proxy: normalizeProxyUrl(channel.url),
                proxy_password: String(channel.key || ''),
            });
            const source = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json?.data?.data) ? json.data.data : [];
            const models = source.map((item) => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean);
            channel.models = [...new Set(models.map(String))].sort((a, b) => a.localeCompare(b));
            if (!channel.models.length) throw new Error('接口没有返回可选模型');
            if (!channel.models.includes(channel.model)) channel.model = channel.models[0];
            notify(`已拉取 ${channel.models.length} 个模型`, 'success');
        } catch (error) {
            notify(`模型拉取失败：${error.message}`, 'error');
        } finally {
            channelLoadingId = '';
            renderPanel();
        }
    }

    function savePostEditPreset() {
        const config = settings.postEdit;
        const name = String(config.presetName || '').trim();
        const rules = String(config.rules || '').trim();
        if (!name) return notify('请先填写预设名称', 'warning');
        if (!rules) return notify('修改规则为空，不能保存预设', 'warning');
        let preset = config.presets.find((item) => item.id === config.selectedPresetId);
        if (!preset) {
            preset = { id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, name, rules };
            config.presets.push(preset);
            config.selectedPresetId = preset.id;
        } else {
            preset.name = name;
            preset.rules = rules;
        }
        saveSettings();
        renderPanel();
        notify(`规则预设“${name}”已保存`, 'success');
    }

    function deletePostEditPreset() {
        const config = settings.postEdit;
        const index = config.presets.findIndex((item) => item.id === config.selectedPresetId);
        if (index < 0) return;
        const name = config.presets[index].name;
        if (!host.confirm(`确定删除规则预设“${name}”吗？`)) return;
        config.presets.splice(index, 1);
        config.selectedPresetId = '';
        config.presetName = '';
        saveSettings();
        renderPanel();
    }

    function cleanPostEditOutput(value, tag) {
        let text = String(value ?? '').trim();
        text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
            const tagged = postEditTagMatch(text, tag);
            if (tagged) text = tagged.content;
        } catch (_) {}
        return normalizeBlankLines(text);
    }

    function postEditParagraphs(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .split(/\n[ \t]*\n+/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean);
    }

    function postEditParagraphRanges(value) {
        const source = String(value ?? '');
        const ranges = [];
        const separator = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
        let segmentStart = 0;
        const append = (segmentEnd) => {
            const raw = source.slice(segmentStart, segmentEnd);
            const leading = raw.match(/^[ \t\r\n]*/)?.[0].length || 0;
            const trailing = raw.match(/[ \t\r\n]*$/)?.[0].length || 0;
            const start = segmentStart + leading;
            const end = Math.max(start, segmentEnd - trailing);
            const text = source.slice(start, end);
            if (text) ranges.push({ number: ranges.length + 1, start, end, text });
        };
        for (const match of source.matchAll(separator)) {
            append(match.index);
            segmentStart = match.index + match[0].length;
        }
        append(source.length);
        return { source, ranges };
    }

    function postEditReplacementForRange(review, originalParagraphs) {
        const paragraph = Number(review?.paragraph);
        const replacement = String(review?.replacement ?? '').replace(/\r\n?/g, '\n').trim();
        const pieces = postEditParagraphs(replacement);
        if (pieces.length <= 1) return replacement;

        // Some models ignore the requested schema and put a complete revised
        // body into one paragraph's replacement.  Extracting the matching
        // paragraph is safe only when all surrounding paragraphs are still
        // byte-for-byte identical; otherwise stop instead of inserting an
        // entire article into the source paragraph.
        const index = paragraph - 1;
        if (pieces.length === originalParagraphs.length
            && pieces.every((piece, pieceIndex) => pieceIndex === index || piece === originalParagraphs[pieceIndex])) {
            return pieces[index] || '';
        }
        throw new Error(`P${paragraph} 的修改结果包含 ${pieces.length} 个段落，已阻止写入；请把“修改后”编辑为单个完整段落后再采用`);
    }

    function parsePostEditResult(value, originalContent) {
        const originalParagraphs = postEditParagraphs(originalContent);
        const parsed = parseLooseJson(value);
        const rawItems = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.paragraphs)
            ? parsed.paragraphs
            : Array.isArray(parsed?.changes) ? parsed.changes : null;
        if (!rawItems && !parsed) {
            const revised = cleanPostEditOutput(value, '');
            const revisedParagraphs = postEditParagraphs(revised);
            if (revisedParagraphs.length !== originalParagraphs.length) {
                throw new Error(`模型返回了 ${revisedParagraphs.length} 段，但原正文有 ${originalParagraphs.length} 段`);
            }
            return {
                fullRevised: revised,
                reviews: revisedParagraphs.map((replacement, index) => ({
                    paragraph: index + 1,
                    original: originalParagraphs[index] || '',
                    reason: '模型未返回逐段原因；请人工核对。',
                    replacement,
                    decision: 'pending',
                })).filter((item) => item.original !== item.replacement),
            };
        }
        const reviews = (rawItems || []).map((item, index) => {
            const paragraph = Number(item?.paragraph ?? item?.index ?? item?.paragraph_number ?? index + 1);
            if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > originalParagraphs.length) return null;
            // The source of truth is always the locally loaded paragraph.  A
            // model-provided `original` may contain surrounding context and
            // must never change which text is replaced.
            const original = originalParagraphs[paragraph - 1];
            const replacement = cleanPostEditOutput(typeof item === 'string'
                ? item
                : item?.revised ?? item?.replacement ?? item?.after ?? '', '');
            return {
                paragraph,
                original,
                reason: String(item?.reason ?? item?.why ?? '未提供修改原因'),
                replacement,
                decision: 'pending',
            };
        }).filter((item) => item?.original && item.replacement !== item.original);
        const fullText = typeof parsed === 'string'
            ? parsed
            : parsed?.full_text ?? parsed?.fullText ?? parsed?.revised_text ?? parsed?.revisedText;
        const candidate = typeof fullText === 'string' && fullText.trim()
            ? cleanPostEditOutput(fullText, '')
            : '';
        const patched = originalParagraphs.map((paragraph, index) => {
            const review = reviews.find((item) => item.paragraph === index + 1);
            return review ? review.replacement : paragraph;
        }).join('\n\n');
        // Use a complete draft only when it keeps the same paragraph count.
        // Otherwise rebuild it from validated patches so one malformed field
        // cannot make the whole operation fail.
        let fullRevised = candidate
            && postEditParagraphs(candidate).length === originalParagraphs.length
            && (!reviews.length || candidate !== originalContent)
            ? candidate
            : patched;
        if (!reviews.length && candidate && candidate !== originalContent) {
            const candidateParagraphs = postEditParagraphs(candidate);
            if (candidateParagraphs.length === originalParagraphs.length) {
                candidateParagraphs.forEach((replacement, index) => {
                    if (replacement !== originalParagraphs[index]) {
                        reviews.push({
                            paragraph: index + 1,
                            original: originalParagraphs[index],
                            reason: '模型未返回逐段原因；请人工核对。',
                            replacement,
                            decision: 'pending',
                        });
                    }
                });
                fullRevised = candidateParagraphs.join('\n\n');
            }
        }
        return { fullRevised: normalizeBlankLines(fullRevised), reviews };
    }

    function buildPostEditRequest() {
        const config = settings.postEdit;
        return [
            { role: 'system', content: String(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultPostEditSystemPrompt()).trim() },
            {
                role: 'user',
                content: `【修改规则】\n${String(config.rules || '').trim()}\n\n【正文】\n${postEditDraft?.originalContent || ''}\n\n【返回要求】\n只输出一个合法 JSON 对象，不要 Markdown、解释或代码围栏。保持原段落数量和顺序；未修改的段落也可省略。字符串中的换行必须使用 \\n。\n{"paragraphs":[{"paragraph":1,"original":"原段落","reason":"修改原因","revised":"修改后的完整段落"}],"full_text":"完整修改后的正文"}`,
            },
        ];
    }

    function countCharacters(value) {
        return Array.from(String(value ?? '')).length;
    }

    function buildPromptPreview(messages) {
        const items = Array.isArray(messages) ? messages : [];
        return {
            text: items.map((message, index) => `===== ${index + 1}. ${message.role === 'system' ? 'SYSTEM' : 'USER'} =====\n${message.content}`).join('\n\n'),
            characters: items.reduce((total, message) => total + countCharacters(message?.content), 0),
        };
    }

    // Models often wrap JSON in prose or a Markdown fence. Extract one
    // balanced JSON value before giving up so a harmless wrapper does not
    // turn a valid edit into an apparent API failure.
    function parseLooseJson(value) {
        const text = String(value ?? '').trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        try { return JSON.parse(text); } catch (_) {}
        const start = [...text].findIndex((char) => char === '{' || char === '[');
        if (start < 0) return null;
        const stack = [];
        let quoted = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
                continue;
            }
            if (char === '"') {
                quoted = true;
                continue;
            }
            if (char === '{' || char === '[') stack.push(char);
            else if (char === '}' || char === ']') {
                const expected = char === '}' ? '{' : '[';
                if (stack.pop() !== expected) return null;
                if (!stack.length) {
                    try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { return null; }
                }
            }
        }
        return null;
    }

    async function previewPostEditPrompt() {
        if (postEditPreviewLoading) return;
        if (!postEditDraft && !preparePostEditFloor({ silent: true })) return notify('请先读取要修改的 AI 楼层', 'warning');
        postEditPreviewLoading = true;
        renderPanel();
        try {
            postEditPromptPreview = buildPromptPreview(buildPostEditRequest());
        } catch (error) {
            postEditPromptPreview = null;
            notify(`无法生成发送预览：${error.message}`, 'error');
        } finally {
            postEditPreviewLoading = false;
            renderPanel();
        }
    }

    function renderDiffPair(before, after, { emptyAfter = '（删除本段）' } = {}) {
        const left = String(before ?? '');
        const right = String(after ?? '');
        return `<div class="ctb-diff-pair"><div><small>原文</small><p>${escapeHTML(left) || '<em>（空）</em>'}</p></div><div><small>修改后</small><p>${right ? escapeHTML(right) : `<em>${escapeHTML(emptyAfter)}</em>`}</p></div></div>`;
    }

    async function runPostEdit() {
        if (postEditLoading) return;
        if (!postEditDraft && !preparePostEditFloor({ silent: true })) {
            return notify(`所选 AI 回复中没有找到 <${settings.postEdit.tag || 'content'}> 正文`, 'warning');
        }
        const config = settings.postEdit;
        if (!String(config.rules || '').trim()) return notify('请填写词句修改规则', 'warning');
        postEditLoading = true;
        postEditReview = [];
        postEditPromptPreview = null;
        renderPanel();
        try {
            const messages = buildPostEditRequest();
            postEditPromptPreview = buildPromptPreview(messages);
            const output = await callAiText('postEdit', messages);
            const parsed = parsePostEditResult(output, postEditDraft.originalContent);
            if (!parsed.fullRevised) throw new Error('API 返回了空文本');
            postEditReview = parsed.reviews;
            postEditDraft.revisedContent = parsed.fullRevised;
            postEditEditing = false;
            postEditReviewEditingIndex = -1;
            if (!postEditReview.length) throw new Error('没有得到可审核的逐段修改，请检查 system 提示词或模型返回格式');
            notify(`API 修改完成，共 ${postEditReview.length} 段待审核`, 'success');
        } catch (error) {
            console.error('[聊天工具箱] 词句修改失败', error);
            notify(`AI 后修改失败：${error.message}`, 'error');
        } finally {
            postEditLoading = false;
            renderPanel();
        }
    }

    async function applyPostEdit() {
        if (!postEditDraft?.revisedContent || !postEditReview.length) return notify('请先调用 API 并审核至少一段修改', 'warning');
        const message = getChat()[postEditDraft.rawIndex];
        if (!message) return notify('原消息已经不存在', 'warning');
        const before = messageText(message);
        if (before !== postEditDraft.originalFull) return notify('原回复在读取后已经变化，请重新读取最新正文', 'warning');
        try {
            const match = postEditTagMatch(before, postEditDraft.tag);
            if (!match) throw new Error(`原回复中已经找不到 <${postEditDraft.tag}> 标签`);
            const accepted = postEditReview.filter((item) => item.decision === 'accept');
            if (!accepted.length) return notify('请先点击“采用这段”或“全部采用”', 'warning');
            const split = postEditParagraphRanges(match.content);
            const originalParagraphs = split.ranges.map((item) => item.text);
            const acceptedByParagraph = new Map(accepted.map((review) => [Number(review.paragraph), review]));
            const patches = [...acceptedByParagraph.values()].map((review) => {
                const range = split.ranges[Number(review.paragraph) - 1];
                if (!range) throw new Error(`P${review.paragraph} 已无法对应原正文，请重新读取该楼层`);
                return {
                    ...range,
                    replacement: postEditReplacementForRange(review, originalParagraphs),
                };
            }).sort((a, b) => b.start - a.start);
            let revisedContent = split.source;
            patches.forEach((patch) => {
                revisedContent = revisedContent.slice(0, patch.start) + patch.replacement + revisedContent.slice(patch.end);
            });
            // Only replace the exact inner range of the requested tag.  Do not
            // normalize or rebuild the rest of the message: unrelated text,
            // tags and whitespace must remain byte-for-byte unchanged.
            const after = before.slice(0, match.innerStart) + revisedContent + before.slice(match.innerEnd);
            if (after === before) return notify('采用后内容没有变化', 'info');
            setMessageText(message, after);
            const saved = await saveChat();
            if (!saved) {
                setMessageText(message, before);
                throw new Error('酒馆没有返回可用的保存结果');
            }
            const verified = await verifySavedEntries([{ rawIndex: postEditDraft.rawIndex, field: 'mes', after, normalize: false }]);
            if (verified === false) {
                setMessageText(message, before);
                throw new Error('聊天文件回读结果与修改内容不一致');
            }
            rememberUndo([{ rawIndex: postEditDraft.rawIndex, field: 'mes', before }], `AI 后修改 #${postEditDraft.floor}`, true);
            refreshVisibleMessage(postEditDraft.rawIndex);
            emitMessageEdited(postEditDraft.rawIndex);
            emitMessageUpdated(postEditDraft.rawIndex);
            postEditDraft.originalFull = after;
            postEditDraft.originalContent = revisedContent;
            postEditDraft.revisedContent = '';
            postEditReview = [];
            postEditPromptPreview = null;
            postEditEditing = false;
            renderPanel();
            notify(`已采用并保存楼层 #${postEditDraft.floor}`, 'success');
        } catch (error) {
            setMessageText(message, before);
            refreshVisibleMessage(postEditDraft.rawIndex);
            notify(error.message, 'error');
        }
    }

    function splitRewriteParagraphs(content) {
        const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
        const paragraphs = [];
        let startLine = -1;
        const flush = (endLine) => {
            if (startLine < 0) return;
            paragraphs.push({
                number: paragraphs.length + 1,
                startLine,
                endLine,
                text: lines.slice(startLine, endLine).join('\n'),
                selected: true,
                instruction: '',
            });
            startLine = -1;
        };
        lines.forEach((line, lineIndex) => {
            if (line.trim()) {
                if (startLine < 0) startLine = lineIndex;
            } else {
                flush(lineIndex);
            }
        });
        flush(lines.length);
        return { lines, paragraphs };
    }

    function prepareRewriteFloor({ silent = false } = {}) {
        const selected = assistantAtFloor(settings.rewrite.floor);
        if (!selected) {
            if (!silent) notify('没有找到该楼层的 AI 回复', 'warning');
            return false;
        }
        try {
            const match = postEditTagMatch(selected.text, settings.rewrite.tag);
            if (!match) {
                if (!silent) notify(`楼层 #${selected.id} 中没有找到 <${settings.rewrite.tag || 'content'}>…</${settings.rewrite.tag || 'content'}>`, 'warning');
                return false;
            }
            const split = splitRewriteParagraphs(match.content);
            if (!split.paragraphs.length) throw new Error('标签正文中没有可改写的段落');
            rewriteDraft = {
                rawIndex: selected.rawIndex,
                floor: selected.id,
                tag: match.tag,
                originalFull: selected.text,
                originalContent: match.content,
                lines: split.lines,
                paragraphs: split.paragraphs,
            };
            rewriteReview = [];
            rewritePromptPreview = null;
            settings.rewrite.floor = String(selected.id);
            if (!silent) {
                renderPanel();
                notify(`已读取楼层 #${selected.id}，共 ${split.paragraphs.length} 段`, 'success');
            }
            return true;
        } catch (error) {
            if (!silent) notify(error.message, 'error');
            return false;
        }
    }

    function worldEntrySelectionKey(world, uid) {
        return `${String(world)}\u0000${String(uid)}`;
    }

    function selectedWorldEntryKeys() {
        return new Set((settings.rewrite.worldEntries || []).map((item) => worldEntrySelectionKey(item.world, item.uid)));
    }

    function normalizeWorldBookEntries(world, data) {
        // 与世界书管理共用完整记录标准化，避免异常 UID 造成顺序分叉。
        return sortWorldbookRecords(worldbookRecords(data)).map((record) => {
            const value = record.raw;
            const uid = String(record.uid);
            const keys = Array.isArray(value.key) ? value.key.map(String).filter(Boolean) : [];
            return {
                world: String(world),
                uid,
                comment: String(value.comment || value.name || keys.join('、') || `条目 ${uid}`),
                content: String(value.content ?? ''),
                disabled: value.disable === true || value.enabled === false,
                raw: value,
            };
        });
    }

    async function fetchRewriteWorldEntries(world, { force = false } = {}) {
        const name = String(world || '').trim();
        if (!name) return [];
        if (!force && rewriteWorldEntryCache.has(name)) return rewriteWorldEntryCache.get(name);
        const data = await stProxyJson('/api/worldinfo/get', { name });
        const entries = normalizeWorldBookEntries(name, data);
        rewriteWorldEntryCache.set(name, entries);
        return entries;
    }

    async function loadRewriteWorldBooks({ force = false } = {}) {
        if (rewriteWorldLoading) return;
        rewriteWorldLoading = true;
        rewriteWorldError = '';
        renderPanel();
        try {
            if (force || !rewriteWorldBooks.length) {
                rewriteWorldBooks = await getWorldBookNames(force);
            }
            const preferred = rewriteWorldBook
                || settings.rewrite.worldEntries?.find((item) => rewriteWorldBooks.includes(item.world))?.world
                || rewriteWorldBooks[0]
                || '';
            rewriteWorldBook = preferred;
            if (preferred) await fetchRewriteWorldEntries(preferred, { force });
        } catch (error) {
            rewriteWorldError = error.message || String(error);
        } finally {
            rewriteWorldLoading = false;
            renderPanel();
        }
    }

    async function chooseRewriteWorldBook(name) {
        rewriteWorldBook = String(name || '');
        rewriteWorldError = '';
        if (!rewriteWorldBook) return renderPanel();
        rewriteWorldLoading = true;
        renderPanel();
        try {
            await fetchRewriteWorldEntries(rewriteWorldBook);
        } catch (error) {
            rewriteWorldError = error.message || String(error);
        } finally {
            rewriteWorldLoading = false;
            renderPanel();
        }
    }

    function setRewriteWorldEntrySelected(world, uid, selected) {
        const key = worldEntrySelectionKey(world, uid);
        const existing = settings.rewrite.worldEntries || [];
        settings.rewrite.worldEntries = selected
            ? (existing.some((item) => worldEntrySelectionKey(item.world, item.uid) === key)
                ? existing
                : [...existing, { world: String(world), uid: String(uid) }])
            : existing.filter((item) => worldEntrySelectionKey(item.world, item.uid) !== key);
        syncRewriteSelectionUi();
    }

    function setCurrentWorldBookSelection(selected) {
        if (!rewriteWorldBook) return;
        const entries = rewriteWorldEntryCache.get(rewriteWorldBook) || [];
        const currentWorld = String(rewriteWorldBook);
        const otherWorlds = (settings.rewrite.worldEntries || []).filter((item) => item.world !== currentWorld);
        settings.rewrite.worldEntries = selected
            ? [...otherWorlds, ...entries.map((entry) => ({ world: entry.world, uid: entry.uid }))]
            : otherWorlds;
        syncRewriteSelectionUi();
    }

    function syncRewriteSelectionUi() {
        if (!root) return;
        const selected = selectedWorldEntryKeys();
        root.querySelectorAll('[data-world-entry-uid]').forEach((input) => {
            input.checked = selected.has(worldEntrySelectionKey(input.dataset.worldName, input.dataset.worldEntryUid));
            input.closest('.ctb-world-entry')?.classList.toggle('is-selected', input.checked);
        });
        const count = root.querySelector('[data-rewrite-world-selected-count]');
        if (count) count.textContent = selected.size ? `已选 ${selected.size} 条` : '未选择';
        const button = root.querySelector('[data-rewrite-world-picker-button]');
        button?.classList.toggle('ctb-primary-soft', selected.size > 0);
        const clear = root.querySelector('[data-rewrite-world-clear]');
        if (clear) clear.hidden = selected.size === 0;
        const summary = root.querySelector('[data-rewrite-world-selection-summary]');
        if (summary) {
            summary.hidden = selected.size === 0;
            summary.innerHTML = (settings.rewrite.worldEntries || [])
                .map((item) => `<span title="${escapeHTML(worldEntryDisplayLabel(item))}">${escapeHTML(worldEntryDisplayLabel(item))}</span>`)
                .join('');
        }
    }

    function worldEntryDisplayLabel(selection) {
        const cached = rewriteWorldEntryCache.get(selection.world) || [];
        const entry = cached.find((item) => item.uid === String(selection.uid));
        return `${selection.world} · ${entry?.comment || `条目 ${selection.uid}`}`;
    }

    async function collectSelectedWorldEntries() {
        const selections = settings.rewrite.worldEntries || [];
        if (!selections.length) return '';
        const books = [...new Set(selections.map((item) => item.world))];
        const loaded = new Map();
        for (const world of books) {
            try {
                loaded.set(world, await fetchRewriteWorldEntries(world));
            } catch (error) {
                console.warn(`[聊天工具箱] 读取世界书“${world}”失败`, error);
            }
        }
        return selections.map((selection) => {
            const entry = (loaded.get(selection.world) || []).find((item) => item.uid === String(selection.uid));
            if (!entry?.content.trim()) return '';
            return `【${entry.world} · ${entry.comment} · UID ${entry.uid}】\n${entry.content.trim()}`;
        }).filter(Boolean).join('\n\n');
    }

    async function collectRewriteContext(draft) {
        const config = settings.rewrite;
        const context = getContext();
        const historyLimit = Math.max(0, Math.min(50, Number(config.contextFloors) || 0));
        const contextTags = parseTags(config.contextTags);
        const history = getRows()
            .slice(0, draft.rawIndex)
            .slice(-historyLimit)
            .map((row) => {
                const text = extractTags(row.text, contextTags).trim();
                return text ? `${row.isUser ? '用户' : row.name}（#${row.id}）：${text}` : '';
            })
            .filter(Boolean)
            .join('\n\n');
        let character = '';
        let persona = '';
        let worldEntries = '';
        if (config.includeCharacter) {
            const characterId = context.characterId ?? context.this_chid ?? host.this_chid;
            const card = context.characters?.[characterId] || host.characters?.[characterId];
            if (card) {
                character = [
                    card.name ? `角色名：${card.name}` : '',
                    card.description ? `角色描述：${card.description}` : '',
                    card.personality ? `性格：${card.personality}` : '',
                    card.scenario ? `场景：${card.scenario}` : '',
                ].filter(Boolean).join('\n');
            }
        }
        if (config.includePersona) {
            try { persona = String(context.substituteParams?.('{{persona}}') || ''); } catch (_) {}
        }
        worldEntries = await collectSelectedWorldEntries();
        return { history, character, persona, worldEntries };
    }

    function rewriteSystemPrompt() {
        return String(typeof settings.rewrite?.systemPrompt === 'string' ? settings.rewrite.systemPrompt : defaultRewriteSystemPrompt()).trim();
    }

    async function buildRewriteRequest(draft) {
        const globalInstruction = String(settings.rewrite.globalInstruction || '').trim();
        const selected = draft.paragraphs
            .filter((paragraph) => paragraph.selected)
            .map((paragraph) => ({
                paragraph,
                instruction: String(paragraph.instruction || '').trim() || globalInstruction,
            }))
            .filter((item) => item.instruction);
        if (!selected.length) throw new Error('没有填写改写要求；留空的段落不会修改');
        const story = await collectRewriteContext(draft);
        const requested = selected.map(({ paragraph, instruction }) => ({
            paragraph: paragraph.number,
            text: paragraph.text,
            instruction,
        }));
        const contextParts = [
            story.character ? `【角色卡】\n${story.character}` : '',
            story.persona ? `【用户设定】\n${story.persona}` : '',
            story.worldEntries ? `【用户选择的世界书条目】\n${story.worldEntries}` : '',
            story.history ? `【最近上下文】\n${story.history}` : '',
            `【待改写段落】\n${JSON.stringify(requested, null, 2)}`,
        ].filter(Boolean);
        return [
            { role: 'system', content: rewriteSystemPrompt() },
            { role: 'user', content: contextParts.join('\n\n') },
        ];
    }

    async function previewRewritePrompt() {
        if (rewritePreviewLoading) return;
        if (!rewriteDraft && !prepareRewriteFloor({ silent: true })) return notify('请先读取要改写的 AI 楼层', 'warning');
        rewritePreviewLoading = true;
        renderPanel();
        try {
            const messages = await buildRewriteRequest(rewriteDraft);
            rewritePromptPreview = buildPromptPreview(messages);
        } catch (error) {
            rewritePromptPreview = null;
            notify(`无法生成发送预览：${error.message}`, 'error');
        } finally {
            rewritePreviewLoading = false;
            renderPanel();
        }
    }

    function parseRewritePatch(value) {
        let text = String(value ?? '').trim();
        const answer = text.match(/<answer\b[^>]*>([\s\S]*?)<\/answer>/i);
        if (answer) text = answer[1].trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) text = text.slice(start, end + 1);
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (error) { throw new Error(`模型没有返回有效的 JSON 段落补丁：${error.message}`); }
        if (!Array.isArray(parsed?.changes)) throw new Error('模型返回中缺少 changes 数组');
        return parsed.changes;
    }

    async function runRewrite() {
        if (rewriteLoading) return;
        if (!rewriteDraft && !prepareRewriteFloor({ silent: true })) return notify('请先读取要改写的 AI 楼层', 'warning');
        const globalInstruction = String(settings.rewrite.globalInstruction || '').trim();
        const selected = rewriteDraft.paragraphs.filter((paragraph) => (
            paragraph.selected && (String(paragraph.instruction || '').trim() || globalInstruction)
        ));
        if (!selected.length) return notify('没有填写改写要求；留空的段落不会修改', 'warning');
        rewriteLoading = true;
        rewriteReview = [];
        renderPanel();
        try {
            const messages = await buildRewriteRequest(rewriteDraft);
            rewritePromptPreview = buildPromptPreview(messages);
            const output = await callAiText('rewrite', messages);
            const changes = parseRewritePatch(output);
            const byNumber = new Map(selected.map((paragraph) => [paragraph.number, paragraph]));
            const reviewByParagraph = new Map();
            changes.forEach((change) => {
                const number = Number(change?.paragraph);
                const paragraph = byNumber.get(number);
                if (!paragraph || typeof change?.replacement !== 'string') return;
                const replacement = change.replacement.trim();
                if (replacement === paragraph.text) return;
                reviewByParagraph.set(number, {
                    paragraph: number,
                    original: paragraph.text,
                    replacement,
                    decision: 'pending',
                });
            });
            rewriteReview = Array.from(reviewByParagraph.values());
            if (!rewriteReview.length) throw new Error('没有得到可审核的段落补丁（返回段落可能包含换行或编号无效）');
            notify(`已生成 ${rewriteReview.length} 段改写，请逐段采用或忽略`, 'success');
        } catch (error) {
            rewriteReview = [];
            notify(`逐段改写失败：${error.message}`, 'error');
        } finally {
            rewriteLoading = false;
            renderPanel();
        }
    }

    async function applyRewrite() {
        if (rewriteApplyLoading || !rewriteDraft) return;
        const accepted = rewriteReview.filter((item) => item.decision === 'accept');
        if (!accepted.length) return notify('还没有选择要采用的段落', 'warning');
        const message = getChat()[rewriteDraft.rawIndex];
        if (!message) return notify('原楼层已经不存在', 'error');
        const before = messageText(message);
        if (before !== rewriteDraft.originalFull) return notify('原楼层在读取后发生了变化，请重新读取', 'error');
        rewriteApplyLoading = true;
        renderPanel();
        try {
            const lines = [...rewriteDraft.lines];
            [...accepted].sort((a, b) => {
                const pa = rewriteDraft.paragraphs.find((item) => item.number === a.paragraph);
                const pb = rewriteDraft.paragraphs.find((item) => item.number === b.paragraph);
                return (pb?.startLine ?? 0) - (pa?.startLine ?? 0);
            }).forEach((review) => {
                const paragraph = rewriteDraft.paragraphs.find((item) => item.number === review.paragraph);
                if (paragraph) lines.splice(paragraph.startLine, paragraph.endLine - paragraph.startLine, review.replacement);
            });
            const revisedContent = normalizeBlankLines(lines.join('\n'));
            const match = postEditTagMatch(before, rewriteDraft.tag);
            if (!match) throw new Error(`原楼层中已经找不到 <${rewriteDraft.tag}> 标签`);
            const after = before.slice(0, match.innerStart) + revisedContent + before.slice(match.innerEnd);
            if (after === before) throw new Error('采用后的内容没有变化');
            setMessageText(message, after);
            const saved = await saveChat();
            if (!saved) {
                setMessageText(message, before);
                throw new Error('酒馆没有返回可用的保存结果');
            }
            const verified = await verifySavedEntries([{ rawIndex: rewriteDraft.rawIndex, field: 'mes', after, normalize: false }]);
            if (verified === false) {
                setMessageText(message, before);
                throw new Error('聊天文件回读结果与改写内容不一致');
            }
            rememberUndo([{ rawIndex: rewriteDraft.rawIndex, field: 'mes', before }], `逐段改写 #${rewriteDraft.floor}`, true);
            refreshVisibleMessage(rewriteDraft.rawIndex);
            emitMessageEdited(rewriteDraft.rawIndex);
            emitMessageUpdated(rewriteDraft.rawIndex);
            rewriteDraft.originalFull = after;
            rewriteDraft.originalContent = revisedContent;
            const split = splitRewriteParagraphs(revisedContent);
            rewriteDraft.lines = split.lines;
            rewriteDraft.paragraphs = split.paragraphs;
            rewriteReview = [];
            notify(`已采用 ${accepted.length} 段并保存楼层 #${rewriteDraft.floor}`, 'success');
        } catch (error) {
            setMessageText(message, before);
            refreshVisibleMessage(rewriteDraft.rawIndex);
            notify(`采用改写失败：${error.message}`, 'error');
        } finally {
            rewriteApplyLoading = false;
            renderPanel();
        }
    }

    function showPanel(tab = activeTab) {
        if (!root) return;
        activeTab = tab;
        ensureActiveTab();
        root.hidden = false;
        renderPanel();
    }

    function discardWorldbookChangesV2() {
        // All worldbook writes are staged until this close/save checkpoint.
        // Discarding therefore only resets local memory; the server document
        // remains untouched, including pending documents from other books.
        worldbookPendingDocuments.clear();
        worldbookDirty = false;
        worldbookDraftDirty = false;
        worldbookDraft = null;
        worldbookEditingUid = '';
        worldbookDocument = null;
        worldbookEntries = [];
        worldbookSelected = new Set();
    }

    async function closePanel({ confirmed = false, discarded = false } = {}) {
        // Editing is intentionally staged in memory.  There is one save point:
        // closing the toolbox.  Switching rows/tabs never asks the user to
        // discard work and never writes a half-edited entry to the server.
        if (worldbookDraftDirty && !discarded) applyWorldbookDraft({ quiet: true });
        if ((worldbookDirty || worldbookPendingDocuments.size) && !confirmed && !discarded) {
            pendingConfirm = {
                title: '保存世界书并关闭',
                message: '世界书有未保存修改。你可以保存后关闭、直接放弃修改退出，或返回继续编辑。',
                action: 'close-worldbook',
            };
            renderPanel();
            return;
        }
        if (!discarded && (worldbookDirty || worldbookPendingDocuments.size)) {
            if (worldbookDirty) {
                const saved = await saveCurrentWorldbook();
                if (!saved) return;
            }
            if (!(await savePendingWorldbooksV2())) return;
        }
        if (discarded) discardWorldbookChangesV2();
        infoMessage = null;
        transientNotice = null;
        pendingConfirm = null;
        if (root) root.hidden = true;
    }

    function searchScopeLabel() {
        return ({ mes: '正文 mes', name: '发言者 name', json: '完整消息 JSON（只搜索）' }[ui.scope]);
    }

    function renderSearchTab() {
        const bookmarkRows = currentBookmarks();
        const list = results.length ? `
            <div class="ctb-results" id="ctb-results">
                <div class="ctb-results-title">找到 ${results.length}${results.length >= MAX_RESULTS ? '+' : ''} 条结果（点击跳转）</div>
                ${results.map((result, index) => `<button type="button" class="ctb-result-row${index === currentResultIndex ? ' is-active' : ''}" data-action="jump-result" data-result-index="${index}">
                    <span class="ctb-result-meta"><span>${escapeHTML(result.name)}</span><span>#${escapeHTML(result.id)}${result.occurrence > 1 ? ` · 第 ${result.occurrence} 处` : ''}</span></span>
                    <span class="ctb-result-text"><span class="ctb-result-before">${escapeHTML(result.preview.before)}</span><mark>${escapeHTML(result.preview.match || '∅')}</mark><span class="ctb-result-after">${escapeHTML(result.preview.after)}</span></span>
                </button>`).join('')}
            </div>` : `<div class="ctb-results ctb-results-empty">${ui.query.trim() ? '没有找到匹配内容。' : '输入内容后点击“查找”，结果会显示在这里。'}</div>`;
        const canReplace = ui.scope !== 'json';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">楼层跳转 & 书签 <span>当前最高 #${maxFloor()}</span></div>
                <div class="ctb-inline">
                    <input class="ctb-input" id="ctb-floor" type="number" min="0" placeholder="楼层号" value="${escapeHTML(ui.floor)}">
                    <button type="button" class="ctb-icon-button ctb-primary" data-action="jump-floor" title="跳转"><i class="fa-solid fa-paper-plane"></i></button>
                    <button type="button" class="ctb-icon-button" data-action="open-bookmark" title="添加书签"><i class="fa-solid fa-bookmark"></i></button>
                </div>
                ${ui.bookmarkEditing ? `<div class="ctb-inline ctb-bookmark-editor"><input class="ctb-input" id="ctb-bookmark-name" placeholder="书签名称" value="${escapeHTML(ui.bookmarkName)}"><button type="button" class="ctb-button ctb-primary" data-action="save-bookmark">保存</button><button type="button" class="ctb-button" data-action="cancel-bookmark">取消</button></div>` : ''}
                ${bookmarkRows.length ? `<div class="ctb-bookmarks">${bookmarkRows.map((bookmark, index) => `<span class="ctb-bookmark"><button type="button" data-action="jump-bookmark" data-floor="${escapeHTML(bookmark.id)}">${escapeHTML(bookmark.label)} <small>#${escapeHTML(bookmark.id)}</small></button><button type="button" data-action="remove-bookmark" data-bookmark-index="${index}" title="删除书签">×</button></span>`).join('')}</div>` : ''}
            </section>
            <div class="ctb-divider"></div>
            <section class="ctb-section">
                <div class="ctb-section-title">查找与替换 <span>${searchScopeLabel()}</span></div>
                <div class="ctb-scope-row">
                    <button type="button" class="ctb-scope${ui.scope === 'mes' ? ' is-active' : ''}" data-action="set-scope" data-scope="mes">正文 mes</button>
                    <button type="button" class="ctb-scope ctb-clean-blanks" data-action="remove-extra-blank-lines" title="把正文中的三个及以上连续换行压缩成两个换行；修改只暂存，需另行保存">去除多余空行</button>
                    <button type="button" class="ctb-scope${ui.scope === 'name' ? ' is-active' : ''}" data-action="set-scope" data-scope="name">发言者 name</button>
                    <button type="button" class="ctb-scope${ui.scope === 'json' ? ' is-active' : ''}" data-action="set-scope" data-scope="json">完整消息 JSON</button>
                </div>
                <div class="ctb-inline ctb-search-row">
                    <input class="ctb-input" id="ctb-query" placeholder="输入要查找的内容…" value="${escapeHTML(ui.query)}">
                    <label class="ctb-check"><input id="ctb-regex" type="checkbox"${ui.regex ? ' checked' : ''}> 正则</label>
                    <button type="button" class="ctb-button ctb-primary" data-action="find"><i class="fa-solid fa-magnifying-glass"></i> 查找</button>
                </div>
                <div class="ctb-inline ctb-nav-row">
                    <button type="button" class="ctb-icon-button" data-action="previous-result" ${results.length ? '' : 'disabled'} title="上一条"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="ctb-icon-button" data-action="next-result" ${results.length ? '' : 'disabled'} title="下一条"><i class="fa-solid fa-arrow-down"></i></button>
                    <span class="ctb-result-counter">${results.length ? `${currentResultIndex + 1} / ${results.length}` : '0 / 0'}</span>
                    ${infoButton('search-results')}
                </div>
                ${canReplace ? `<div class="ctb-inline ctb-replace-row"><input class="ctb-input" id="ctb-replacement" placeholder="替换为（可以留空）" value="${escapeHTML(ui.replacement)}"${searchSaveState.saving ? ' disabled' : ''}><button type="button" class="ctb-button" data-action="replace-current"${searchSaveState.saving ? ' disabled' : ''}>替换当前</button><button type="button" class="ctb-button ctb-danger" data-action="replace-all"${searchSaveState.saving ? ' disabled' : ''}>整体替换</button><button type="button" class="ctb-button ctb-save" data-action="save-search-changes"${dirtyChanges.size && !searchSaveState.saving ? '' : ' disabled'}>${searchSaveState.saving ? '正在保存…' : `保存修改${dirtyChanges.size ? ` (${dirtyChanges.size})` : ''}`}</button></div>${searchSaveState.saving ? '<div class="ctb-save-progress"><span class="ctb-save-spinner"></span><span id="ctb-save-status">正在保存，请勿刷新页面。</span></div>' : dirtyChanges.size ? `<div class="ctb-staged-note">已暂存 ${dirtyChanges.size} 条消息；保存前聊天界面和聊天文件都不会变化。</div>` : ''}` : `<div class="ctb-info-line">${infoButton('json-readonly')}</div>`}
                ${lastUndo ? `<div class="ctb-undo-row"><span>可撤销：${escapeHTML(lastUndo.label)}</span>${infoButton('undo')}<button type="button" class="ctb-button" data-action="undo">撤销上次</button></div>` : ''}
            </section>
            ${list}`;
    }

    function renderExportTab() {
        const selectedTags = new Set(parseTags(ui.exportTags).map((tag) => tag.toLocaleLowerCase()));
        const tagPicker = ui.exportTagPickerOpen ? `<div class="ctb-export-tag-picker">
            <div class="ctb-export-tag-picker-head"><span>当前聊天中的成对标签</span><button type="button" class="ctb-button" data-action="close-export-tags">完成</button></div>
            <div class="ctb-export-tag-options">${ui.exportTagOptions.length ? ui.exportTagOptions.map((item) => `<label class="ctb-export-tag-option"><input type="checkbox" data-export-tag="${escapeHTML(item.name)}"${selectedTags.has(item.name.toLocaleLowerCase()) ? ' checked' : ''}><span>${escapeHTML(item.name)}</span><small>${item.count} 处</small></label>`).join('') : '<div class="ctb-hint">当前聊天没有扫描到可提取的成对标签；仍可在上方手动填写。</div>'}</div>
        </div>` : '';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">导出文件名</div>
                <input class="ctb-input" id="ctb-export-filename" placeholder="留空使用当前聊天名" value="${escapeHTML(ui.exportFilename)}">
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">导出范围 ${infoButton('export-range')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-export-start" type="number" min="0" placeholder="起始楼层" value="${escapeHTML(ui.exportStart)}"><span>—</span><input class="ctb-input" id="ctb-export-end" type="number" min="0" placeholder="结束楼层" value="${escapeHTML(ui.exportEnd)}"></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">正文标签提取 ${infoButton('export-tags')}</div>
                <div class="ctb-export-tag-input"><input class="ctb-input" id="ctb-export-tags" placeholder="例如 content, small_theater" value="${escapeHTML(ui.exportTags)}"><button type="button" class="ctb-icon-button" data-action="scan-export-tags" title="扫描当前聊天中的标签" aria-label="扫描当前聊天中的标签"><i class="fa-solid fa-wand-magic-sparkles"></i></button></div>
                ${tagPicker}
                <div class="ctb-option-grid">
                    <label class="ctb-check"><input id="ctb-export-clean" type="checkbox"${ui.exportClean ? ' checked' : ''}> 阅读模式（去标签）</label>
                    <label class="ctb-check"><input id="ctb-export-user" type="checkbox"${ui.exportIncludeUser ? ' checked' : ''}> 包含用户发言</label>
                    <label class="ctb-check"><input id="ctb-export-name" type="checkbox"${ui.exportShowName ? ' checked' : ''}> 显示发送者</label>
                    <label class="ctb-check"><input id="ctb-export-floor" type="checkbox"${ui.exportShowFloor ? ' checked' : ''}> 显示楼层号</label>
                </div>
            </section>
            <div class="ctb-export-actions"><button type="button" class="ctb-button ctb-export-txt" data-action="export-txt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button><span class="ctb-export-epub-combo"><button type="button" class="ctb-button ctb-export-epub" data-action="export-epub"><i class="fa-solid fa-book-open"></i> 导出 EPUB</button>${infoButton('export-epub', 'ctb-export-info ctb-info-on-button', true)}</span></div>`;
    }

    function renderChannelSettings(feature) {
        const featureSettings = settings[feature];
        const currentId = featureSettings.channelId || 'main';
        const current = channelById(currentId);
        const options = [`<option value="main"${currentId === 'main' || !current ? ' selected' : ''}>跟随酒馆主接口</option>`]
            .concat((settings.ai.channels || []).map((channel) => `<option value="${escapeHTML(channel.id)}"${currentId === channel.id ? ' selected' : ''}>${escapeHTML(channel.name || '未命名渠道')}</option>`))
            .join('');
        const editor = channelEditor?.feature === feature ? channelEditor : null;
        const editing = editor?.draft;
        const editorForm = editing ? `
            <div class="ctb-channel-grid">
                <input class="ctb-input" id="ctb-${feature}-channel-name" data-channel-id="${escapeHTML(editing.id)}" placeholder="渠道名称" value="${escapeHTML(editing.name || '')}">
                <input class="ctb-input" id="ctb-${feature}-channel-url" data-channel-id="${escapeHTML(editing.id)}" placeholder="OpenAI 兼容 API 地址" value="${escapeHTML(editing.url || '')}">
                <input class="ctb-input" id="ctb-${feature}-channel-key" data-channel-id="${escapeHTML(editing.id)}" type="password" autocomplete="off" placeholder="API Key" value="${escapeHTML(editing.key || '')}">
                <div class="ctb-inline ctb-model-row">
                    <select class="ctb-input" id="ctb-${feature}-channel-model" data-channel-id="${escapeHTML(editing.id)}">
                        ${editing.model && !(editing.models || []).includes(editing.model) ? `<option value="${escapeHTML(editing.model)}" selected>${escapeHTML(editing.model)}</option>` : ''}
                        ${(editing.models || []).map((model) => `<option value="${escapeHTML(model)}"${editing.model === model ? ' selected' : ''}>${escapeHTML(model)}</option>`).join('')}
                        ${!editing.model && !(editing.models || []).length ? '<option value="">先拉取模型</option>' : ''}
                    </select>
                    <button type="button" class="ctb-button" data-action="fetch-models" data-channel-id="${escapeHTML(editing.id)}"${channelLoadingId ? ' disabled' : ''}>${channelLoadingId === editing.id ? '拉取中…' : '拉取模型'}</button>
                </div>
                <div class="ctb-inline">
                    <label class="ctb-mini-field">温度 <input class="ctb-input" id="ctb-${feature}-channel-temperature" data-channel-id="${escapeHTML(editing.id)}" type="number" min="0" max="2" step="0.1" value="${escapeHTML(editing.temperature ?? 0.2)}"></label>
                    <label class="ctb-mini-field">最大输出 <input class="ctb-input" id="ctb-${feature}-channel-tokens" data-channel-id="${escapeHTML(editing.id)}" type="number" min="256" step="256" value="${escapeHTML(editing.maxTokens || 4096)}"></label>
                </div>
                <div class="ctb-channel-editor-actions"><button type="button" class="ctb-button ctb-primary" data-action="save-channel">保存渠道</button><button type="button" class="ctb-button" data-action="cancel-channel">取消</button>${editor.isNew ? '' : `<button type="button" class="ctb-button ctb-danger" data-action="delete-channel" data-channel-id="${escapeHTML(editing.id)}">删除渠道</button>`}</div>
            </div>` : '';
        const summary = current ? `<div class="ctb-channel-summary"><div><strong>${escapeHTML(current.name || '未命名渠道')}</strong><small>${escapeHTML([current.model || '未选择模型', (() => { try { return new URL(normalizeProxyUrl(current.url)).host; } catch (_) { return current.url || '未填写地址'; } })()].join(' · '))}</small></div><button type="button" class="ctb-button" data-action="edit-channel" data-feature="${feature}" data-channel-id="${escapeHTML(current.id)}"><i class="fa-solid fa-pen"></i> 编辑</button></div>` : '';
        return `
            <div class="ctb-inline ctb-channel-picker">
                <select class="ctb-input" id="ctb-${feature}-channel">${options}</select>
                <button type="button" class="ctb-button" data-action="add-channel" data-feature="${feature}"><i class="fa-solid fa-plus"></i> 新渠道</button>
            </div>
            ${editorForm || summary}`;
    }

    function renderPostEditParagraphPreview(value, changedParagraphs) {
        const paragraphs = postEditParagraphs(value);
        if (!paragraphs.length) return '<em>（空）</em>';
        return paragraphs.map((paragraph, index) => {
            const changed = changedParagraphs.has(index + 1) ? ' class="ctb-post-changed"' : '';
            return `<span${changed}>${escapeHTML(paragraph)}</span>`;
        }).join('\n\n');
    }

    function renderPostEditTab() {
        const config = settings.postEdit || defaults().postEdit;
        const draft = postEditDraft;
        const revised = draft?.revisedContent || '';
        const acceptedCount = postEditReview.filter((item) => item.decision === 'accept').length;
        const changedParagraphs = new Set(postEditReview.map((item) => Number(item.paragraph)).filter(Number.isInteger));
        if (draft && revised) {
            const originalParagraphs = postEditParagraphs(draft.originalContent);
            const revisedParagraphs = postEditParagraphs(revised);
            if (originalParagraphs.length === revisedParagraphs.length) {
                revisedParagraphs.forEach((paragraph, index) => {
                    if (paragraph !== originalParagraphs[index]) changedParagraphs.add(index + 1);
                });
            }
        }
        const presetOptions = [`<option value="">选择规则预设…</option>`].concat((config.presets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${config.selectedPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`)).join('');
        const reviewList = postEditReview.length ? `<section class="ctb-section">
            <div class="ctb-section-title">逐段审核 <span>${acceptedCount} / ${postEditReview.length} 段将采用</span></div>
            <div class="ctb-rewrite-reviews">
                ${postEditReview.map((review, index) => `<div class="ctb-rewrite-review${review.decision === 'accept' ? ' is-accepted' : review.decision === 'reject' ? ' is-rejected' : ''}">
                    <div class="ctb-rewrite-review-title"><span>P${review.paragraph}</span><span>${review.decision === 'accept' ? '将采用' : review.decision === 'reject' ? '不采用' : '等待决定'}</span></div>
                    <div class="ctb-rewrite-compare ctb-post-review-grid">
                        <div><small>原文</small><p>${escapeHTML(review.original)}</p></div>
                        <div><small>修改原因</small><p>${escapeHTML(review.reason || '未提供修改原因')}</p></div>
                        <div><small>修改后</small>${postEditReviewEditingIndex === index ? `<textarea class="ctb-input ctb-review-edit" id="ctb-post-edit-review-revised-${index}">${escapeHTML(review.replacement)}</textarea>` : `<p class="ctb-review-plain">${escapeHTML(review.replacement)}</p>`}</div>
                    </div>
                    <div class="ctb-inline"><button type="button" class="ctb-button ctb-primary" data-action="post-edit-decision" data-review-index="${index}" data-decision="accept">采用这段</button><button type="button" class="ctb-button" data-action="post-edit-decision" data-review-index="${index}" data-decision="reject">不采用</button><button type="button" class="ctb-button" data-action="toggle-post-edit-review-editor" data-review-index="${index}">${postEditReviewEditingIndex === index ? '完成编辑' : '编辑'}</button></div>
                </div>`).join('')}
            </div>
            <div class="ctb-inline ctb-rewrite-final"><button type="button" class="ctb-button" data-action="post-edit-all" data-decision="accept">全部采用</button><button type="button" class="ctb-button" data-action="post-edit-all" data-decision="reject">全部不采用</button><button type="button" class="ctb-button ctb-primary" data-action="apply-post-edit"${acceptedCount && !postEditLoading ? '' : ' disabled'}>${postEditLoading ? '保存中…' : `采用 ${acceptedCount} 段并保存`}</button></div>
        </section>` : '';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">AI 词句修改 ${infoButton('post-edit-overview')}</div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">楼层与正文标签 ${infoButton('post-edit-scope')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-post-edit-floor" type="number" min="0" placeholder="楼层号（留空=最新 AI）" value="${escapeHTML(config.floor || '')}"><input class="ctb-input" id="ctb-post-edit-tag" placeholder="content" value="${escapeHTML(config.tag || 'content')}"><button type="button" class="ctb-button" data-action="prepare-post-edit">读取楼层</button></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">生成渠道 ${infoButton('channel-main')}</div>
                ${renderChannelSettings('postEdit')}
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">内置 system 提示词 ${infoButton('system-cache')}</div>
                <textarea class="ctb-input ctb-textarea ctb-system-prompt" id="ctb-post-edit-system" placeholder="控制模型输出格式和修改边界">${escapeHTML(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultPostEditSystemPrompt())}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">用户修改规则</div>
                <div class="ctb-inline ctb-preset-row"><select class="ctb-input" id="ctb-post-edit-preset">${presetOptions}</select><input class="ctb-input" id="ctb-post-edit-preset-name" placeholder="预设名称" value="${escapeHTML(config.presetName || '')}"><button type="button" class="ctb-button" data-action="save-post-preset">保存预设</button><button type="button" class="ctb-button ctb-danger" data-action="delete-post-preset"${config.selectedPresetId ? '' : ' disabled'}>删除</button></div>
                <textarea class="ctb-input ctb-textarea" id="ctb-post-edit-rules" placeholder="例如：减少套话和重复比喻，保持剧情、事实和段落顺序不变。">${escapeHTML(config.rules || '')}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-inline ctb-post-actions">
                    <button type="button" class="ctb-button" data-action="preview-post-edit-prompt"${postEditPreviewLoading ? ' disabled' : ''}><i class="fa-solid fa-eye"></i> ${postEditPreviewLoading ? '整理中…' : '预览发送内容'}</button>
                    <button type="button" class="ctb-button ctb-primary" data-action="run-post-edit" ${draft && !postEditLoading ? '' : 'disabled'}>${postEditLoading ? '修改中…' : '调用 API 修改'}</button>
                    <button type="button" class="ctb-button" data-action="clear-post-edit" ${draft ? '' : 'disabled'}>清空预览</button>
                </div>
            </section>
            ${postEditPromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览 · 总字数 ${postEditPromptPreview.characters}</span><button type="button" class="ctb-review-expand" data-action="close-post-edit-preview" title="关闭预览" aria-label="关闭预览">×</button></div><pre>${escapeHTML(postEditPromptPreview.text)}</pre></section>` : ''}
            ${draft ? `<section class="ctb-section ctb-post-preview">
                <div class="ctb-section-title">楼层 #${escapeHTML(draft.floor)} · 修改预览</div>
                <div class="ctb-post-column"><div class="ctb-post-label">原正文</div><pre class="ctb-post-text">${renderPostEditParagraphPreview(draft.originalContent, changedParagraphs)}</pre></div>
                <div class="ctb-post-column"><div class="ctb-post-label ctb-post-label-actions"><span>完整修改后（备用总稿）</span>${revised ? `<button type="button" class="ctb-review-expand" data-action="toggle-post-edit-editor" title="${postEditEditing ? '完成编辑' : '编辑修改后正文'}" aria-label="${postEditEditing ? '完成编辑' : '编辑修改后正文'}"><i class="fa-solid ${postEditEditing ? 'fa-check' : 'fa-pen'}"></i></button>` : ''}</div>${postEditEditing ? `<textarea class="ctb-input ctb-post-text ctb-post-edit-textarea" id="ctb-post-edit-revised">${escapeHTML(revised)}</textarea>` : `<pre class="ctb-post-text">${revised ? renderPostEditParagraphPreview(revised, changedParagraphs) : '点击“调用 API 修改”后显示结果。'}</pre>`}</div>
             </section>` : '<div class="ctb-results ctb-results-empty">先选择楼层并读取正文，再调用 API 生成修改预览。</div>'}
            ${reviewList}`;
    }

    function renderRewriteWorldPicker() {
        const selections = settings.rewrite.worldEntries || [];
        const selectedKeys = selectedWorldEntryKeys();
        const entries = rewriteWorldEntryCache.get(rewriteWorldBook) || [];
        const summary = `<div class="ctb-world-selected-summary" data-rewrite-world-selection-summary${selections.length ? '' : ' hidden'}>${selections.map((item) => `<span title="${escapeHTML(worldEntryDisplayLabel(item))}">${escapeHTML(worldEntryDisplayLabel(item))}</span>`).join('')}</div>`;
        const bookOptions = rewriteWorldBooks.map((name) => `<option value="${escapeHTML(name)}"${name === rewriteWorldBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const entryList = rewriteWorldLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : rewriteWorldError
                ? `<div class="ctb-world-empty ctb-world-error">${escapeHTML(rewriteWorldError)}</div>`
                : !rewriteWorldBooks.length
                    ? '<div class="ctb-world-empty">没有读取到世界书。</div>'
                    : entries.length
                        ? `<div class="ctb-world-entry-list" data-ctb-scroll-key="rewrite-world-entry-list">${entries.map((entry) => {
                            const checked = selectedKeys.has(worldEntrySelectionKey(entry.world, entry.uid));
                            const preview = entry.content.trim().replace(/\s+/g, ' ').slice(0, 110);
                            return `<label class="ctb-world-entry${checked ? ' is-selected' : ''}">
                                <input type="checkbox" data-world-entry-uid="${escapeHTML(entry.uid)}" data-world-name="${escapeHTML(entry.world)}"${checked ? ' checked' : ''}>
                                <span class="ctb-world-entry-main"><strong>${escapeHTML(entry.comment)}</strong><small>${escapeHTML(preview || '（空条目）')}</small></span>
                                <span class="ctb-world-entry-meta">UID ${escapeHTML(entry.uid)}${entry.disabled ? ' · 酒馆中已禁用' : ''}</span>
                            </label>`;
                        }).join('')}</div>`
                        : '<div class="ctb-world-empty">这本世界书没有条目。</div>';
        return `
            <div class="ctb-world-picker-summary">
                <button type="button" class="ctb-button${selections.length ? ' ctb-primary-soft' : ''}" data-action="toggle-rewrite-world-picker" data-rewrite-world-picker-button><i class="fa-solid fa-book-open"></i> 选择世界书具体条目 <span data-rewrite-world-selected-count>${selections.length ? `已选 ${selections.length} 条` : '未选择'}</span></button>
                <button type="button" class="ctb-button" data-action="clear-rewrite-world-selection" data-rewrite-world-clear${selections.length ? '' : ' hidden'}>清空全部</button>
            </div>
            ${summary}
            ${rewriteWorldPickerOpen ? `<div class="ctb-world-picker">
                <div class="ctb-inline ctb-world-book-row">
                    <select class="ctb-input" id="ctb-rewrite-world-book">${bookOptions || '<option value="">没有世界书</option>'}</select>
                    <button type="button" class="ctb-icon-button" data-action="refresh-rewrite-world-books" title="重新读取世界书"><i class="fa-solid fa-rotate"></i></button>
                    <button type="button" class="ctb-button" data-action="close-rewrite-world-picker">完成</button>
                </div>
                ${rewriteWorldBook && !rewriteWorldLoading ? `<div class="ctb-inline ctb-world-bulk"><span>${escapeHTML(rewriteWorldBook)} · ${entries.length} 条</span><button type="button" class="ctb-button" data-action="select-rewrite-world-book-all">全选本书</button><button type="button" class="ctb-button" data-action="clear-rewrite-world-book">清空本书</button></div>` : ''}
                ${entryList}
            </div>` : ''}`;
    }

    function renderRewriteTab() {
        const config = settings.rewrite || defaults().rewrite;
        const draft = rewriteDraft;
        const acceptedCount = rewriteReview.filter((item) => item.decision === 'accept').length;
        const paragraphList = draft ? `<div class="ctb-rewrite-list">
            ${draft.paragraphs.map((paragraph, index) => `<div class="ctb-rewrite-paragraph">
                <label class="ctb-rewrite-select"><input type="checkbox" data-action="rewrite-selected" data-paragraph-index="${index}"${paragraph.selected ? ' checked' : ''}><span>P${paragraph.number}</span></label>
                <div class="ctb-rewrite-source">${escapeHTML(paragraph.text)}</div>
                <input class="ctb-input" data-action="rewrite-instruction" data-paragraph-index="${index}" placeholder="本段要求（留空且无整体要求 = 不修改）" value="${escapeHTML(paragraph.instruction || '')}">
            </div>`).join('')}
        </div>` : '<div class="ctb-results ctb-results-empty">先读取一个 AI 楼层，再选择要改写的段落。</div>';
        const reviewList = rewriteReview.length ? `<section class="ctb-section">
            <div class="ctb-section-title">逐段审核 <span>${acceptedCount} / ${rewriteReview.length} 段将采用</span></div>
            <div class="ctb-rewrite-reviews">
                ${rewriteReview.map((review, index) => `<div class="ctb-rewrite-review${review.decision === 'accept' ? ' is-accepted' : review.decision === 'reject' ? ' is-rejected' : ''}">
                    <div class="ctb-rewrite-review-title"><span>P${review.paragraph}</span><span>${review.decision === 'accept' ? '将采用' : review.decision === 'reject' ? '不采用' : '等待决定'}</span></div>
                    ${renderDiffPair(review.original, review.replacement)}
                    <div class="ctb-inline"><button type="button" class="ctb-button ctb-primary" data-action="rewrite-decision" data-review-index="${index}" data-decision="accept">采用这段</button><button type="button" class="ctb-button" data-action="rewrite-decision" data-review-index="${index}" data-decision="reject">不采用</button></div>
                </div>`).join('')}
            </div>
            <div class="ctb-inline ctb-rewrite-final"><button type="button" class="ctb-button" data-action="rewrite-all" data-decision="accept">全部采用</button><button type="button" class="ctb-button" data-action="rewrite-all" data-decision="reject">全部不采用</button><button type="button" class="ctb-button ctb-primary" data-action="apply-rewrite"${acceptedCount && !rewriteApplyLoading ? '' : ' disabled'}>${rewriteApplyLoading ? '保存中…' : `采用 ${acceptedCount} 段并保存`}</button></div>
        </section>` : '';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">精确到段落的 AI 改写 ${infoButton('rewrite-scope')}</div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">楼层与正文范围 ${infoButton('rewrite-floor-tag')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-rewrite-floor" type="number" min="0" placeholder="楼层号（留空=最新 AI）" value="${escapeHTML(config.floor || '')}"><input class="ctb-input" id="ctb-rewrite-tag" placeholder="content" value="${escapeHTML(config.tag || 'content')}"><button type="button" class="ctb-button" data-action="prepare-rewrite">读取楼层</button></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">生成渠道 ${infoButton('channel-main')}</div>
                ${renderChannelSettings('rewrite')}
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">内置 system 提示词 ${infoButton('system-cache')}</div>
                <textarea class="ctb-input ctb-textarea ctb-system-prompt" id="ctb-rewrite-system" placeholder="控制段落改写的输出格式和边界">${escapeHTML(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultRewriteSystemPrompt())}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">剧情与设定 ${infoButton('rewrite-context')}</div>
                <div class="ctb-inline ctb-context-row"><label class="ctb-mini-field">最近楼层 <input class="ctb-input" id="ctb-rewrite-context-floors" type="number" min="0" max="50" value="${escapeHTML(config.contextFloors ?? 4)}"></label><label class="ctb-check"><input id="ctb-rewrite-character" type="checkbox"${config.includeCharacter ? ' checked' : ''}> 角色卡</label><label class="ctb-check"><input id="ctb-rewrite-persona" type="checkbox"${config.includePersona ? ' checked' : ''}> 用户设定</label></div>
                ${renderRewriteWorldPicker()}
                <input class="ctb-input ctb-context-tags" id="ctb-rewrite-context-tags" placeholder="上下文标签筛选（留空=整层；例如 content, small_theater）" value="${escapeHTML(config.contextTags || '')}">
                <textarea class="ctb-input ctb-textarea ctb-rewrite-global" id="ctb-rewrite-global" placeholder="整体改写要求（留空且本段也留空 = 该段完全不修改）">${escapeHTML(config.globalInstruction || '')}</textarea>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">段落选择 ${draft ? `<span>共 ${draft.paragraphs.length} 段</span>` : ''}</div>
                ${paragraphList}
                ${draft ? `<div class="ctb-inline ctb-rewrite-generate"><button type="button" class="ctb-button" data-action="rewrite-select-all" data-selected="true">全选</button><button type="button" class="ctb-button" data-action="rewrite-select-all" data-selected="false">全不选</button><button type="button" class="ctb-button" data-action="preview-rewrite-prompt"${rewritePreviewLoading ? ' disabled' : ''}><i class="fa-solid fa-eye"></i> ${rewritePreviewLoading ? '整理中…' : '预览发送内容'}</button><button type="button" class="ctb-button ctb-primary" data-action="run-rewrite"${rewriteLoading ? ' disabled' : ''}>${rewriteLoading ? '正在理解剧情并生成…' : '生成段落补丁'}</button></div>` : ''}
            </section>
            ${rewritePromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览 · 总字数 ${rewritePromptPreview.characters}</span><button type="button" class="ctb-review-expand" data-action="close-rewrite-preview" title="关闭预览" aria-label="关闭预览">×</button></div><pre>${escapeHTML(rewritePromptPreview.text)}</pre></section>` : ''}
            ${reviewList}`;
    }

    async function loadTheaterNativePresets({ force = false, name = '' } = {}) {
        if (theaterNativePresetLoading) return;
        theaterNativePresetLoading = true;
        theaterNativePresetError = '';
        try {
            const manager = getPresetTransferManager();
            if (force || !theaterNativePresetNames.length) theaterNativePresetNames = presetTransferNames(manager);
            const preferred = String(name || settings.theater.nativePresetName || theaterNativePresetName || '');
            theaterNativePresetName = theaterNativePresetNames.includes(preferred) ? preferred : '';
            settings.theater.nativePresetName = theaterNativePresetName;
            if (theaterNativePresetName) {
                const document = await loadPresetTransferDocument(manager, theaterNativePresetName);
                theaterNativePresetEntries = presetTransferRecords(document).filter((entry) => !entry.locked);
                const known = new Set(theaterNativePresetEntries.map((entry) => String(entry.id)));
                const saved = (settings.theater.nativePresetEntryIds || []).map(String).filter((id) => known.has(id));
                settings.theater.nativePresetEntryIds = saved.length ? saved : theaterNativePresetEntries.filter((entry) => entry.inserted && entry.enabled).map((entry) => String(entry.id));
            } else {
                theaterNativePresetEntries = [];
                settings.theater.nativePresetEntryIds = [];
            }
        } catch (error) {
            theaterNativePresetError = error.message || String(error);
            theaterNativePresetEntries = [];
        } finally {
            theaterNativePresetLoading = false;
            theaterNativePresetLoadedOnce = true;
            renderPanel();
        }
    }

    async function chooseTheaterNativePreset(name) {
        theaterNativePresetName = String(name || '');
        settings.theater.nativePresetName = theaterNativePresetName;
        settings.theater.nativePresetEntryIds = [];
        if (!theaterNativePresetName) {
            theaterNativePresetEntries = [];
            theaterNativePresetError = '';
            renderPanel();
            return;
        }
        await loadTheaterNativePresets({ name: theaterNativePresetName });
    }

    function setTheaterNativePresetEntrySelected(id, selected) {
        const key = String(id || '');
        const current = new Set((settings.theater.nativePresetEntryIds || []).map(String));
        if (selected) current.add(key); else current.delete(key);
        settings.theater.nativePresetEntryIds = [...current];
        syncTheaterSelectionUi();
    }

    function setTheaterNativePresetSelection(selected) {
        settings.theater.nativePresetEntryIds = selected
            ? theaterNativePresetEntries.map((entry) => String(entry.id))
            : [];
        syncTheaterSelectionUi();
    }

    async function collectTheaterNativePresetEntries() {
        if (!theaterNativePresetName || !settings.theater.nativePresetEntryIds?.length) return '';
        if (!theaterNativePresetEntries.length) {
            await loadTheaterNativePresets({ name: theaterNativePresetName });
        }
        if (!theaterNativePresetEntries.length && theaterNativePresetError) {
            throw new Error(`读取酒馆预设“${theaterNativePresetName}”失败：${theaterNativePresetError}`);
        }
        const selected = new Set((settings.theater.nativePresetEntryIds || []).map(String));
        return theaterNativePresetEntries.filter((entry) => selected.has(String(entry.id)) && entry.content?.trim())
            .map((entry) => `【酒馆预设 · ${entry.name} · ${entry.raw?.role || 'system'}】\n${entry.content.trim()}`)
            .join('\n\n');
    }

    function renderTheaterNativePresetPicker() {
        const selected = new Set((settings.theater.nativePresetEntryIds || []).map(String));
        const options = ['<option value="">不使用酒馆原生预设</option>']
            .concat(theaterNativePresetNames.map((name) => `<option value="${escapeHTML(name)}"${name === theaterNativePresetName ? ' selected' : ''}>${escapeHTML(name)}</option>`)).join('');
        const list = theaterNativePresetLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取预设…</div>'
            : theaterNativePresetError
                ? `<div class="ctb-world-empty ctb-world-error">${escapeHTML(theaterNativePresetError)}</div>`
                : theaterNativePresetName && theaterNativePresetEntries.length
                    ? `<div class="ctb-theater-native-entry-list" data-ctb-scroll-key="theater-native-entry-list">${theaterNativePresetEntries.map((entry) => `<label class="ctb-theater-native-entry${selected.has(String(entry.id)) ? ' is-selected' : ''}"><input type="checkbox" data-theater-native-entry-id="${escapeHTML(entry.id)}"${selected.has(String(entry.id)) ? ' checked' : ''}><span><strong>${escapeHTML(entry.name)}</strong><small>${escapeHTML(entry.content.trim().replace(/\s+/g, ' ').slice(0, 140) || '（空条目）')}</small></span><em>${entry.enabled ? '启用' : '停用'}</em></label>`).join('')}</div>`
                    : '<div class="ctb-world-empty">选择一个预设后可勾选要带入小剧场的条目。</div>';
        return `<div class="ctb-theater-native-picker"><div class="ctb-inline ctb-theater-native-toolbar"><select class="ctb-input" id="ctb-theater-native-preset">${options}</select><button type="button" class="ctb-icon-button" data-action="refresh-theater-native-presets" title="刷新"><i class="fa-solid fa-rotate"></i></button>${theaterNativePresetName ? `<span class="ctb-selection-count" data-theater-native-selected-count>已选 ${selected.size} 条</span><button type="button" class="ctb-button" data-action="select-theater-native-preset-all">全选</button><button type="button" class="ctb-button" data-action="clear-theater-native-preset">清空</button>` : ''}</div>${list}</div>`;
    }

    function theaterSelectedWorldKeys() {
        return new Set((settings.theater?.worldEntries || []).map((item) => worldEntrySelectionKey(item.world, item.uid)));
    }

    async function fetchTheaterWorldEntries(world, { force = false } = {}) {
        const name = String(world || '').trim();
        if (!name) return [];
        if (!force && theaterWorldEntryCache.has(name)) return theaterWorldEntryCache.get(name);
        const data = await stProxyJson('/api/worldinfo/get', { name });
        const entries = normalizeWorldBookEntries(name, data);
        theaterWorldEntryCache.set(name, entries);
        return entries;
    }

    async function loadTheaterWorldBooks({ force = false } = {}) {
        if (theaterWorldLoading) return;
        theaterWorldLoading = true;
        theaterWorldError = '';
        renderPanel();
        try {
            if (force || !theaterWorldBooks.length) {
                theaterWorldBooks = await getWorldBookNames(force);
            }
            const preferred = theaterWorldBook || currentCharacterWorldBookName();
            theaterWorldBook = theaterWorldBooks.includes(preferred) ? preferred : (theaterWorldBooks[0] || '');
            if (theaterWorldBook) await fetchTheaterWorldEntries(theaterWorldBook, { force });
        } catch (error) {
            theaterWorldError = error.message || String(error);
        } finally {
            theaterWorldLoading = false;
            renderPanel();
        }
    }

    async function chooseTheaterWorldBook(name) {
        theaterWorldBook = String(name || '');
        theaterWorldError = '';
        if (!theaterWorldBook) return renderPanel();
        theaterWorldLoading = true;
        renderPanel();
        try {
            await fetchTheaterWorldEntries(theaterWorldBook);
        } catch (error) {
            theaterWorldError = error.message || String(error);
        } finally {
            theaterWorldLoading = false;
            renderPanel();
        }
    }

    function setTheaterWorldEntrySelected(world, uid, selected) {
        const key = worldEntrySelectionKey(world, uid);
        const existing = settings.theater.worldEntries || [];
        settings.theater.worldEntries = selected
            ? (existing.some((item) => worldEntrySelectionKey(item.world, item.uid) === key)
                ? existing
                : [...existing, { world: String(world), uid: String(uid) }])
            : existing.filter((item) => worldEntrySelectionKey(item.world, item.uid) !== key);
        syncTheaterSelectionUi();
    }

    function setTheaterWorldBookSelection(selected) {
        if (!theaterWorldBook) return;
        const entries = theaterWorldEntryCache.get(theaterWorldBook) || [];
        const current = String(theaterWorldBook);
        const other = (settings.theater.worldEntries || []).filter((item) => item.world !== current);
        settings.theater.worldEntries = selected
            ? [...other, ...entries.map((entry) => ({ world: entry.world, uid: entry.uid }))]
            : other;
        syncTheaterSelectionUi();
    }

    function saveTheaterWorldPreset() {
        const config = settings.theater;
        const name = String(config.worldPresetName || '').trim();
        const worldEntries = normalizeWorldEntrySelections(config.worldEntries);
        if (!name) return notify('请先填写世界书选择预设名称', 'warning');
        if (!worldEntries.length) return notify('请先选择至少一个世界书条目', 'warning');
        if (!Array.isArray(config.worldPresets)) config.worldPresets = [];
        let preset = config.worldPresets.find((item) => item.id === config.selectedWorldPresetId);
        if (!preset) {
            preset = {
                id: `theater-world-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                name,
                worldEntries,
            };
            config.worldPresets.push(preset);
            config.selectedWorldPresetId = preset.id;
        } else {
            Object.assign(preset, { name, worldEntries });
        }
        config.worldPresetName = name;
        config.worldEntries = worldEntries;
        saveSettings();
        renderPanel();
        notify(`世界书选择预设“${name}”已保存`, 'success');
    }

    function deleteTheaterWorldPreset() {
        const config = settings.theater;
        const index = (config.worldPresets || []).findIndex((item) => item.id === config.selectedWorldPresetId);
        if (index < 0) return;
        const name = config.worldPresets[index].name;
        if (!host.confirm(`确定删除世界书选择预设“${name}”吗？`)) return;
        config.worldPresets.splice(index, 1);
        config.selectedWorldPresetId = '';
        config.worldPresetName = '';
        saveSettings();
        renderPanel();
    }

    async function selectTheaterWorldPreset(id) {
        const config = settings.theater;
        config.selectedWorldPresetId = String(id || '');
        const preset = (config.worldPresets || []).find((item) => item.id === config.selectedWorldPresetId);
        if (!preset) {
            config.worldPresetName = '';
            renderPanel();
            return;
        }
        config.worldPresetName = preset.name || '';
        config.worldEntries = normalizeWorldEntrySelections(preset.worldEntries);
        const firstWorld = config.worldEntries[0]?.world || '';
        if (firstWorld) theaterWorldBook = firstWorld;
        renderPanel();
        if (firstWorld && (!theaterWorldBooks.length || !theaterWorldEntryCache.has(firstWorld))) {
            await loadTheaterWorldBooks();
        }
    }

    function orderedTheaterWorldBookNames(selections = settings.theater?.worldEntries || []) {
        const selected = new Set();
        const order = [];
        for (const item of selections) {
            const name = String(item.world || '').trim();
            if (name && !selected.has(name)) {
                selected.add(name);
                order.push(name);
            }
        }
        // 多本书按首次选择顺序分组，书内按世界书管理顺序。
        return order;
    }

    async function collectTheaterWorldEntries() {
        const selections = settings.theater?.worldEntries || [];
        if (!selections.length) return '';
        const selected = theaterSelectedWorldKeys();
        const output = [];
        for (const world of orderedTheaterWorldBookNames(selections)) {
            let entries;
            try {
                // fetchTheaterWorldEntries already applies the exact manager
                // comparator; do not sort by checkbox click order here.
                entries = await fetchTheaterWorldEntries(world);
            } catch (error) {
                throw new Error(`读取世界书“${world}”失败：${error?.message || String(error)}`);
            }
            for (const entry of entries) {
                if (!selected.has(worldEntrySelectionKey(entry.world, entry.uid))) continue;
                if (entry.content.trim()) output.push(`【${entry.world} · ${entry.comment}】\n${entry.content.trim()}`);
            }
        }
        return output.join('\n\n');
    }

    function theaterWorldSelectionCounts() {
        const counts = new Map();
        for (const item of settings.theater.worldEntries || []) {
            const world = String(item.world || '未命名世界书');
            counts.set(world, (counts.get(world) || 0) + 1);
        }
        return orderedTheaterWorldBookNames(settings.theater.worldEntries || [])
            .map((world) => ({ world, count: counts.get(world) || 0 }));
    }

    function syncTheaterSelectionUi() {
        if (!root) return;
        const nativeSelected = new Set((settings.theater.nativePresetEntryIds || []).map(String));
        root.querySelectorAll('[data-theater-native-entry-id]').forEach((input) => {
            input.checked = nativeSelected.has(String(input.dataset.theaterNativeEntryId));
            input.closest('.ctb-theater-native-entry')?.classList.toggle('is-selected', input.checked);
        });
        const nativeCount = root.querySelector('[data-theater-native-selected-count]');
        if (nativeCount) nativeCount.textContent = `已选 ${nativeSelected.size} 条`;

        const worldSelected = theaterSelectedWorldKeys();
        root.querySelectorAll('[data-theater-world-entry-uid]').forEach((input) => {
            input.checked = worldSelected.has(worldEntrySelectionKey(input.dataset.theaterWorldName, input.dataset.theaterWorldEntryUid));
            input.closest('.ctb-world-entry')?.classList.toggle('is-selected', input.checked);
        });
        const total = settings.theater.worldEntries?.length || 0;
        const button = root.querySelector('[data-theater-world-picker-button]');
        button?.classList.toggle('ctb-primary-soft', total > 0);
        const count = root.querySelector('[data-theater-world-selected-count]');
        if (count) count.textContent = total ? `已选 ${total} 条` : '未选择';
        const clear = root.querySelector('[data-theater-world-clear]');
        if (clear) clear.hidden = total === 0;
        const summary = root.querySelector('[data-theater-world-selection-summary]');
        if (summary) {
            summary.hidden = total === 0;
            summary.innerHTML = theaterWorldSelectionCounts()
                .map(({ world, count: bookCount }) => `<span title="${escapeHTML(world)}">${escapeHTML(world)} · 已选 ${bookCount} 条</span>`)
                .join('');
        }
    }

    function theaterCharacterAndPersona() {
        const context = getContext();
        const parts = [];
        if (settings.theater.includeCharacter !== false) {
            const characterId = context.characterId ?? context.this_chid ?? host.this_chid;
            const card = context.characters?.[characterId] || host.characters?.[characterId];
            if (card) {
                const text = [
                    card.name ? `角色名：${card.name}` : '',
                    card.description ? `角色描述：${card.description}` : '',
                    card.personality ? `性格：${card.personality}` : '',
                    card.scenario ? `场景：${card.scenario}` : '',
                ].filter(Boolean).join('\n');
                if (text) parts.push(`【角色卡】\n${text}`);
            }
        }
        if (settings.theater.includePersona !== false) {
            try {
                const persona = String(context.substituteParams?.('{{persona}}') || '').trim();
                if (persona) parts.push(`【用户设定】\n${persona}`);
            } catch (_) {}
        }
        return parts;
    }

    async function buildTheaterMessages() {
        const prompt = String(settings.theater.prompt || '').trim();
        if (!prompt) throw new Error('请先输入小剧场主题或问题');
        const limit = Math.max(0, Math.min(50, Number(settings.theater.contextFloors) || 0));
        const tags = parseTags(settings.theater.contextTags);
        const historyRows = limit > 0 ? getRows().slice(-limit) : [];
        const history = historyRows.map((row) => {
            const text = extractTags(row.text, tags).trim();
            return text ? `${row.isUser ? '用户' : row.name}（#${row.id}）：${text}` : '';
        }).filter(Boolean).join('\n\n');
        const nativePresetEntries = await collectTheaterNativePresetEntries();
        const worldEntries = await collectTheaterWorldEntries();
        const contextParts = [
            ...theaterCharacterAndPersona(),
            nativePresetEntries ? `【用户选择的酒馆原生预设条目】\n${nativePresetEntries}` : '',
            worldEntries ? `【用户选择的世界书条目】\n${worldEntries}` : '',
            history ? `【最近上下文】\n${history}` : '',
        ].filter(Boolean);
        const system = '你是一个独立的小剧场生成器。只在插件内回答用户提出的 IF 线、角色想法或幕后片段，不创建新聊天楼层，不改变主线事实。请明确区分已知剧情与假设内容。';
        const user = [...contextParts, `【小剧场请求】\n${prompt}`].join('\n\n');
        return [{ role: 'system', content: system }, { role: 'user', content: user }];
    }

    function saveTheaterPreset() {
        const config = settings.theater;
        const name = String(config.presetName || '').trim();
        if (!name) return notify('请先填写小剧场预设名称', 'warning');
        let preset = config.presets.find((item) => item.id === config.selectedPresetId);
        const data = {
            prompt: String(config.prompt || ''),
            contextFloors: Number(config.contextFloors) || 0,
            contextTags: String(config.contextTags || ''),
            includeCharacter: config.includeCharacter !== false,
            includePersona: config.includePersona !== false,
            nativePresetName: String(config.nativePresetName || ''),
            nativePresetEntryIds: (config.nativePresetEntryIds || []).map(String),
            worldEntries: normalizeWorldEntrySelections(config.worldEntries),
            channelId: config.channelId || 'main',
        };
        if (!preset) {
            preset = { id: `theater-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, ...data };
            config.presets.push(preset);
            config.selectedPresetId = preset.id;
        } else Object.assign(preset, { name, ...data });
        saveSettings();
        renderPanel();
        notify(`小剧场预设“${name}”已保存`, 'success');
    }

    function deleteTheaterPreset() {
        const config = settings.theater;
        const index = config.presets.findIndex((item) => item.id === config.selectedPresetId);
        if (index < 0) return;
        config.presets.splice(index, 1);
        config.selectedPresetId = '';
        config.presetName = '';
        saveSettings();
        renderPanel();
    }

    async function runTheater() {
        if (theaterLoading) return;
        theaterLoading = true;
        theaterResult = '';
        renderPanel();
        try {
            const messages = await buildTheaterMessages();
            const output = await callAiText('theater', messages);
            theaterResult = String(output || '').trim();
            if (!theaterResult) throw new Error('API 返回了空文本');
            theaterCurrentId = `theater-result-${Date.now().toString(36)}`;
            const item = { id: theaterCurrentId, prompt: settings.theater.prompt, output: theaterResult, time: new Date().toLocaleString() };
            theaterHistory = [item, ...(theaterHistory || [])].slice(0, 20);
            // 最近记录只存在当前页面会话；只有点击星标才写入插件设置。
            notify('小剧场生成完成；未收藏的记录会在刷新后清除', 'success');
        } catch (error) {
            console.error('[聊天工具箱] 小剧场生成失败', error);
            notify(`小剧场生成失败：${error?.message || String(error)}`, 'error');
        } finally {
            theaterLoading = false;
            renderPanel();
        }
    }

    function theaterFavorites() {
        if (!Array.isArray(settings.theater.favorites)) settings.theater.favorites = [];
        return settings.theater.favorites;
    }

    function isTheaterFavorite(id) {
        return theaterFavorites().some((item) => String(item.id) === String(id));
    }

    function formatTheaterOutput(value) {
        const text = String(value || '');
        const formatter = getContext().messageFormatting || host.messageFormatting;
        let html = '';
        if (typeof formatter === 'function') {
            try {
                html = String(formatter(text, '小剧场', false, false, -1, {}, false) || '');
            } catch (_) {}
        }
        if (!html) html = escapeHTML(text).replace(/\n/g, '<br>');
        const template = doc.createElement('template');
        template.innerHTML = html;
        template.content.querySelectorAll('script,style,link,iframe,object,embed,base,meta,form,input,button,select,textarea,dialog,audio,video,svg,math').forEach((node) => node.remove());
        template.content.querySelectorAll('*').forEach((node) => {
            [...node.attributes].forEach((attribute) => {
                const name = attribute.name.toLowerCase();
                const attributeValue = String(attribute.value || '').trim();
                if (['autofocus', 'autoplay', 'contenteditable', 'tabindex'].includes(name)
                    || name.startsWith('on')
                    || ((name === 'href' || name === 'src' || name === 'xlink:href')
                        && /^(?:javascript|data:text\/html|blob):/i.test(attributeValue))) {
                    node.removeAttribute(attribute.name);
                } else if (((name === 'src' || name === 'poster') && /^https?:/i.test(attributeValue)) || name === 'srcset') {
                    node.removeAttribute(attribute.name);
                } else if (name === 'style') {
                    const safeStyle = attributeValue
                        .replace(/url\(\s*[^)]*\)/gi, 'none')
                        .replace(/expression\s*\([^)]*\)/gi, '')
                        .replace(/position\s*:\s*(?:fixed|sticky)\s*;?/gi, '');
                    node.setAttribute('style', safeStyle);
                }
            });
        });
        return template.innerHTML;
    }

    function cleanTheaterRichHtml(value) {
        let source = String(value || '').trim();
        const fenced = source.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
        if (fenced) source = fenced[1];
        const rich = /<[a-z][a-z0-9:-]*(?:\s[^>]*)?>/i.test(source);
        if (!rich) return { rich: false, html: formatTheaterOutput(source) };
        try {
            const Parser = host.DOMParser || globalThis.DOMParser;
            if (typeof Parser !== 'function') throw new Error('当前浏览器不支持 HTML 解析');
            const parsed = new Parser().parseFromString(source, 'text/html');
            parsed.querySelectorAll('script,link,iframe,object,embed,base,meta,form,input,button,select,textarea,dialog,audio,video,svg,math').forEach((node) => node.remove());
            parsed.querySelectorAll('*').forEach((node) => {
                [...node.attributes].forEach((attribute) => {
                    const name = attribute.name.toLowerCase();
                    const attributeValue = String(attribute.value || '').trim();
                    if (['autofocus', 'autoplay', 'contenteditable', 'tabindex'].includes(name)
                        || name.startsWith('on')
                        || ((name === 'href' || name === 'src' || name === 'xlink:href')
                            && /^(?:javascript|data:text\/html|blob):/i.test(attributeValue))) {
                        node.removeAttribute(attribute.name);
                    } else if (((name === 'src' || name === 'poster') && /^https?:/i.test(attributeValue)) || name === 'srcset') {
                        node.removeAttribute(attribute.name);
                    } else if (name === 'style') {
                        const safeStyle = attributeValue
                            .replace(/url\(\s*[^)]*\)/gi, 'none')
                            .replace(/expression\s*\([^)]*\)/gi, '')
                            .replace(/position\s*:\s*(?:fixed|sticky)\s*;?/gi, '');
                        node.setAttribute('style', safeStyle);
                    }
                });
            });
            parsed.querySelectorAll('style').forEach((node) => {
                node.textContent = String(node.textContent || '')
                    .replace(/@import[\s\S]*?;/gi, '')
                    .replace(/url\(\s*[^)]*\)/gi, 'none')
                    .replace(/([^{}]+)\{/g, (match, selector) => `${selector.replace(/\b(?:html|body)\b|:root/gi, ':host')}{`);
            });
            const styles = [...parsed.head.querySelectorAll('style')].map((node) => node.outerHTML).join('');
            return { rich: true, html: `${styles}${parsed.body.innerHTML}` };
        } catch (_) {
            return { rich: false, html: formatTheaterOutput(source) };
        }
    }

    function theaterOutputSlot(value, extraClass = '') {
        const key = `theater-render-${++theaterRenderSequence}`;
        theaterRenderCache.set(key, String(value || ''));
        return `<div class="ctb-theater-render${extraClass ? ` ${extraClass}` : ''}" data-ctb-theater-render="${key}"></div>`;
    }

    function theaterPlainPreview(value, limit = 420) {
        // Recent history is a navigation list, not the full reader.  Keeping
        // it as escaped plain text avoids parsing and attaching a ShadowRoot
        // for every long historical result on every panel repaint.
        let text = String(value || '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text.length > limit) text = `${text.slice(0, limit)}…`;
        return escapeHTML(text || '（空结果；点击“放大阅读”查看原始内容）');
    }

    function hydrateTheaterOutputs() {
        if (!root) return;
        root.querySelectorAll('[data-ctb-theater-render]').forEach((container) => {
            const value = theaterRenderCache.get(container.dataset.ctbTheaterRender) || '';
            try {
                const rendered = cleanTheaterRichHtml(value);
                if (!rendered.rich) {
                    container.innerHTML = rendered.html;
                    return;
                }
                if (typeof container.attachShadow !== 'function') {
                    container.textContent = value;
                    return;
                }
                const shadow = container.shadowRoot || container.attachShadow({ mode: 'open' });
                shadow.innerHTML = `<style>
                    :host{display:block;contain:layout paint;color:inherit;font:inherit;line-height:1.55;overflow:auto}
                    *,*::before,*::after{box-sizing:border-box}
                    img,video,canvas{max-width:100%;height:auto}
                    table{max-width:100%;border-collapse:collapse}
                    pre{overflow:auto;white-space:pre-wrap;word-break:break-word}
                    a{color:#5b8366}
                </style><div class="ctb-theater-document">${rendered.html}</div>`;
            } catch (error) {
                console.warn('[聊天工具箱] 小剧场渲染失败，已回退纯文本', error);
                container.textContent = value;
            }
        });
    }

    function theaterRecordById(id, source = 'recent') {
        const list = source === 'favorite' ? theaterFavorites() : theaterHistory;
        return list.find((item) => String(item.id) === String(id)) || null;
    }

    function renderTheaterReader() {
        if (!theaterReader) return '';
        return `<div class="ctb-reader-overlay" role="dialog" aria-modal="true">
            <div class="ctb-reader-card">
                <div class="ctb-reader-header"><span>${escapeHTML(theaterReader.title || '小剧场阅读')}</span><button type="button" class="ctb-close" data-action="close-theater-reader" aria-label="关闭">×</button></div>
                <article class="ctb-reader-content" data-ctb-scroll-key="theater-reader">${theaterOutputSlot(theaterReader.output || '', 'is-reader')}</article>
            </div>
        </div>`;
    }

    function renderTheaterWorldPicker() {
        const selections = settings.theater.worldEntries || [];
        const summaries = theaterWorldSelectionCounts();
        const selected = theaterSelectedWorldKeys();
        const entries = theaterWorldEntryCache.get(theaterWorldBook) || [];
        const books = theaterWorldBooks.map((name) => `<option value="${escapeHTML(name)}"${name === theaterWorldBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const worldPresetOptions = ['<option value="">选择世界书预设…</option>']
            .concat((settings.theater.worldPresets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${settings.theater.selectedWorldPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`))
            .join('');
        const presetControls = `<div class="ctb-section-title ctb-world-preset-title">世界书选择预设 <span>只保存勾选条目</span></div><div class="ctb-inline ctb-preset-row"><select class="ctb-input" id="ctb-theater-world-preset">${worldPresetOptions}</select><input class="ctb-input" id="ctb-theater-world-preset-name" placeholder="预设名称" value="${escapeHTML(settings.theater.worldPresetName || '')}"><button type="button" class="ctb-button" data-action="save-theater-world-preset">保存</button><button type="button" class="ctb-button ctb-danger" data-action="delete-theater-world-preset"${settings.theater.selectedWorldPresetId ? '' : ' disabled'}>删除</button></div>`;
        const list = theaterWorldLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : theaterWorldError
                ? `<div class="ctb-world-empty ctb-world-error">${escapeHTML(theaterWorldError)}</div>`
                : entries.length
                    ? `<div class="ctb-world-entry-list" data-ctb-scroll-key="theater-world-entry-list">${entries.map((entry) => `<label class="ctb-world-entry${selected.has(worldEntrySelectionKey(entry.world, entry.uid)) ? ' is-selected' : ''}"><input type="checkbox" data-theater-world-entry-uid="${escapeHTML(entry.uid)}" data-theater-world-name="${escapeHTML(entry.world)}"${selected.has(worldEntrySelectionKey(entry.world, entry.uid)) ? ' checked' : ''}><span class="ctb-world-entry-main"><strong>${escapeHTML(entry.comment)}</strong><small>${escapeHTML(entry.content.trim().replace(/\s+/g, ' ').slice(0, 110) || '（空条目）')}</small></span><span class="ctb-world-entry-meta">UID ${escapeHTML(entry.uid)}</span></label>`).join('')}</div>`
                    : '<div class="ctb-world-empty">没有可选条目。</div>';
        return `${presetControls}<div class="ctb-world-picker-summary"><button type="button" class="ctb-button${selections.length ? ' ctb-primary-soft' : ''}" data-action="toggle-theater-world-picker" data-theater-world-picker-button><i class="fa-solid fa-book-open"></i> 世界书条目 <span data-theater-world-selected-count>${selections.length ? `已选 ${selections.length} 条` : '未选择'}</span></button><button type="button" class="ctb-button" data-action="clear-theater-world-selection" data-theater-world-clear${selections.length ? '' : ' hidden'}>清空</button></div><div class="ctb-world-selected-summary" data-theater-world-selection-summary${selections.length ? '' : ' hidden'}>${summaries.map(({ world, count }) => `<span title="${escapeHTML(world)}">${escapeHTML(world)} · 已选 ${count} 条</span>`).join('')}</div>${theaterWorldPickerOpen ? `<div class="ctb-world-picker"><div class="ctb-inline ctb-world-book-row"><select class="ctb-input" id="ctb-theater-world-book">${books || '<option value="">没有世界书</option>'}</select><button type="button" class="ctb-icon-button" data-action="refresh-theater-world-books" title="刷新"><i class="fa-solid fa-rotate"></i></button><button type="button" class="ctb-button" data-action="close-theater-world-picker">完成</button></div>${theaterWorldBook ? `<div class="ctb-inline ctb-world-bulk"><span>${escapeHTML(theaterWorldBook)} · ${entries.length} 条</span><button type="button" class="ctb-button" data-action="select-theater-world-all">全选</button><button type="button" class="ctb-button" data-action="clear-theater-world-book">清空本书</button></div>` : ''}${list}</div>` : ''}`;
    }

    function renderTheaterTab() {
        const config = settings.theater;
        if (!theaterNativePresetLoadedOnce && !theaterNativePresetLoading) host.setTimeout(() => loadTheaterNativePresets(), 0);
        const presetOptions = ['<option value="">选择小剧场预设…</option>'].concat((config.presets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${config.selectedPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`)).join('');
        const recent = theaterHistory || [];
        const favorites = theaterFavorites();
        const visibleHistory = theaterHistoryView === 'favorites' ? favorites : recent;
        const history = visibleHistory.map((item) => {
            const favorite = isTheaterFavorite(item.id);
            const source = theaterHistoryView === 'favorites' ? 'favorite' : 'recent';
            return `<article class="ctb-theater-history">
                <div class="ctb-theater-history-head"><span>${escapeHTML(item.time || '')} · ${escapeHTML(item.prompt || '').slice(0, 70)}</span><span>${favorite ? '★' : ''}</span></div>
                <div class="ctb-theater-history-body">${theaterPlainPreview(item.output || '')}</div>
                <div class="ctb-inline ctb-theater-history-actions">
                    <button type="button" class="ctb-button" data-action="open-theater-reader" data-theater-source="${source}" data-theater-id="${escapeHTML(item.id)}">放大阅读</button>
                    <button type="button" class="ctb-button" data-action="use-theater-history" data-theater-source="${source}" data-theater-id="${escapeHTML(item.id)}">载入</button>
                    <button type="button" class="ctb-button${favorite ? ' ctb-primary-soft' : ''}" data-action="toggle-theater-favorite" data-theater-source="${source}" data-theater-id="${escapeHTML(item.id)}">${favorite ? '取消收藏' : '☆ 收藏'}</button>
                    <button type="button" class="ctb-button ctb-danger" data-action="delete-theater-history" data-theater-source="${source}" data-theater-id="${escapeHTML(item.id)}">删除</button>
                </div>
            </article>`;
        }).join('');
        return `<section class="ctb-section"><div class="ctb-section-title">独立小剧场 ${infoButton('theater-scope')}</div></section>
            <section class="ctb-section"><div class="ctb-section-title">生成渠道 ${infoButton('channel-main')}</div>${renderChannelSettings('theater')}</section>
            <section class="ctb-section"><div class="ctb-section-title">小剧场预设</div><div class="ctb-inline ctb-preset-row"><select class="ctb-input" id="ctb-theater-preset">${presetOptions}</select><input class="ctb-input" id="ctb-theater-preset-name" placeholder="预设名称" value="${escapeHTML(config.presetName || '')}"><button type="button" class="ctb-button" data-action="save-theater-preset">保存</button><button type="button" class="ctb-button ctb-danger" data-action="delete-theater-preset"${config.selectedPresetId ? '' : ' disabled'}>删除</button></div></section>
            <section class="ctb-section"><div class="ctb-section-title">酒馆原生预设</div>${renderTheaterNativePresetPicker()}</section>
            <section class="ctb-section"><div class="ctb-section-title">剧情与设定</div><div class="ctb-inline ctb-context-row"><label class="ctb-mini-field">最近楼层 <input class="ctb-input" id="ctb-theater-context-floors" type="number" min="0" max="50" value="${escapeHTML(config.contextFloors ?? 6)}"></label><label class="ctb-check"><input id="ctb-theater-character" type="checkbox"${config.includeCharacter !== false ? ' checked' : ''}> 角色卡</label><label class="ctb-check"><input id="ctb-theater-persona" type="checkbox"${config.includePersona !== false ? ' checked' : ''}> 用户设定</label></div><input class="ctb-input ctb-context-tags" id="ctb-theater-context-tags" placeholder="上下文标签筛选（留空=整层）" value="${escapeHTML(config.contextTags || '')}">${renderTheaterWorldPicker()}</section>
            <section class="ctb-section"><div class="ctb-section-title">小剧场请求</div><textarea class="ctb-input ctb-textarea ctb-theater-prompt" id="ctb-theater-prompt" placeholder="例如：如果这一刻没有人打断，角色会怎么想？">${escapeHTML(config.prompt || '')}</textarea><div class="ctb-inline ctb-theater-actions"><button type="button" class="ctb-button ctb-primary" data-action="run-theater"${theaterLoading ? ' disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> ${theaterLoading ? '生成中…' : '生成小剧场'}</button><button type="button" class="ctb-button" data-action="preview-theater-prompt">预览发送内容</button></div></section>
            ${theaterResult ? `<section class="ctb-section"><div class="ctb-section-title">本次结果 · 字数 ${countCharacters(theaterResult)} <button type="button" class="ctb-review-expand" data-action="open-theater-current-reader" title="放大阅读"><i class="fa-solid fa-expand"></i></button></div><article class="ctb-theater-result">${theaterOutputSlot(theaterResult)}</article></section>` : ''}
            <section class="ctb-section"><div class="ctb-section-title">记录 <span>${theaterHistoryView === 'favorites' ? '收藏夹' : '本次会话'}</span></div>
                <div class="ctb-inline ctb-theater-history-tabs"><button type="button" class="ctb-scope${theaterHistoryView === 'recent' ? ' is-active' : ''}" data-action="set-theater-history-view" data-theater-view="recent">最近</button><button type="button" class="ctb-scope${theaterHistoryView === 'favorites' ? ' is-active' : ''}" data-action="set-theater-history-view" data-theater-view="favorites">★ 收藏夹</button></div>
                <div class="ctb-theater-history-list" data-ctb-scroll-key="theater-history-list">${history || '<div class="ctb-results ctb-results-empty">这里还没有记录。</div>'}</div>
            </section>${theaterPromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览 · 总字数 ${theaterPromptPreview.characters}</span><button type="button" class="ctb-review-expand" data-action="close-theater-preview">×</button></div><pre>${escapeHTML(theaterPromptPreview.text)}</pre></section>` : ''}`;
    }

    let theaterPromptPreview = null;

    async function previewTheaterPrompt() {
        try {
            theaterPromptPreview = buildPromptPreview(await buildTheaterMessages());
        } catch (error) {
            theaterPromptPreview = null;
            notify(error.message, 'warning');
        }
        renderPanel();
    }

    function loadTheaterHistory(id, source = 'recent') {
        const item = theaterRecordById(id, source);
        if (!item) return;
        settings.theater.prompt = item.prompt || '';
        theaterResult = item.output || '';
        theaterCurrentId = item.id;
        renderPanel();
    }

    function toggleTheaterFavorite(id, source = 'recent') {
        const favorites = theaterFavorites();
        const index = favorites.findIndex((item) => String(item.id) === String(id));
        if (index >= 0) {
            favorites.splice(index, 1);
        } else {
            const item = theaterRecordById(id, source);
            if (!item) return;
            favorites.unshift(deepClone(item));
            if (favorites.length > 50) favorites.length = 50;
        }
        saveSettings();
        renderPanel();
    }

    function deleteTheaterHistory(id, source = 'recent') {
        if (source === 'favorite') {
            settings.theater.favorites = theaterFavorites().filter((item) => String(item.id) !== String(id));
            saveSettings();
        } else {
            theaterHistory = theaterHistory.filter((item) => String(item.id) !== String(id));
            if (String(theaterCurrentId) === String(id)) {
                theaterCurrentId = '';
                theaterResult = '';
            }
        }
        renderPanel();
    }

    function deepClone(value) {
        try { return structuredClone(value); } catch (_) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function currentCharacterCard() {
        const context = getContext();
        const characterId = context.characterId ?? context.this_chid ?? host.this_chid;
        return context.characters?.[characterId] || host.characters?.[characterId] || null;
    }

    function currentCharacterWorldBookName() {
        const card = currentCharacterCard();
        return String(card?.data?.extensions?.world || card?.extensions?.world || '').trim();
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
        if (typeof context.saveWorldInfo !== 'function') throw new Error('当前酒馆版本没有公开世界书保存接口');
        const saved = await context.saveWorldInfo(name, deepClone(data), Boolean(immediate));
        if (refreshList) {
            try { await context.updateWorldInfoList?.(); } catch (_) {}
        }
        // 普通编辑保存直接采用刚提交的数据，避免每次都额外等待一次
        // /api/worldinfo/get。跨书移动、重命名等会删除来源数据的操作仍显式
        // 开启 verify，确保目标真实写入后再继续。
        if (!verifyAfterSave) {
            const result = saved && typeof saved === 'object' ? saved : data;
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
    const WORLDBOOK_POSITIONS_V2 = Object.freeze([
        { value: 0, label: '角色定义前' },
        { value: 1, label: '角色定义后' },
        { value: 2, label: '作者注释前' },
        { value: 3, label: '作者注释后' },
        { value: 4, label: '深度（Depth）' },
        { value: 5, label: '示例消息前' },
        { value: 6, label: '示例消息后' },
        { value: 7, label: '命名出口' },
    ]);

    function worldbookIntegerV2(value, fallback = 0) {
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
    }

    function worldbookDisplayIndexV2(raw, fallback) {
        const candidates = [raw?.displayIndex, raw?.extensions?.displayIndex, raw?.extensions?.display_index];
        const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
        return value === undefined ? fallback : Number(value);
    }

    async function loadFreshWorldInfoDocumentV2(name) {
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
            // ST stores these two flags in `extensions` on some versions and
            // at the top level on others.  Hydrate both shapes so the editor
            // and the save serializer remain version-compatible.
            if (value.excludeRecursion === undefined) value.excludeRecursion = Boolean(value.extensions?.exclude_recursion);
            if (value.preventRecursion === undefined) value.preventRecursion = Boolean(value.extensions?.prevent_recursion);
            value.uid = uid;
            const displayIndex = worldbookDisplayIndexV2(value, index);
            value.displayIndex = displayIndex;
            return { uid: String(uid), sourceKey: String(key), raw: value, displayIndex };
        });
    }

    function serializeWorldbookRecords(records) {
        const entries = {};
        for (const record of records || []) {
            const raw = deepClone(record?.raw || {});
            const uid = worldbookIntegerV2(raw.uid ?? record?.uid, 0);
            const displayIndex = Number.isFinite(Number(record?.displayIndex))
                ? Number(record.displayIndex)
                : worldbookDisplayIndexV2(raw, 0);
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

    function worldbookWordCountV2(record) {
        const content = String(record?.raw?.content || '');
        return Array.from(content.replace(/\s/g, '')).length;
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

    // Worldbook position is the visible priority requested by the toolbox:
    // character-before, character-after, author-note positions, depth, then
    // example-message positions. Within each position keep the 1.0.2 order:
    // Order descending and UID ascending.
    function worldbookPositionV2(raw) {
        const value = Number(raw?.position);
        return Number.isInteger(value) && value >= 0 && value <= 7 ? value : 1;
    }

    function worldbookOrderV2(raw) {
        const value = Number(raw?.order);
        return Number.isFinite(value) ? value : 0;
    }

    function worldbookGroupKeyV2(record) {
        const position = Number.isInteger(Number(record?.raw?.position)) ? Number(record.raw.position) : 1;
        return position === 4 ? `position-${position}-depth-${Number(record?.raw?.depth ?? 4)}` : `position-${position}`;
    }

    function sortWorldbookRecords(records) {
        const list = Array.isArray(records) ? records.slice() : [];
        return list.sort((a, b) => worldbookPositionV2(a.raw) - worldbookPositionV2(b.raw)
            || worldbookOrderV2(b.raw) - worldbookOrderV2(a.raw)
            || worldbookUidNumber(a) - worldbookUidNumber(b)
            || Number(a.displayIndex ?? 0) - Number(b.displayIndex ?? 0));
    }

    function normalizeWorldbookDisplayIndexesV2(records) {
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

    function markWorldbookDirtyV2() {
        worldbookDirty = true;
        if (worldbookBook) {
            worldbookPendingDocuments.set(worldbookBook, {
                ...(worldbookDocument || {}),
                entries: serializeWorldbookRecords(worldbookEntries),
            });
        }
    }

    function markWorldbookDraftDirtyV2() {
        worldbookDraftDirty = true;
        if (!root) return;
        const draftStatus = root.querySelector('[data-worldbook-draft-status]');
        if (draftStatus) draftStatus.textContent = '当前条目有未暂存修改';
        const saveStatus = root.querySelector('[data-worldbook-save-status]');
        if (saveStatus) saveStatus.textContent = '有未保存的修改';
    }

    function syncWorldbookSelectionUI() {
        if (!root) return;
        root.querySelectorAll('[data-worldbook-row-uid]').forEach((row) => {
            row.classList.toggle('is-selected', worldbookSelected.has(String(row.dataset.worldbookRowUid)));
        });
        const count = root.querySelector('[data-worldbook-selected-count]');
        if (count) count.textContent = `已选 ${worldbookSelected.size} 条`;
        root.querySelectorAll('[data-worldbook-needs-selection]').forEach((button) => {
            button.disabled = worldbookSelected.size === 0;
        });
        const copyToBook = root.querySelector('[data-action="copy-worldbook-entries-to-book"]');
        if (copyToBook) copyToBook.disabled = worldbookSelected.size === 0 || !worldbookCopyTarget;
    }

    async function loadWorldbookManager({ force = false, book = '' } = {}) {
        if (worldbookLoading) return;
        worldbookLoading = true;
        renderPanel();
        try {
            if (force || !worldbookBooks.length) worldbookBooks = await getWorldBookNames(force);
            const preferred = String(book || worldbookBook || currentCharacterWorldBookName() || '');
            worldbookBook = worldbookBooks.includes(preferred) ? preferred : (worldbookBooks[0] || '');
            const pendingDocument = worldbookPendingDocuments.get(worldbookBook);
            if (worldbookBook) {
                worldbookDocument = pendingDocument
                    ? deepClone(pendingDocument)
                    : (force
                        ? await loadFreshWorldInfoDocumentV2(worldbookBook)
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
        } catch (error) {
            notify(`读取世界书失败：${error.message}`, 'error');
        } finally {
            worldbookLoading = false;
            worldbookLoadedOnce = true;
            renderPanel();
        }
    }

    function canDiscardWorldbookChangesV2() {
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        return true;
    }

    async function chooseWorldbook(name) {
        if (!canDiscardWorldbookChangesV2()) return renderPanel();
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

    function discardWorldbookDraftV2() {
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
        const uid = worldbookIntegerV2(record.raw?.uid ?? record.uid, 0);
        record.raw = deepClone(worldbookDraft);
        record.raw.uid = uid;
        // The compact editor no longer exposes the legacy Selective checkbox:
        // entering secondary keywords is the visible signal that their logic
        // should participate in matching.
        record.raw.selective = Array.isArray(record.raw.keysecondary) && record.raw.keysecondary.length > 0;
        record.raw.selectiveLogic = [0, 1, 2, 3].includes(Number(record.raw.selectiveLogic)) ? Number(record.raw.selectiveLogic) : 0;
        record.uid = String(uid);
        record.displayIndex = worldbookDisplayIndexV2(record.raw, record.displayIndex ?? 0);
        worldbookDraft = deepClone(record.raw);
        worldbookDraftDirty = false;
        markWorldbookDirtyV2();
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
        normalizeWorldbookDisplayIndexesV2(worldbookEntries);
        const displayIndex = worldbookEntries.length;
        const raw = {
            uid, comment: '新条目', key: [], keysecondary: [], content: '',
            constant: false, selective: false, selectiveLogic: 0,
            order: 1, position: 0, disable: false,
            depth: 4, probability: 100, useProbability: true, group: '',
            excludeRecursion: false, preventRecursion: false, displayIndex,
        };
        const maxOrder = worldbookEntries
            .filter((record) => worldbookGroupKeyV2(record) === worldbookGroupKeyV2({ raw }))
            .reduce((max, record) => Math.max(max, Number(record.raw?.order) || 0), 0);
        raw.order = maxOrder + 1;
        worldbookEntries.push({ uid: String(uid), sourceKey: String(uid), raw, displayIndex });
        worldbookEditingUid = String(uid);
        worldbookDraft = deepClone(raw);
        worldbookDraftDirty = false;
        markWorldbookDirtyV2();
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
            rewriteWorldEntryCache.delete(worldbookBook);
            theaterWorldEntryCache.delete(worldbookBook);
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

    async function savePendingWorldbooksV2() {
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
        if ((worldbookDraftDirty || worldbookDirty) && !canDiscardWorldbookChangesV2()) return;
        const name = String(host.prompt('新世界书名称：') || '').trim();
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
        if (!book || !host.confirm(`确定删除世界书“${book}”吗？此操作会删除文件。`)) return;
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
        const name = String(host.prompt('新的世界书名称：', oldName) || '').trim();
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

    async function deleteSelectedWorldbookEntries({ confirmed = false } = {}) {
        const ids = [...worldbookSelected];
        if (!ids.length) return;
        if (!confirmed) {
            pendingConfirm = {
                title: '删除世界书条目',
                message: `确定删除选中的 ${ids.length} 个条目吗？删除会在当前世界书中暂存，并在保存时写入。`,
                action: 'delete-worldbook-entries',
            };
            renderPanel();
            return;
        }
        if (worldbookDraftDirty && !ids.includes(String(worldbookEditingUid))) applyWorldbookDraft({ quiet: true });
        worldbookEntries = worldbookEntries.filter((record) => !worldbookSelected.has(record.uid));
        normalizeWorldbookDisplayIndexesV2(worldbookEntries);
        worldbookSelected = new Set();
        if (ids.includes(String(worldbookEditingUid))) {
            worldbookEditingUid = '';
            worldbookDraft = null;
            worldbookDraftDirty = false;
        }
        markWorldbookDirtyV2();
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

    function copySelectedWorldbookEntriesV2() {
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
            worldbookEntries.push({ uid: String(uid), sourceKey: String(uid), raw, displayIndex: raw.displayIndex });
            copiedIds.push(String(uid));
        });
        worldbookSelected = new Set(copiedIds);
        markWorldbookDirtyV2();
        renderPanel();
        notify(`已在当前世界书复制 ${copiedIds.length} 个条目；深度、优先级、位置等设置均已保留`, 'success');
    }

    async function copySelectedWorldbookEntriesToBookV2() {
        if (!worldbookBook) return notify('请先选择一本世界书', 'warning');
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        const target = String(worldbookCopyTarget || '').trim();
        if (!target || target === worldbookBook) return notify('请先选择一本不同名的目标世界书', 'warning');
        const selected = currentWorldbookView().filter((record) => worldbookSelected.has(record.uid));
        if (!selected.length) return notify('请先勾选要复制的条目', 'warning');
        try {
            const document = await loadFreshWorldInfoDocumentV2(target);
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
                records.push({ uid: String(uid), sourceKey: String(uid), raw, displayIndex: raw.displayIndex });
            });
            await saveWorldInfoDocument(target, { ...document, entries: serializeWorldbookRecords(records) }, { immediate: true, refreshList: false, verify: true });
            theaterWorldEntryCache.delete(target);
            rewriteWorldEntryCache.delete(target);
            notify(`已复制 ${selected.length} 个条目到“${target}”，条目设置均已保留`, 'success');
        } catch (error) {
            notify(`复制到目标世界书失败：${error.message}`, 'error');
        }
    }

    function mutateWorldbookEntryV2(uid, mutate) {
        const id = String(uid || '');
        const record = worldbookEntries.find((item) => item.uid === id);
        if (!record || typeof mutate !== 'function') return false;
        if (id === String(worldbookEditingUid) && worldbookDraft) {
            mutate(worldbookDraft);
            markWorldbookDraftDirtyV2();
        } else {
            mutate(record.raw);
            markWorldbookDirtyV2();
        }
        renderPanel();
        return true;
    }

    function cycleWorldbookLightV2(uid) {
        return mutateWorldbookEntryV2(uid, (raw) => {
            // Keep the two row controls independent: this button changes only
            // the light type, while the adjacent power button owns disable.
            // A closed entry can therefore retain/select its preferred light
            // without being opened as a side effect.
            raw.constant = !raw.constant;
        });
    }

    function toggleWorldbookEnabledV2(uid) {
        return mutateWorldbookEntryV2(uid, (raw) => { raw.disable = !raw.disable; });
    }

    function setWorldbookRecursionFlagsV2(raw, enabled = true) {
        if (!raw || typeof raw !== 'object') return;
        raw.excludeRecursion = Boolean(enabled);
        raw.preventRecursion = Boolean(enabled);
        raw.extensions = { ...(raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}) };
        raw.extensions.exclude_recursion = Boolean(enabled);
        raw.extensions.prevent_recursion = Boolean(enabled);
    }

    function enableCurrentWorldbookRecursionGuardsV2() {
        if (!worldbookDraft || !worldbookEditingUid) return;
        setWorldbookRecursionFlagsV2(worldbookDraft, true);
        markWorldbookDraftDirtyV2();
        renderPanel();
    }

    function enableSelectedWorldbookRecursionGuardsV2() {
        if (!worldbookSelected.size) return notify('请先勾选要处理的世界书条目', 'warning');
        if (worldbookDraftDirty) applyWorldbookDraft({ quiet: true });
        let count = 0;
        worldbookEntries.forEach((record) => {
            if (!worldbookSelected.has(record.uid)) return;
            setWorldbookRecursionFlagsV2(record.raw, true);
            count += 1;
        });
        if (count) markWorldbookDirtyV2();
        if (worldbookEditingUid) {
            const record = worldbookEntries.find((item) => item.uid === String(worldbookEditingUid));
            if (record) worldbookDraft = deepClone(record.raw);
        }
        renderPanel();
        notify(`已为 ${count} 个条目开启“不可递归 + 阻止进一步递归”，关闭工具箱时统一保存`, 'success');
    }

    function toggleWorldbookBatchModeV2() {
        worldbookBatchMode = !worldbookBatchMode;
        if (!worldbookBatchMode) worldbookSelected = new Set();
        renderPanel();
    }

    function setWorldbookSelectionV2(mode) {
        const visible = currentWorldbookView().filter((record) => {
            const query = worldbookSearch.trim().toLowerCase();
            return !query || worldbookRecordSearchText(record).includes(query);
        });
        if (mode === 'clear') worldbookSelected = new Set();
        else visible.forEach((record) => worldbookSelected.add(record.uid));
        renderPanel();
    }

    function renderWorldbookInlineEditorV2(record) {
        const draft = worldbookDraft || record.raw || {};
        const positionItems = WORLDBOOK_POSITIONS_V2.filter((item) => item.value !== 7);
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
                <label class="ctb-field"><span>关键词</span><input class="ctb-input" id="ctb-worldbook-keys" placeholder="多个关键词用逗号分隔" value="${escapeHTML((Array.isArray(draft.key) ? draft.key : []).join(', '))}"></label>
                <label class="ctb-field"><span>次要关键词</span><input class="ctb-input" id="ctb-worldbook-keysecondary" placeholder="可选；多个关键词用逗号分隔" value="${escapeHTML((Array.isArray(draft.keysecondary) ? draft.keysecondary : []).join(', '))}"></label>
                <label class="ctb-field"><span>次要关键词逻辑</span><select class="ctb-input" id="ctb-worldbook-selective-logic">${logicOptions}</select></label>
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

    function renderWorldbookRowsV2(records) {
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
                        <span class="ctb-worldbook-word-count" title="正文字符数">${worldbookWordCountV2(record)} 字</span>
                    </div>
                    <button type="button" class="ctb-worldbook-entry-toggle" data-action="toggle-worldbook-entry" data-worldbook-uid="${escapeHTML(record.uid)}" aria-expanded="${expanded ? 'true' : 'false'}">
                        <span class="ctb-worldbook-entry-main"><strong class="ctb-worldbook-name">${escapeHTML(worldbookRecordLabel(record))}</strong></span>
                        <span class="ctb-worldbook-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M3.5 6 8 10.5 12.5 6"></path></svg></span>
                    </button>
                </div>
                ${expanded ? renderWorldbookInlineEditorV2(record) : ''}
            </article>`;
        }).join('');
    }

    function renderWorldbookTab() {
        if (!worldbookLoadedOnce && !worldbookLoading) host.setTimeout(() => loadWorldbookManager(), 0);
        const query = worldbookSearch.trim().toLowerCase();
        const filtered = currentWorldbookView().filter((record) => !query || worldbookRecordSearchText(record).includes(query));
        const visible = filtered.slice(0, worldbookVisibleLimit);
        const books = worldbookBooks.map((name) => `<option value="${escapeHTML(name)}"${name === worldbookBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const list = worldbookLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : filtered.length
                ? `<div class="ctb-manager-list" data-ctb-scroll-key="worldbook-list">${renderWorldbookRowsV2(visible)}${filtered.length > visible.length ? `<button type="button" class="ctb-list-more" data-action="more-worldbook-entries">再显示 ${Math.min(120, filtered.length - visible.length)} 条（共 ${filtered.length} 条）</button>` : ''}</div>`
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
                ${batchTools}
                <div class="ctb-worldbook-entry-list">${list}</div>
            </section>
            <div class="ctb-inline ctb-manager-savebar"><span data-worldbook-save-status>${worldbookDraftDirty || worldbookDirty ? '修改已暂存，关闭工具箱时会统一保存' : '当前世界书已同步'}</span><button type="button" class="ctb-button ctb-save" data-action="save-worldbook"${worldbookBook && !worldbookSaving ? '' : ' disabled'}>${worldbookSaving ? '保存中…' : '现在保存'}</button></div>`;
    }

    function getPresetTransferManager() {
        const context = getContext();
        const getter = context.getPresetManager || host.SillyTavern?.getPresetManager || host.getPresetManager;
        if (typeof getter !== 'function') throw new Error('当前酒馆版本没有公开预设管理接口');
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
     * 旧版把新条目追加到每一组 prompt_order，导致顺序错乱；这里所有插入、
     * 移动都只操作主顺序，删除时再清理其它组中已经失效的引用。
     */
    function presetTransferMode() {
        return presetTransferModeValue;
    }

    function presetTransferLoadMode() {
        return presetTransferLoadModeValue;
    }

    function presetTransferEntryMatchesLoadMode(entry) {
        return presetTransferLoadMode() === 'all' || Boolean(entry?.inserted && entry?.enabled);
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
                index,
                orderIndex: orderItem?.__ctbOrderIndex ?? -1,
                raw: deepClone(raw),
                name: presetEntryDisplayName(raw, index),
                content,
                marker: Boolean(raw?.marker),
                systemPrompt: Boolean(raw?.system_prompt),
                enabled: orderItem ? orderItem.enabled !== false : raw?.enabled !== false,
                inserted: Boolean(inserted),
                locked: Boolean(raw?.marker),
            });
        };
        if (main?.order?.length) {
            main.order.forEach((orderItem, orderIndex) => {
                const id = String(orderItem?.identifier ?? orderItem?.id ?? orderItem?.uid ?? '');
                if (!id || seen.has(id)) return;
                const found = byId.get(id);
                if (!found) return;
                const order = { ...orderItem, __ctbOrderIndex: orderIndex };
                append(found.raw, found.index, id, order, true);
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
        return selected.filter((entry) => !entry.locked);
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
            if (presetTransferMode() === 'single') {
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
        if (presetTransferMode() !== 'dual' || !presetTransferTarget) return;
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
        if (presetTransferMode() === 'single') {
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
        if (!selected.length || !host.confirm(`确定从预设“${presetTransferSource}”删除选中的 ${selected.length} 个条目吗？`)) return;
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
        if (!entry || entry.locked) return notify('内置标记不能直接编辑', 'warning');
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
        const rootEl = root;
        if (!rootEl) return;
        const count = presetTransferSelected.size;
        if (presetTransferAnchor?.kind === 'after' && presetTransferSelected.has(String(presetTransferAnchor.anchorId))) {
            const replacement = presetTransferPlacementEntries().find((entry) => !entry.locked && !presetTransferSelected.has(String(entry.id)));
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
        const left = new Map(source.filter((entry) => !entry.locked && nameKey(entry)).map((entry) => [nameKey(entry), entry]));
        const right = new Map(target.filter((entry) => !entry.locked && nameKey(entry)).map((entry) => [nameKey(entry), entry]));
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
        const entries = presetTransferMode() === 'dual' ? presetTransferTargetEntries : presetTransferSourceEntries;
        return entries.filter(presetTransferEntryMatchesLoadMode);
    }

    function renderPresetPlacementControls() {
        const entries = presetTransferPlacementEntries();
        const candidates = entries.filter((entry) => !entry.locked && !presetTransferSelected.has(String(entry.id)));
        const requestedKind = presetTransferAnchor?.kind === 'after' ? 'after' : 'top';
        const needsReference = requestedKind === 'after';
        const currentReference = candidates.some((entry) => String(entry.id) === String(presetTransferAnchor?.anchorId || ''))
            ? String(presetTransferAnchor.anchorId)
            : String(candidates[0]?.id || '');
        const referenceOptions = candidates.length
            ? candidates.map((entry) => `<option value="${escapeHTML(entry.id)}"${String(entry.id) === currentReference ? ' selected' : ''}>${escapeHTML(entry.name || '未命名条目')}</option>`).join('')
            : '<option value="">没有可用目标条目</option>';
        const placementScope = presetTransferMode() === 'dual' ? '目标预设' : '当前预设';
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
        const mode = presetTransferMode();
        const loadMode = presetTransferLoadMode();
        const sourceOptions = names.map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferSource ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const targetOptions = names.filter((name) => name !== presetTransferSource).map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferTarget ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const query = presetTransferSearch.trim().toLowerCase();
        const filterEntries = (entries) => entries.filter((entry) => presetTransferEntryMatchesLoadMode(entry)
            && (!query || `${entry.name}\n${entry.content}\n${entry.id}`.toLowerCase().includes(query)));
        const source = filterEntries(presetTransferSourceEntries);
        const target = filterEntries(presetTransferTargetEntries);
        const renderLoadFilter = (side) => `<select class="ctb-input ctb-preset-load-filter" id="ctb-preset-transfer-load-${side}" aria-label="预设条目加载范围"><option value="all"${loadMode === 'all' ? ' selected' : ''}>加载全部条目</option><option value="enabled"${loadMode === 'enabled' ? ' selected' : ''}>仅加载已启用</option></select>`;
        const renderRows = (rows, side, { selectable = false } = {}) => {
            if (!rows.length) return `<div class="ctb-world-empty">${loadMode === 'enabled' ? '没有已启用且符合条件的条目。' : '没有符合条件的条目。'}</div>`;
            const body = rows.slice(0, presetTransferVisibleLimit).map((entry) => {
                const id = String(entry.id);
                const checked = presetTransferSelected.has(id);
                const expanded = !entry.locked && presetTransferDraft?.surface !== 'compare' && presetTransferDraft?.side === side && String(presetTransferDraft?.id) === id;
                const checkbox = selectable ? `<input type="checkbox" data-preset-entry-id="${escapeHTML(id)}"${checked ? ' checked' : ''}${entry.locked ? ' disabled' : ''}>` : '';
                const toggleAttrs = entry.locked ? ' disabled' : ` data-action="toggle-preset-entry" data-preset-entry-id="${escapeHTML(id)}" data-preset-side="${side}" aria-expanded="${expanded ? 'true' : 'false'}"`;
                return `<article class="ctb-preset-entry${checked ? ' is-selected' : ''}${entry.locked ? ' is-locked' : ''}${expanded ? ' is-expanded' : ''}">
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
        const compareRows = mode === 'dual' ? presetCompareSummary(source, target) : [];
        const comparePreview = (entry) => entry ? escapeHTML(presetEntryDisplayContent(entry).replace(/\s+/g, ' ').slice(0, 280) || '（空内容）') : '—';
        const renderCompareSide = (entry, side) => {
            const label = side === 'target' ? '目标' : '来源';
            const editing = !!draft && draft.surface === 'compare' && draft.side === side && String(draft.id) === String(entry?.id);
            if (editing) return `<div class="ctb-preset-compare-side is-editing"><small>${label} · 直接编辑</small><div class="ctb-preset-compare-editor">${renderPresetDraftFields('保存此侧')}</div></div>`;
            return `<div class="ctb-preset-compare-side"><div class="ctb-preset-compare-side-head"><small>${label}</small><button type="button" class="ctb-button ctb-preset-compare-edit" data-action="edit-preset-entry" data-preset-entry-id="${escapeHTML(entry.id)}" data-preset-side="${side}" data-preset-surface="compare">编辑并保存</button></div><p>${comparePreview(entry)}</p></div>`;
        };
        const compare = mode === 'dual' && presetCompareOpen ? `<div class="ctb-preset-compare-list">${compareRows.length ? compareRows.slice(0, 120).map((row) => `<div class="ctb-preset-compare-row"><div class="ctb-preset-compare-title"><span>${escapeHTML(row.kind)}</span><strong>${escapeHTML(row.name)}</strong></div>${renderCompareSide(row.left, 'source')}${renderCompareSide(row.right, 'target')}</div>`).join('') : '<div class="ctb-readonly-note">两个预设没有名称相同但内容不同的条目。</div>'}</div>` : '';
        const transferControls = mode === 'dual'
            ? `<button type="button" class="ctb-button ctb-primary" data-preset-bulk-action="copy" data-ctb-needs-target="true" data-action="copy-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>复制到目标</button><button type="button" class="ctb-button" data-preset-bulk-action="move" data-ctb-needs-target="true" data-action="move-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>移动到目标</button>`
            : `<button type="button" class="ctb-button ctb-primary" data-preset-bulk-action="copy" data-action="copy-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>复制到所选位置</button><button type="button" class="ctb-button" data-preset-bulk-action="move" data-action="move-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>移动到所选位置</button>`;
        const sourceCount = loadMode === 'enabled' ? `${source.length} / ${presetTransferSourceEntries.length} 条` : `${source.length} 条`;
        const targetCount = loadMode === 'enabled' ? `${target.length} / ${presetTransferTargetEntries.length} 条` : `${target.length} 条`;
        return `<section class="ctb-section"><div class="ctb-section-title">预设条目转移 ${infoButton('preset-transfer')}</div></section>
            <section class="ctb-section"><div class="ctb-inline ctb-manager-toolbar"><button type="button" class="ctb-button${mode === 'single' ? ' ctb-primary' : ''}" data-action="set-preset-transfer-mode" data-mode="single">单预设编辑</button><button type="button" class="ctb-button${mode === 'dual' ? ' ctb-primary' : ''}" data-action="set-preset-transfer-mode" data-mode="dual">双预设对比/转移</button>${mode === 'dual' ? '<button type="button" class="ctb-button" data-action="swap-preset-sides">交换左右</button>' : ''}<input class="ctb-input" id="ctb-preset-transfer-search" placeholder="搜索条目" value="${escapeHTML(presetTransferSearch)}"><button type="button" class="ctb-button" data-action="filter-preset-transfer">筛选</button><button type="button" class="ctb-button" data-action="refresh-preset-transfer">刷新预设</button>${mode === 'dual' ? `<button type="button" class="ctb-button" data-action="toggle-preset-compare">${presetCompareOpen ? '隐藏差异' : `比较差异${compareRows.length ? `（${compareRows.length}）` : ''}`}</button>` : ''}</div>${presetTransferError ? `<div class="ctb-readonly-note ctb-world-error">${escapeHTML(presetTransferError)}</div>` : ''}</section>
            <section class="ctb-section ctb-preset-transfer-grid${mode === 'single' ? ' is-single' : ''}"><div><div class="ctb-section-title">${mode === 'single' ? '当前预设' : '来源预设'} <span>${sourceCount}</span></div><select class="ctb-input" id="ctb-preset-transfer-source">${sourceOptions || '<option value="">没有预设</option>'}</select>${renderLoadFilter('source')}<div class="ctb-preset-entry-list" data-ctb-scroll-key="preset-source-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : sourceList}</div></div>${mode === 'dual' ? `<div><div class="ctb-section-title">目标预设 <span>${targetCount}</span></div><select class="ctb-input" id="ctb-preset-transfer-target">${targetOptions || '<option value="">没有其他预设</option>'}</select>${renderLoadFilter('target')}<div class="ctb-preset-entry-list" data-ctb-scroll-key="preset-target-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : targetList}</div></div>` : ''}</section>${compare}
            <section class="ctb-section ctb-preset-actions"><div class="ctb-inline ctb-manager-toolbar"><span>已选 <span data-preset-selection-count>${presetTransferSelected.size}</span> 条</span>${transferControls}<button type="button" class="ctb-button ctb-danger" data-preset-bulk-action="delete" data-action="delete-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>批量删除</button></div>${renderPresetPlacementControls()}</section>`;
    }

    function rememberPanelScroll(tab = activeTab) {
        if (!root || root.hidden) return;
        const body = root.querySelector('.ctb-body');
        const tabs = root.querySelector('.ctb-tabs');
        if (tabs) panelTabsScrollLeft = tabs.scrollLeft;
        const nodes = {};
        root.querySelectorAll('[data-ctb-scroll-key]').forEach((node) => {
            nodes[node.dataset.ctbScrollKey] = { top: node.scrollTop, left: node.scrollLeft };
        });
        panelScrollState.set(tab, {
            bodyTop: body?.scrollTop || 0,
            bodyLeft: body?.scrollLeft || 0,
            tabsLeft: tabs?.scrollLeft || 0,
            nodes,
        });
    }

    function restorePanelScroll(tab = activeTab) {
        const state = panelScrollState.get(tab);
        if (!root) return;
        const apply = () => {
            const body = root.querySelector('.ctb-body');
            const tabs = root.querySelector('.ctb-tabs');
            if (state && body) { body.scrollTop = state.bodyTop; body.scrollLeft = state.bodyLeft; }
            if (tabs) {
                tabs.scrollLeft = panelTabsScrollLeft;
                const active = tabs.querySelector('.ctb-tab.is-active');
                if (active) {
                    const left = active.offsetLeft;
                    const right = left + active.offsetWidth;
                    const viewportLeft = tabs.scrollLeft;
                    const viewportRight = viewportLeft + tabs.clientWidth;
                    if (left < viewportLeft) tabs.scrollLeft = left;
                    else if (right > viewportRight) tabs.scrollLeft = right - tabs.clientWidth;
                    panelTabsScrollLeft = tabs.scrollLeft;
                }
            }
            if (state) {
                root.querySelectorAll('[data-ctb-scroll-key]').forEach((node) => {
                    const saved = state.nodes?.[node.dataset.ctbScrollKey];
                    if (saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left; }
                });
            }
        };
        apply();
        (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(apply);
        host.setTimeout(apply, 60);
    }

    function renderPanel({ remember = true } = {}) {
        if (!root || root.hidden) return;
        // When switching tabs the old DOM still occupies the root. Remembering
        // it under the *new* tab would overwrite that tab's own scroll state
        // and make the tab click appear to jump back to the top.
        if (remember) rememberPanelScroll(activeTab);
        theaterRenderCache.clear();
        theaterRenderSequence = 0;
        const total = getRows().length;
        const modules = ensureActiveTab();
        const renderers = {
            search: renderSearchTab,
            export: renderExportTab,
            'post-edit': renderPostEditTab,
            rewrite: renderRewriteTab,
            theater: renderTheaterTab,
            worldbook: renderWorldbookTab,
            'preset-transfer': renderPresetTransferTab,
        };
        const body = activeTab && renderers[activeTab]
            ? renderers[activeTab]()
            : '<div class="ctb-results ctb-results-empty">所有功能都已在 Extensions 设置中关闭；菜单入口会继续保留。</div>';
        const tabs = modules.map((module) => `<button type="button" class="ctb-tab${activeTab === module.tab ? ' is-active' : ''}" data-action="tab" data-tab="${module.tab}">${module.label}</button>`).join('');
        const wideManager = activeTab === 'preset-transfer';
        const theme = settings.uiTheme === 'green' ? 'green' : 'blue';
        const nextThemeLabel = theme === 'green' ? '蓝色界面' : '绿色界面';
        root.innerHTML = `<div class="ctb-card ctb-theme-${theme}${wideManager ? ' ctb-card-wide' : ''}" role="dialog" aria-modal="true" aria-label="聊天工具箱">
            <header class="ctb-header"><div class="ctb-title"><i class="fa-solid fa-toolbox"></i> 聊天工具箱</div><div class="ctb-header-side"><span>${total} 条消息</span><button type="button" class="ctb-theme-toggle" data-action="toggle-ui-theme" title="切换为${nextThemeLabel}" aria-label="切换为${nextThemeLabel}"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button type="button" class="ctb-close" data-action="close" aria-label="关闭">×</button></div></header>
            ${tabs ? `<nav class="ctb-tabs" style="--ctb-tab-count:${Math.min(modules.length, 5)}">${tabs}</nav>` : ''}
            <main class="ctb-body">${body}${renderInfoPopup()}</main>
            ${renderTransientNotice()}
            ${renderConfirmDialog()}
        </div>${renderTheaterReader()}`;
        hydrateTheaterOutputs();
        restorePanelScroll(activeTab);
        if (theaterReader) {
            (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(() => {
                root?.querySelector('.ctb-reader-header .ctb-close')?.focus?.({ preventScroll: true });
            });
        }
    }

    function handleGlobalKeydown(event) {
        if (event.key !== 'Escape' || !theaterReader || destroyed) return;
        // The reader close button receives focus after opening, but mobile
        // keyboards and host dialogs can move focus outside the toolbox.  A
        // document-level capture listener keeps Escape reliable in both cases.
        event.preventDefault();
        event.stopPropagation();
        theaterReader = null;
        renderPanel();
    }

    function createUI() {
        doc.getElementById(STYLE_ID)?.remove();
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(FLOAT_ID)?.remove();
        doc.getElementById(ENTRY_ID)?.remove();
        doc.getElementById(SETTINGS_ID)?.remove();
        doc.getElementById('ctb-v080-style')?.remove();
        doc.getElementById('ctb-v080-root')?.remove();
        doc.getElementById('ctb-v080-float')?.remove();
        doc.getElementById('ctb-v080-menu-entry')?.remove();
        doc.querySelectorAll('[id$="-extension-settings"]').forEach((node) => {
            if (node !== doc.getElementById(SETTINGS_ID) && node.id.startsWith('ctb-v')) node.remove();
        });
        doc.getElementById('ctb-v020-style')?.remove();
        doc.getElementById('ctb-v020-root')?.remove();
        doc.getElementById('ctb-v020-float')?.remove();
        doc.getElementById('ctb-v020-menu-entry')?.remove();
        // 旧版查找替换脚本可能没有成功执行 destroy，顺手清掉遗留节点，避免出现双悬浮按钮。
        doc.getElementById('chat-search-replace-style-v010')?.remove();
        doc.getElementById('chat-search-replace-panel-v010')?.remove();
        doc.getElementById('chat-search-replace-float-v010')?.remove();
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${ROOT_ID}, #${ROOT_ID} * { box-sizing:border-box; }
            #${ROOT_ID}{position:fixed;inset:0;z-index:2147483000;width:100vw;height:100dvh;min-height:100dvh;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:rgba(14,18,27,.42);font-family:var(--mainFontFamily,Arial,sans-serif);color:var(--SmartThemeBodyColor,#404247);}
            #${ROOT_ID}[hidden]{display:none!important;}
            #${ROOT_ID} .ctb-card{width:min(650px,calc(100vw - 24px));max-height:min(720px,calc(100dvh - 24px));min-height:0;margin:auto;display:flex;flex-direction:column;overflow:hidden;background:#f6f6f8;border:1px solid rgba(92,99,110,.38);border-radius:5px;box-shadow:0 14px 40px rgba(0,0,0,.32);font-size:12px;line-height:1.35;}
            #${ROOT_ID} .ctb-header{display:flex;align-items:center;justify-content:space-between;padding:11px 16px 9px;border-bottom:1px solid #d5d7dc;background:#fafafd;flex:0 0 auto;}
            #${ROOT_ID} .ctb-title{font-size:18px;font-weight:700;color:#373a40;letter-spacing:.01em;} #${ROOT_ID} .ctb-title i{font-size:16px;margin-right:6px;}
            #${ROOT_ID} .ctb-header-side{display:flex;gap:11px;align-items:center;color:#83868c;font-size:12px;}
            #${ROOT_ID} .ctb-close{border:0;background:transparent;color:#85888d;font-size:25px;line-height:18px;padding:0 2px;cursor:pointer;} #${ROOT_ID} .ctb-close:hover{color:#34373b;}
            #${ROOT_ID} .ctb-tabs{display:grid;grid-template-columns:repeat(3,1fr);padding:0 14px;background:#fafafd;border-bottom:1px solid #d8dade;flex:0 0 auto;}
            #${ROOT_ID} .ctb-tab{padding:8px 4px 7px;border:0;border-bottom:3px solid transparent;background:transparent;color:#898c91;font-size:14px;cursor:pointer;} #${ROOT_ID} .ctb-tab.is-active{color:#3f4247;border-bottom-color:#7da287;font-weight:700;}
            #${ROOT_ID} .ctb-body{min-height:0;overflow:auto;padding:11px 16px 15px;background:#f3f3f5;scrollbar-color:#b4b6ba transparent;} #${ROOT_ID} .ctb-body::-webkit-scrollbar{width:8px;} #${ROOT_ID} .ctb-body::-webkit-scrollbar-thumb{background:#b8babf;border-radius:3px;}
            #${ROOT_ID} .ctb-section{margin:0 0 11px;} #${ROOT_ID} .ctb-section-title{display:flex;align-items:center;gap:6px;margin:0 0 6px;color:#45484d;font-size:14px;font-weight:700;} #${ROOT_ID} .ctb-section-title span{font-size:11px;font-weight:400;color:#878a90;}
            #${ROOT_ID} .ctb-divider{height:1px;background:#d7d9dd;margin:10px 0 13px;}
            #${ROOT_ID} .ctb-inline{display:flex;align-items:center;gap:6px;min-width:0;} #${ROOT_ID} .ctb-input{width:100%;min-width:0;height:29px;padding:4px 7px;border:1px solid #cfd2d7;border-radius:4px;background:#e7e7eb;color:#44474c;font:12px var(--mainFontFamily,Arial,sans-serif);outline:0;} #${ROOT_ID} .ctb-input:focus{border-color:#1987c9;box-shadow:0 0 0 1px #1987c9;background:#eeeeF1;}
            #${ROOT_ID} .ctb-icon-button,#${ROOT_ID} .ctb-button{height:29px;border:1px solid transparent;border-radius:4px;background:#e0e1e6;color:#42454a;padding:0 9px;font:12px var(--mainFontFamily,Arial,sans-serif);white-space:nowrap;cursor:pointer;} #${ROOT_ID} .ctb-icon-button{width:31px;padding:0;font-size:14px;} #${ROOT_ID} .ctb-icon-button:hover,#${ROOT_ID} .ctb-button:hover{background:#d1d3d8;} #${ROOT_ID} button:disabled{opacity:.45;cursor:not-allowed;}
            #${ROOT_ID} .ctb-primary{background:#7da287!important;color:#fff!important;} #${ROOT_ID} .ctb-primary:hover{background:#688f73!important;} #${ROOT_ID} .ctb-danger{background:#e9dede!important;color:#794344!important;} #${ROOT_ID} .ctb-danger:hover{background:#ddcccc!important;}
            #${ROOT_ID} .ctb-bookmark-editor{margin-top:7px;} #${ROOT_ID} .ctb-bookmarks{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;} #${ROOT_ID} .ctb-bookmark{display:inline-flex;overflow:hidden;border:1px solid #afc4b5;border-radius:4px;background:#e1e8e3;} #${ROOT_ID} .ctb-bookmark button{border:0;background:transparent;color:#4a5950;padding:3px 7px;cursor:pointer;font:inherit;} #${ROOT_ID} .ctb-bookmark button+button{border-left:1px solid #afc4b5;padding:3px 6px;} #${ROOT_ID} .ctb-bookmark small{color:#6c766f;}
            #${ROOT_ID} .ctb-hint{color:#878a90;font-size:11px;} #${ROOT_ID} .ctb-scope-row{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;} #${ROOT_ID} .ctb-scope{border:1px solid #cacdd1;border-radius:4px;background:#ececef;color:#64676c;padding:4px 7px;font:11px var(--mainFontFamily,Arial,sans-serif);cursor:pointer;} #${ROOT_ID} .ctb-scope.is-active{border-color:#80a68b;background:#dfe9e1;color:#416049;font-weight:700;} #${ROOT_ID} .ctb-clean-blanks{border-style:dashed;color:#6d7770;}
            #${ROOT_ID} .ctb-search-row .ctb-input{flex:1;} #${ROOT_ID} .ctb-check{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:#686b71;font-size:12px;} #${ROOT_ID} input[type="checkbox"]{accent-color:#6f9b7a;width:15px;height:15px;margin:0;}
            #${ROOT_ID} .ctb-nav-row{margin-top:6px;} #${ROOT_ID} .ctb-result-counter{min-width:54px;text-align:center;color:#666a70;} #${ROOT_ID} .ctb-replace-row{margin-top:7px;} #${ROOT_ID} .ctb-replace-row .ctb-input{flex:1;}
            #${ROOT_ID} .ctb-readonly-note{margin-top:7px;padding:7px 8px;border-left:3px solid #a9adb2;background:#e7e8eb;color:#72767b;font-size:12px;} #${ROOT_ID} .ctb-readonly-note i{margin-right:4px;}
            #${ROOT_ID} .ctb-undo-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:7px;padding:5px 7px;border-top:1px solid #d9dadd;color:#6b6e73;font-size:11px;}
            #${ROOT_ID} .ctb-results{max-height:285px;overflow:auto;border:1px solid #ced1d5;border-radius:4px;background:#efeff2;} #${ROOT_ID} .ctb-results::-webkit-scrollbar{width:8px;} #${ROOT_ID} .ctb-results::-webkit-scrollbar-thumb{background:#b4b7bc;border-radius:3px;} #${ROOT_ID} .ctb-results-title{position:sticky;top:0;z-index:1;padding:6px 9px;border-bottom:1px solid #d3d5d9;background:#e2e2e7;color:#777a80;text-align:center;font-size:11px;}
            #${ROOT_ID} .ctb-results-empty{margin-top:11px;padding:14px 9px;color:#8b8e93;text-align:center;} #${ROOT_ID} .ctb-result-row{display:block;width:100%;border:0;border-bottom:1px solid #d5d7db;border-radius:0;background:transparent;padding:6px 11px;color:#46494e;text-align:left;cursor:pointer;font:12px var(--mainFontFamily,Arial,sans-serif);} #${ROOT_ID} .ctb-result-row:last-child{border-bottom:0;} #${ROOT_ID} .ctb-result-row:hover{background:#e3e7e4;} #${ROOT_ID} .ctb-result-row.is-active{background:#dfe8e2;} #${ROOT_ID} .ctb-result-meta{display:flex;justify-content:space-between;gap:8px;color:#777a80;font-size:11px;} #${ROOT_ID} .ctb-result-text{display:flex;align-items:baseline;min-width:0;overflow:hidden;margin-top:2px;white-space:nowrap;font-size:12px;} #${ROOT_ID} .ctb-result-before{max-width:34%;overflow:hidden;direction:rtl;text-align:right;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-result-text mark{flex:0 0 auto;} #${ROOT_ID} .ctb-result-after{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} mark{padding:0;background:transparent;color:#c1504f;font-weight:700;}
            #${ROOT_ID} .ctb-option-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 10px;margin-top:8px;} #${ROOT_ID} .ctb-export-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px;} #${ROOT_ID} .ctb-export-actions .ctb-button{height:39px;color:#fff!important;font-size:13px;font-weight:700;} #${ROOT_ID} .ctb-export-txt{background:#7da287!important;} #${ROOT_ID} .ctb-export-epub{background:#5f94c4!important;}
            #${ROOT_ID} .ctb-info{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin:0;padding:0;border:1px solid #9aa0a7;border-radius:50%;background:transparent;color:#7f858c;font-size:11px;line-height:1;cursor:pointer;} #${ROOT_ID} .ctb-info:hover{border-color:#5f826a;color:#51735d;background:#e4ece6;} #${ROOT_ID} .ctb-info-line{display:flex;align-items:center;min-height:5px;margin-top:5px;} #${ROOT_ID} .ctb-info-popup{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-top:10px;padding:7px 8px;border:1px solid #bfc7c2;border-left:3px solid #7da287;border-radius:4px;background:#e7ece8;color:#5e6660;font-size:11px;line-height:1.4;} #${ROOT_ID} .ctb-info-popup button{border:0;background:transparent;color:#747a76;font-size:16px;line-height:12px;padding:0;cursor:pointer;}
            .ctb-jump-highlight{outline:2px solid #7da287!important;outline-offset:2px;transition:outline-color .35s;}
            #${ENTRY_ID}{cursor:pointer;}
            @media (max-width:560px){#${ROOT_ID}{padding:max(6px,env(safe-area-inset-top)) max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left));}#${ROOT_ID} .ctb-card{width:calc(100vw - 12px);max-height:calc(100dvh - 12px);}#${ROOT_ID} .ctb-header{padding:10px 12px 8px;}#${ROOT_ID} .ctb-title{font-size:16px;}#${ROOT_ID} .ctb-tabs{padding:0 7px;}#${ROOT_ID} .ctb-tab{font-size:13px;}#${ROOT_ID} .ctb-body{padding:10px 12px 13px;}#${ROOT_ID} .ctb-search-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-search-row .ctb-input{flex-basis:100%;}}
            @supports not (height:100dvh){#${ROOT_ID}{height:100vh;min-height:100vh;}#${ROOT_ID} .ctb-card{max-height:min(720px,calc(100vh - 24px));}@media (max-width:560px){#${ROOT_ID} .ctb-card{max-height:calc(100vh - 12px);}}}
            /* v0.3.1 compact visual pass */
            #${ROOT_ID} .ctb-card{font-size:11px;border-radius:4px;}
            #${ROOT_ID} .ctb-title{font-size:16px;}
            #${ROOT_ID} .ctb-header-side{font-size:11px;}
            #${ROOT_ID} .ctb-tabs{grid-template-columns:repeat(4,minmax(0,1fr));padding:0 10px;}
            #${ROOT_ID} .ctb-tab{font-size:12px;padding:7px 3px 6px;}
            #${ROOT_ID} .ctb-section-title{font-size:13px;}
            #${ROOT_ID} .ctb-input,#${ROOT_ID} .ctb-button,#${ROOT_ID} .ctb-icon-button{font-size:11px;}
            #${ROOT_ID} .ctb-info{display:inline-flex;width:13px;height:13px;min-width:13px;padding:0;border:1px solid #8f959b;border-radius:50%;background:transparent!important;color:#858b91!important;font:500 9px/1 Arial,sans-serif!important;vertical-align:middle;}
            #${ROOT_ID} .ctb-info span{color:inherit!important;font:inherit!important;}
            #${ROOT_ID} .ctb-info:hover{border-color:#70777e;color:#70777e!important;background:transparent!important;}
            #${ROOT_ID} .ctb-info-on-button{margin-left:5px;border-color:#c7cbd0;color:#d1d4d8!important;}
            #${ROOT_ID} .ctb-export-epub-combo{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:39px;overflow:hidden;border-radius:4px;background:#5f94c4;}
            #${ROOT_ID} .ctb-export-epub-combo .ctb-export-epub{display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;min-width:0;gap:4px;padding:0;border:0!important;border-radius:0;background:transparent!important;box-shadow:none!important;}
            #${ROOT_ID} .ctb-export-epub-combo .ctb-export-epub:hover{border:0!important;background:transparent!important;}
            #${ROOT_ID} .ctb-export-info{flex:0 0 auto;margin:0;border-color:rgba(255,255,255,.72);color:#fff!important;}
            #${ROOT_ID} .ctb-review-expand{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;padding:0;border:1px solid #c8c2bf;border-radius:3px;background:transparent;color:#807a78;cursor:pointer;}
            #${ROOT_ID} .ctb-review-expand:hover{background:#e1dcda;color:#5d5653;}
            #${ROOT_ID} .ctb-textarea{height:100px;resize:vertical;line-height:1.45;}
            #${ROOT_ID} .ctb-post-actions{flex-wrap:wrap;}
            #${ROOT_ID} .ctb-post-preview{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
            #${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:1/-1;}
            #${ROOT_ID} .ctb-post-column{min-width:0;}
            #${ROOT_ID} .ctb-post-label{margin-bottom:4px;color:#777b81;font-size:11px;}
            #${ROOT_ID} .ctb-post-label-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;}
            #${ROOT_ID} .ctb-post-text{height:170px;max-height:32vh;overflow:auto;margin:0;padding:8px;border:1px solid #d0d2d7;border-radius:3px;background:#ececef;color:#55585d;font:11px/1.5 var(--mainFontFamily,Arial,sans-serif);white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-post-edit-textarea{width:100%;resize:vertical;}
            #${ROOT_ID} .ctb-save{background:#789b82!important;color:#fff!important;}
            #${ROOT_ID} .ctb-staged-note,#${ROOT_ID} .ctb-save-progress{display:flex;align-items:center;gap:7px;margin-top:6px;padding:6px 8px;border:1px solid #c9d4cc;border-radius:3px;background:#e7ece8;color:#657069;font-size:11px;}
            #${ROOT_ID} .ctb-save-progress{border-color:#b9c9d4;background:#e5ebef;color:#566974;}
            #${ROOT_ID} .ctb-save-spinner{width:12px;height:12px;flex:0 0 auto;border:2px solid #aebdc7;border-top-color:#597c91;border-radius:50%;animation:ctb-spin .8s linear infinite;}
            @keyframes ctb-spin{to{transform:rotate(360deg);}}
            #${ROOT_ID} .ctb-export-tag-input{display:grid;grid-template-columns:minmax(0,1fr) 31px;gap:6px;}
            #${ROOT_ID} .ctb-export-tag-picker{margin-top:6px;overflow:hidden;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;}
            #${ROOT_ID} .ctb-export-tag-picker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 7px;border-bottom:1px solid #d3d5d8;color:#666a70;font-size:11px;}
            #${ROOT_ID} .ctb-export-tag-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));max-height:170px;overflow:auto;padding:5px;}
            #${ROOT_ID} .ctb-export-tag-option{display:grid;grid-template-columns:15px minmax(0,1fr) auto;align-items:center;gap:5px;padding:5px 6px;color:#55595e;font-size:11px;}
            #${ROOT_ID} .ctb-export-tag-option small{color:#898d92;}
            #${ROOT_ID} .ctb-channel-picker{margin-bottom:6px;} #${ROOT_ID} .ctb-channel-picker select{flex:1;}
            #${ROOT_ID} .ctb-channel-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:7px;border:1px solid #d1d3d7;border-radius:3px;background:#ededf0;}
            #${ROOT_ID} .ctb-channel-grid>*:nth-child(2),#${ROOT_ID} .ctb-channel-grid>.ctb-model-row,#${ROOT_ID} .ctb-channel-grid>.ctb-inline:last-child{grid-column:1/-1;}
            #${ROOT_ID} .ctb-channel-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;border:1px solid #d1d3d7;border-radius:3px;background:#ededf0;}
            #${ROOT_ID} .ctb-channel-summary>div{display:flex;min-width:0;flex-direction:column;} #${ROOT_ID} .ctb-channel-summary strong,#${ROOT_ID} .ctb-channel-summary small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-channel-summary small{color:#85898e;font-size:10px;}
            #${ROOT_ID} .ctb-channel-editor-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:6px;}
            #${ROOT_ID} .ctb-model-row select{flex:1;}
            #${ROOT_ID} .ctb-mini-field{display:flex;align-items:center;gap:5px;min-width:0;color:#6f7277;font-size:10px;white-space:nowrap;} #${ROOT_ID} .ctb-mini-field .ctb-input{width:90px;}
            #${ROOT_ID} .ctb-preset-row{margin-bottom:6px;} #${ROOT_ID} .ctb-preset-row select{max-width:150px;} #${ROOT_ID} .ctb-preset-row input{flex:1;} #${ROOT_ID} .ctb-world-preset-title{margin-top:9px;}
            #${ROOT_ID} .ctb-context-row{flex-wrap:wrap;} #${ROOT_ID} .ctb-context-tags{margin-top:6px;} #${ROOT_ID} .ctb-rewrite-global{height:62px;margin-top:6px;}
            #${ROOT_ID} .ctb-primary-soft{border-color:#91aa98;background:#e0e9e3;color:#4d6755;} #${ROOT_ID} .ctb-world-picker-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button:first-child{flex:1;justify-content:space-between;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button span{color:#7a817c;font-size:10px;font-weight:400;}
            #${ROOT_ID} .ctb-world-selected-summary{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px;} #${ROOT_ID} .ctb-world-selected-summary span{max-width:100%;overflow:hidden;padding:3px 6px;border:1px solid #c9d2cc;border-radius:3px;background:#e5ebe7;color:#5c6860;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}
            #${ROOT_ID} .ctb-world-picker{margin-top:6px;overflow:hidden;border:1px solid #cbd0cc;border-radius:3px;background:#e9ebeb;} #${ROOT_ID} .ctb-world-book-row{padding:6px;border-bottom:1px solid #cfd3d0;} #${ROOT_ID} .ctb-world-book-row select{flex:1;} #${ROOT_ID} .ctb-world-bulk{justify-content:flex-end;padding:5px 6px;border-bottom:1px solid #d3d6d4;color:#6d716f;font-size:10px;} #${ROOT_ID} .ctb-world-bulk>span{margin-right:auto;}
            #${ROOT_ID} .ctb-world-entry-list{max-height:230px;overflow:auto;} #${ROOT_ID} .ctb-world-entry{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:6px;padding:7px;border-bottom:1px solid #d4d7d5;color:#555b57;cursor:pointer;} #${ROOT_ID} .ctb-world-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-world-entry.is-selected{background:#dfe8e1;} #${ROOT_ID} .ctb-world-entry-main{display:flex;min-width:0;flex-direction:column;gap:2px;} #${ROOT_ID} .ctb-world-entry-main strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-main small{overflow:hidden;color:#858a87;font-size:9px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-meta{color:#8a8d8b;font-size:9px;white-space:nowrap;} #${ROOT_ID} .ctb-world-empty{display:flex;align-items:center;justify-content:center;gap:7px;min-height:70px;padding:10px;color:#858a87;font-size:10px;} #${ROOT_ID} .ctb-world-error{color:#985957;}
            #${ROOT_ID} .ctb-rewrite-list{max-height:280px;overflow:auto;border:1px solid #cfd1d5;border-radius:3px;background:#ededf0;}
            #${ROOT_ID} .ctb-rewrite-paragraph{display:grid;grid-template-columns:42px minmax(0,1fr);gap:5px 8px;padding:7px 8px;border-bottom:1px solid #d5d6da;} #${ROOT_ID} .ctb-rewrite-paragraph:last-child{border-bottom:0;}
            #${ROOT_ID} .ctb-rewrite-select{grid-row:1/3;display:flex;align-items:flex-start;gap:4px;color:#6b6e73;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-source{min-width:0;color:#4f5257;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-rewrite-generate,#${ROOT_ID} .ctb-rewrite-final{justify-content:flex-end;flex-wrap:wrap;margin-top:7px;}
            #${ROOT_ID} .ctb-rewrite-reviews{display:grid;gap:6px;} #${ROOT_ID} .ctb-rewrite-review{overflow:hidden;border:1px solid #cfd1d5;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-rewrite-review.is-accepted,#${ROOT_ID} .ctb-rewrite-review.is-rejected{border-color:#cfd1d5;opacity:1;}
            #${ROOT_ID} .ctb-rewrite-review-title{display:flex;justify-content:space-between;padding:5px 7px;border-bottom:1px solid #d3d5d8;color:#65696e;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-compare{display:grid;grid-template-columns:1fr 1fr;} #${ROOT_ID} .ctb-rewrite-compare>div{min-width:0;padding:7px;} #${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:1px solid #d3d5d8;background:transparent;} #${ROOT_ID} .ctb-rewrite-compare small{color:#85898e;} #${ROOT_ID} .ctb-rewrite-compare p{margin:3px 0 0;color:#4e5156;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-rewrite-review>.ctb-inline{padding:0 7px 7px;}
            #${ROOT_ID} .ctb-prompt-preview{padding:7px;border:1px solid #cfd3d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-prompt-preview .ctb-section-title{justify-content:space-between;} #${ROOT_ID} .ctb-prompt-preview pre{max-height:320px;overflow:auto;margin:0;padding:8px;background:#f3f3f5;color:#50545a;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-system-prompt{min-height:92px;height:92px;font:11px/1.45 var(--mainFontFamily,Arial,sans-serif);resize:vertical;}
            #${ROOT_ID} .ctb-post-review-grid{grid-template-columns:1fr 1fr 1fr;}
            #${ROOT_ID} .ctb-post-review-grid>div+div{border-left:1px solid #d3d5d8;background:transparent;}
            #${ROOT_ID} .ctb-review-edit{width:100%;min-height:75px;height:75px;resize:vertical;font-size:11px;line-height:1.45;}
            #${ROOT_ID} .ctb-post-changed{color:#8f1d2c;font-weight:600;}
            #${ROOT_ID} .ctb-diff-pair{display:grid;grid-template-columns:1fr 1fr;}
            #${ROOT_ID} .ctb-diff-pair>div{min-width:0;padding:7px;}
            #${ROOT_ID} .ctb-diff-pair>div+div{border-left:1px solid #d3d5d8;background:transparent;}
            #${ROOT_ID} .ctb-diff-pair small{color:#85898e;}
            #${ROOT_ID} .ctb-diff-pair p{margin:3px 0 0;color:#4e5156;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-notice-overlay{position:fixed;inset:0;z-index:2147483200;display:grid;place-items:center;padding:20px;background:rgba(18,21,27,.35);}
            #${ROOT_ID} .ctb-notice-card{width:min(420px,calc(100vw - 36px));padding:14px 16px;border:1px solid #c3c7cc;border-radius:4px;background:#f7f7f9;box-shadow:0 12px 30px rgba(0,0,0,.28);color:#50545a;}
            #${ROOT_ID} .ctb-notice-card.is-error{border-left:4px solid #c35a58;} #${ROOT_ID} .ctb-notice-card.is-warning{border-left:4px solid #b58b4d;} #${ROOT_ID} .ctb-notice-card.is-success{border-left:4px solid #7da287;}
            #${ROOT_ID} .ctb-notice-title{margin-bottom:7px;font-size:13px;font-weight:700;} #${ROOT_ID} .ctb-notice-message{margin-bottom:12px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-confirm-actions{justify-content:flex-end;}
            #${ROOT_ID} .ctb-tabs{display:flex;overflow-x:auto;scrollbar-width:thin;} #${ROOT_ID} .ctb-tab{flex:0 0 calc(100% / var(--ctb-tab-count,4));min-width:92px;}
            #${ROOT_ID} .ctb-theater-prompt{min-height:92px;height:92px;} #${ROOT_ID} .ctb-theater-actions{justify-content:flex-end;margin-top:7px;} #${ROOT_ID} .ctb-theater-result{max-height:360px;overflow:auto;margin:0;padding:9px;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;color:#4e5257;font:11px/1.55 var(--mainFontFamily,Arial,sans-serif);word-break:break-word;} #${ROOT_ID} .ctb-theater-render{display:block;min-height:1.2em;color:inherit;font:inherit;line-height:1.55;} #${ROOT_ID} .ctb-theater-history-list{max-height:365px;overflow:auto;padding-right:2px;scrollbar-width:thin;} #${ROOT_ID} .ctb-theater-history{margin-bottom:5px;border:1px solid #d0d2d6;border-radius:3px;background:#ececef;padding:6px 8px;} #${ROOT_ID} .ctb-theater-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;color:#6e7278;font-size:10px;} #${ROOT_ID} .ctb-theater-history-body{max-height:120px;overflow:hidden;color:#4e5257;font:10px/1.5 var(--mainFontFamily,Arial,sans-serif);white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-theater-history-actions{justify-content:flex-end;flex-wrap:wrap;margin-top:6px;} #${ROOT_ID} .ctb-theater-history-tabs{margin:5px 0 7px;} #${ROOT_ID} .ctb-reader-overlay{position:fixed;inset:0;z-index:2147483150;display:grid;place-items:center;padding:10px;background:rgba(18,21,27,.5);} #${ROOT_ID} .ctb-reader-card{width:min(1100px,calc(100vw - 20px));height:calc(100vh - 20px);height:calc(100dvh - 20px);max-height:900px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #bfc3c8;border-radius:4px;background:#f5f5f7;box-shadow:0 18px 48px rgba(0,0,0,.38);} #${ROOT_ID} .ctb-reader-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid #d3d5d9;background:#fafafd;color:#4c5056;font-size:12px;font-weight:700;} #${ROOT_ID} .ctb-reader-content{flex:1;min-height:0;overflow:auto;padding:15px;background:#f0f0f2;color:#42464c;font:12px/1.65 var(--mainFontFamily,Arial,sans-serif);word-break:break-word;} #${ROOT_ID} .ctb-reader-content .ctb-theater-render{min-height:100%;} 
            #${ROOT_ID} .ctb-theater-native-picker{margin-top:6px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;overflow:hidden;} #${ROOT_ID} .ctb-theater-native-toolbar{padding:6px;border-bottom:1px solid #e2e8f0;} #${ROOT_ID} .ctb-theater-native-toolbar select{flex:1;min-width:0;} #${ROOT_ID} .ctb-selection-count{margin-left:auto;color:#64748b;font-size:10px;white-space:nowrap;} #${ROOT_ID} .ctb-theater-native-entry-list{max-height:260px;overflow:auto;} #${ROOT_ID} .ctb-theater-native-entry{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:6px;padding:7px 8px;border-bottom:1px solid #e2e8f0;color:#334155;cursor:pointer;} #${ROOT_ID} .ctb-theater-native-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-theater-native-entry.is-selected{background:#f1f6fb;} #${ROOT_ID} .ctb-theater-native-entry>span{display:flex;min-width:0;flex-direction:column;gap:2px;} #${ROOT_ID} .ctb-theater-native-entry strong{overflow:hidden;color:#0f172a;font-size:11px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-theater-native-entry small{overflow:hidden;color:#64748b;font-size:9px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-theater-native-entry em{font-style:normal;color:#64748b;font-size:9px;white-space:nowrap;}
            #${ROOT_ID} .ctb-manager-toolbar{flex-wrap:wrap;} #${ROOT_ID} .ctb-manager-toolbar>.ctb-input{flex:1;min-width:140px;} #${ROOT_ID} .ctb-manager-list{max-height:390px;overflow:auto;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-manager-content{min-height:190px;height:190px;} #${ROOT_ID} .ctb-manager-fields{flex-wrap:wrap;} #${ROOT_ID} .ctb-manager-fields select{width:auto;min-width:110px;} #${ROOT_ID} .ctb-manager-actions{justify-content:flex-end;} #${ROOT_ID} .ctb-manager-savebar{position:static;justify-content:space-between;gap:12px;margin:10px 0 0;padding:10px 0 0;border-top:1px solid #cdd0d4;background:transparent;color:#697069;font-size:11px;}
            #${ROOT_ID} .ctb-preset-transfer-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;} #${ROOT_ID} .ctb-preset-transfer-grid.is-single{grid-template-columns:1fr;} #${ROOT_ID} .ctb-preset-entry-list{max-height:365px;overflow:auto;margin-top:6px;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-preset-entry{display:block;min-width:0;padding:6px 7px;border-bottom:1px solid #d5d7da;color:#51555b;} #${ROOT_ID} .ctb-preset-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-preset-entry.is-selected{background:#dfe8e2;} #${ROOT_ID} .ctb-preset-entry strong,#${ROOT_ID} .ctb-preset-entry small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-preset-entry strong{font-size:11px;} #${ROOT_ID} .ctb-preset-entry small{color:#85898e;font-size:9px;}
            #${ROOT_ID} .ctb-preset-entry.is-locked{opacity:.62;}
            #${ROOT_ID} .ctb-preset-entry-head{display:flex;align-items:center;gap:6px;min-width:0;}
            #${ROOT_ID} .ctb-preset-entry-head>input{flex:0 0 auto;margin:0;}
            #${ROOT_ID} .ctb-preset-entry-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:#50545a;font:11px/1.35 var(--mainFontFamily,Arial,sans-serif);font-weight:500;text-align:left;cursor:pointer;}
            #${ROOT_ID} .ctb-preset-draft-content{min-height:150px;height:150px;resize:vertical;line-height:1.45;}
            #${ROOT_ID} .ctb-preset-compare-list{max-height:260px;overflow:auto;margin:0 12px 7px;border:1px solid #cfd2d6;background:#ececef;}
            #${ROOT_ID} .ctb-preset-compare-row{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(0,1fr) minmax(0,1fr);gap:7px;padding:6px 7px;border-bottom:1px solid #d5d7da;font-size:10px;}
            #${ROOT_ID} .ctb-preset-compare-title{display:flex;flex-direction:column;gap:2px;min-width:0;}
            #${ROOT_ID} .ctb-preset-compare-title span{color:#85898e;font-size:9px;}
            #${ROOT_ID} .ctb-preset-compare-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#50545a;font-size:10px;font-weight:600;}
            #${ROOT_ID} .ctb-preset-compare-side{min-width:0;padding-left:6px;border-left:1px solid #d5d7da;}
            #${ROOT_ID} .ctb-preset-compare-side small{color:#85898e;font-size:9px;}
            #${ROOT_ID} .ctb-preset-compare-side p{margin:2px 0 0;overflow:hidden;color:#5b6066;line-height:1.4;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;}
            #${ROOT_ID} .ctb-list-more{display:block;width:100%;border:0;border-top:1px solid #d1d4d7;background:#e1e3e5;color:#697078;padding:7px;cursor:pointer;font:10px var(--mainFontFamily,Arial,sans-serif);} #${ROOT_ID} .ctb-list-more:hover{background:#d8ddda;}
            #${SETTINGS_ID} .ctb-extension-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px;padding:8px 15px 12px;} #${SETTINGS_ID} .ctb-extension-settings-title{grid-column:1/-1;font-weight:700;} #${SETTINGS_ID} label{display:flex;align-items:center;gap:6px;} #${SETTINGS_ID} input{width:16px;height:16px;accent-color:#7da287;}
            @media (max-width:560px){#${ROOT_ID} .ctb-tabs{padding:0 5px;}#${ROOT_ID} .ctb-tab{font-size:11px;}#${ROOT_ID} .ctb-post-preview,#${ROOT_ID} .ctb-channel-grid,#${ROOT_ID} .ctb-rewrite-compare{grid-template-columns:1fr;}#${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:auto;}#${ROOT_ID} .ctb-channel-grid>*{grid-column:1!important;}#${ROOT_ID} .ctb-preset-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-preset-row select{max-width:none;flex-basis:100%;}#${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:0;border-top:1px solid #d3d5d8;}#${ROOT_ID} .ctb-export-tag-options{grid-template-columns:1fr;}}
            @media (max-width:560px){#${ROOT_ID} .ctb-preset-transfer-grid,#${ROOT_ID} .ctb-preset-compare-row{grid-template-columns:1fr;}#${ROOT_ID} .ctb-manager-list,#${ROOT_ID} .ctb-preset-entry-list{max-height:250px;}#${ROOT_ID} .ctb-preset-compare-side{padding-left:0;border-left:0;border-top:1px solid #d5d7da;padding-top:4px;}#${ROOT_ID} .ctb-manager-savebar{margin-left:0;margin-right:0;padding-left:0;padding-right:0;}#${SETTINGS_ID} .ctb-extension-settings-grid{grid-template-columns:1fr;}}

            /* v0.9.1 manager redesign: light, readable, single-list editing and full-width comparison */
            #${ROOT_ID} .ctb-card{background:#fff;color:#1f2937;border-color:#cbd5e1;}
            #${ROOT_ID} .ctb-header,#${ROOT_ID} .ctb-tabs{background:#fff;border-color:#cbd5e1;}
            #${ROOT_ID} .ctb-title,#${ROOT_ID} .ctb-section-title{color:#111827;}
            #${ROOT_ID} .ctb-header-side,#${ROOT_ID} .ctb-tab,#${ROOT_ID} .ctb-hint,#${ROOT_ID} .ctb-readonly-note{color:#475569;}
            #${ROOT_ID} .ctb-body{overflow-x:hidden;background:#f8fafc;color:#1f2937;}
            #${ROOT_ID} .ctb-input{border-color:#94a3b8;background:#fff;color:#111827;}
            #${ROOT_ID} .ctb-input::placeholder{color:#64748b;}
            #${ROOT_ID} .ctb-button,#${ROOT_ID} .ctb-icon-button{border-color:#cbd5e1;background:#e2e8f0;color:#1f2937;}
            #${ROOT_ID} .ctb-card.ctb-card-wide{width:min(1120px,calc(100vw - 24px));}
            #${ROOT_ID} .ctb-card-wide{background:#fff;color:#172033;border-color:#94a3b8;font-size:12px;}
            #${ROOT_ID} .ctb-card-wide .ctb-header,#${ROOT_ID} .ctb-card-wide .ctb-tabs{background:#fff;border-color:#cbd5e1;}
            #${ROOT_ID} .ctb-card-wide .ctb-tabs{overflow-x:hidden;}
            #${ROOT_ID} .ctb-card-wide .ctb-tab{flex:1 1 0;min-width:0;}
            #${ROOT_ID} .ctb-card-wide .ctb-title{color:#0f172a;}
            #${ROOT_ID} .ctb-card-wide .ctb-header-side,#${ROOT_ID} .ctb-card-wide .ctb-tab{color:#475569;}
            #${ROOT_ID} .ctb-card-wide .ctb-tab.is-active{color:#0f172a;border-bottom-color:#2563eb;}
            #${ROOT_ID} .ctb-card-wide .ctb-body{overflow-x:hidden;background:#f8fafc;color:#1e293b;scrollbar-color:#94a3b8 transparent;}
            #${ROOT_ID} .ctb-card-wide .ctb-section-title{color:#0f172a;font-size:14px;}
            #${ROOT_ID} .ctb-card-wide .ctb-section-title span{color:#475569;font-size:11px;}
            #${ROOT_ID} .ctb-card-wide .ctb-input{border-color:#94a3b8;background:#fff;color:#0f172a;font-size:12px;}
            #${ROOT_ID} .ctb-card-wide .ctb-input::placeholder{color:#64748b;}
            #${ROOT_ID} .ctb-card-wide .ctb-input:focus{border-color:#2563eb;background:#fff;box-shadow:0 0 0 2px rgba(37,99,235,.16);}
            #${ROOT_ID} .ctb-card-wide .ctb-button,#${ROOT_ID} .ctb-card-wide .ctb-icon-button{border-color:#cbd5e1;background:#e2e8f0;color:#172033;font-size:11px;}
            #${ROOT_ID} .ctb-card-wide .ctb-button:hover,#${ROOT_ID} .ctb-card-wide .ctb-icon-button:hover{background:#cbd5e1;}
            #${ROOT_ID} .ctb-card-wide .ctb-danger{background:#fff1f2!important;color:#9f1239!important;border-color:#fda4af!important;}
            #${ROOT_ID} .ctb-card-wide .ctb-check,#${ROOT_ID} .ctb-card-wide .ctb-mini-field{color:#334155;font-size:11px;}
            #${ROOT_ID} .ctb-card-wide .ctb-readonly-note{border-left-color:#64748b;background:#f1f5f9;color:#334155;}
            #${ROOT_ID} .ctb-card-wide .ctb-world-empty{color:#475569;font-size:11px;}
            #${ROOT_ID} .ctb-card-wide .ctb-manager-savebar{border-color:#cbd5e1;background:transparent;color:#334155;}

            #${ROOT_ID} .ctb-worldbook-entry-list .ctb-manager-list{max-height:none;overflow:visible;border:0;background:transparent;}
            #${ROOT_ID} .ctb-worldbook-entry{margin-bottom:7px;overflow:hidden;border:1px solid #cbd5e1;border-left:5px solid #94a3b8;border-radius:6px;background:#fff;color:#172033;transition:border-color .15s,box-shadow .15s;}
            #${ROOT_ID} .ctb-worldbook-entry.is-blue{border-left-color:#6f8db4;}
            #${ROOT_ID} .ctb-worldbook-entry.is-green{border-left-color:#71957c;}
            #${ROOT_ID} .ctb-worldbook-entry.is-off{border-left-color:#b7bec8;background:#f1f3f6;filter:grayscale(.32);opacity:.72;}
            #${ROOT_ID} .ctb-worldbook-entry.is-expanded{border-color:#8198b2;border-left-color:#587391;box-shadow:0 3px 12px rgba(15,23,42,.09);}
            #${ROOT_ID} .ctb-worldbook-entry.is-selected{outline:2px solid #9aadc0;outline-offset:-2px;}
            #${ROOT_ID} .ctb-worldbook-entry-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;min-height:48px;padding:7px 9px;}
            #${ROOT_ID} .ctb-worldbook-entry-head.is-batch-mode{grid-template-columns:18px auto minmax(0,1fr);}
            #${ROOT_ID} .ctb-worldbook-entry-head>input{width:16px;height:16px;margin:0;}
            #${ROOT_ID} .ctb-worldbook-entry-toggle{display:grid;grid-template-columns:minmax(0,1fr) 24px;align-items:center;gap:8px;min-width:0;width:100%;padding:0;border:0;background:transparent;color:#172033;text-align:left;cursor:pointer;}
            #${ROOT_ID} .ctb-worldbook-entry-main{display:flex;min-width:0;flex-direction:column;gap:3px;}
            #${ROOT_ID} .ctb-worldbook-entry-main strong{overflow:hidden;color:#0f172a;font-size:12px;font-weight:700;text-overflow:ellipsis;white-space:nowrap;}
            #${ROOT_ID} .ctb-worldbook-chevron{display:grid;place-items:center;width:24px;height:24px;color:#334155;}
            #${ROOT_ID} .ctb-worldbook-chevron svg{width:17px;height:17px;transition:transform .15s;}
            #${ROOT_ID} .ctb-worldbook-chevron path{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
            #${ROOT_ID} .ctb-worldbook-entry.is-expanded .ctb-worldbook-chevron svg{transform:rotate(180deg);}
            #${ROOT_ID} .ctb-worldbook-inline-editor{display:grid;gap:9px;padding:12px 14px 14px;border-top:1px solid #cbd5e1;background:#f8fafc;}
            #${ROOT_ID} .ctb-worldbook-inline-editor-head{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#0f172a;}
            #${ROOT_ID} .ctb-worldbook-inline-editor-head strong{font-size:13px;}
            #${ROOT_ID} .ctb-worldbook-inline-editor-head strong span,#${ROOT_ID} .ctb-worldbook-inline-editor-head>span{color:#475569;font-size:10px;font-weight:500;}
            #${ROOT_ID} .ctb-worldbook-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-field{display:grid;gap:4px;min-width:0;color:#334155;font-size:11px;font-weight:600;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-manager-content{min-height:180px;height:180px;line-height:1.5;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-manager-fields{align-items:end;gap:8px;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-mini-field{display:grid;gap:4px;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-mini-field .ctb-input{width:100px;}
            #${ROOT_ID} .ctb-preset-transfer-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;}
            #${ROOT_ID} .ctb-preset-transfer-grid>div{min-width:0;padding:10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;}
            #${ROOT_ID} .ctb-preset-transfer-grid.is-single{grid-template-columns:minmax(0,1fr);}
            #${ROOT_ID} .ctb-preset-entry-list{max-height:390px;overflow-y:auto;overflow-x:hidden;border-color:#cbd5e1;background:#fff;}
            #${ROOT_ID} .ctb-preset-entry{padding:8px 9px;border-color:#e2e8f0;color:#172033;background:#fff;}
            #${ROOT_ID} .ctb-preset-entry.is-selected{background:#eff6ff;box-shadow:inset 3px 0 #2563eb;}
            #${ROOT_ID} .ctb-preset-entry.is-locked{opacity:.7;background:#f8fafc;}
            #${ROOT_ID} .ctb-preset-entry-title{overflow-wrap:anywhere;white-space:normal;color:#0f172a;font-size:12px;font-weight:650;}
            #${ROOT_ID} .ctb-preset-actions{display:grid;gap:9px;padding:10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;}
            #${ROOT_ID} .ctb-preset-placement{display:grid;grid-template-columns:minmax(170px,.42fr) minmax(0,1fr);align-items:center;gap:12px;padding:9px 10px;border:1px solid #93c5fd;border-radius:5px;background:#eff6ff;}
            #${ROOT_ID} .ctb-preset-placement-label{display:flex;min-width:0;flex-direction:column;gap:2px;}
            #${ROOT_ID} .ctb-preset-placement-label strong{color:#1e3a8a;font-size:12px;}
            #${ROOT_ID} .ctb-preset-placement-label span{color:#334155;font-size:10px;}
            #${ROOT_ID} .ctb-preset-compare-list{max-height:320px;overflow-y:auto;overflow-x:hidden;margin:0 0 11px;border-color:#cbd5e1;border-radius:6px;background:#fff;}
            #${ROOT_ID} .ctb-preset-compare-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;padding:0;border-color:#e2e8f0;background:#fff;font-size:11px;}
            #${ROOT_ID} .ctb-preset-compare-title{grid-column:1/-1;display:flex;flex-direction:row;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid #e2e8f0;background:#f8fafc;}
            #${ROOT_ID} .ctb-preset-compare-title span{flex:0 0 auto;color:#1d4ed8;font-size:10px;font-weight:700;}
            #${ROOT_ID} .ctb-preset-compare-title strong{overflow:visible;color:#0f172a;font-size:11px;white-space:normal;overflow-wrap:anywhere;}
            #${ROOT_ID} .ctb-preset-compare-side{min-width:0;padding:9px;border-left:0;}
            #${ROOT_ID} .ctb-preset-compare-side+.ctb-preset-compare-side{border-left:1px solid #e2e8f0;}
            #${ROOT_ID} .ctb-preset-compare-side small{color:#334155;font-size:10px;font-weight:700;}
            #${ROOT_ID} .ctb-preset-compare-side p{display:block;margin-top:4px;overflow:visible;color:#334155;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;}
            #${ROOT_ID} .ctb-list-more{border-color:#cbd5e1;background:#f1f5f9;color:#334155;font-size:10px;}
            #${ROOT_ID} .ctb-preset-entry-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:7px;min-width:0;}
            #${ROOT_ID} .ctb-preset-entry-head>input{width:16px;height:16px;margin:0;}
            #${ROOT_ID} .ctb-preset-entry-title{min-width:0;margin:0;padding:0;border:0;background:transparent;color:#0f172a;font:600 12px/1.35 var(--mainFontFamily,Arial,sans-serif);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;}
            #${ROOT_ID} .ctb-preset-entry-status{display:inline-flex!important;align-items:center;justify-content:center;margin-left:0!important;padding:2px 6px;border-radius:999px;background:#f1f5f9;color:#334155;font-size:10px;white-space:nowrap;}
            #${ROOT_ID} .ctb-preset-entry-head .ctb-preset-entry-status{justify-self:end;width:max-content!important;min-width:0;max-width:86px;flex:0 0 auto;}
            #${ROOT_ID} .ctb-preset-entry-chevron{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:#334155;cursor:pointer;}
            #${ROOT_ID} .ctb-preset-entry-chevron:hover{background:#e2e8f0;color:#0f172a;}
            #${ROOT_ID} .ctb-preset-entry-chevron svg{width:16px;height:16px;transition:transform .15s;}
            #${ROOT_ID} .ctb-preset-entry-chevron path{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
            #${ROOT_ID} .ctb-preset-entry.is-expanded .ctb-preset-entry-chevron svg{transform:rotate(180deg);}
            #${ROOT_ID} .ctb-preset-entry-editor{display:grid;gap:6px;margin:7px 0 0;padding:9px 10px;border-top:1px solid #dbe4ef;background:#f8fafc;}
            #${ROOT_ID} .ctb-preset-entry-editor .ctb-field{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:5px;font-size:10px;}
            #${ROOT_ID} .ctb-preset-entry-editor .ctb-field>span{color:#334155;}
            #${ROOT_ID} .ctb-preset-entry-editor .ctb-preset-draft-content{min-height:140px;height:140px;resize:vertical;}
            #${ROOT_ID} .ctb-preset-draft-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;}

            @media (max-width:700px){
                #${ROOT_ID} .ctb-card-wide .ctb-tabs{overflow-x:auto;}
                #${ROOT_ID} .ctb-card-wide .ctb-tab{flex:0 0 104px;min-width:104px;}
                #${ROOT_ID} .ctb-worldbook-entry-toggle{grid-template-columns:1fr 24px;gap:5px;}
                #${ROOT_ID} .ctb-worldbook-entry-main{grid-column:1;}
                #${ROOT_ID} .ctb-worldbook-chevron{grid-column:2;grid-row:1;}
                #${ROOT_ID} .ctb-worldbook-editor-grid{grid-template-columns:1fr;}
                #${ROOT_ID} .ctb-preset-placement{grid-template-columns:1fr;}
                #${ROOT_ID} .ctb-preset-entry-head{grid-template-columns:auto minmax(0,1fr) auto auto;gap:5px;}
            }
            @media (max-width:560px){
                #${ROOT_ID} .ctb-card.ctb-card-wide{width:calc(100vw - 12px);}
                #${ROOT_ID} .ctb-worldbook-inline-editor{padding:10px;}
                #${ROOT_ID} .ctb-preset-transfer-grid>div{padding:7px;}
            }

            /* v0.9.2: one accent family, with a user-selectable blue/green
               theme.  Worldbook light dots remain semantic blue/green. */
            #${ROOT_ID} .ctb-card{--ctb-accent:#2f7fc8;--ctb-accent-strong:#2467a8;--ctb-accent-soft:#e8f2fc;--ctb-accent-soft-strong:#f4f8fd;--ctb-accent-ink:#245b8e;}
            #${ROOT_ID} .ctb-card.ctb-theme-green{--ctb-accent:#4f8660;--ctb-accent-strong:#3f704e;--ctb-accent-soft:#eaf3ed;--ctb-accent-soft-strong:#f4f8f5;--ctb-accent-ink:#365f43;}
            #${ROOT_ID} .ctb-theme-blue .ctb-primary,#${ROOT_ID} .ctb-theme-green .ctb-primary,
            #${ROOT_ID} .ctb-theme-blue .ctb-save,#${ROOT_ID} .ctb-theme-green .ctb-save,
            #${ROOT_ID} .ctb-theme-blue .ctb-export-txt,#${ROOT_ID} .ctb-theme-green .ctb-export-txt,
            #${ROOT_ID} .ctb-theme-blue .ctb-export-epub,#${ROOT_ID} .ctb-theme-green .ctb-export-epub{background:var(--ctb-accent)!important;border-color:var(--ctb-accent-strong)!important;color:#fff!important;}
            #${ROOT_ID} .ctb-theme-blue .ctb-primary:hover,#${ROOT_ID} .ctb-theme-green .ctb-primary:hover,
            #${ROOT_ID} .ctb-theme-blue .ctb-save:hover,#${ROOT_ID} .ctb-theme-green .ctb-save:hover,
            #${ROOT_ID} .ctb-theme-blue .ctb-export-txt:hover,#${ROOT_ID} .ctb-theme-green .ctb-export-txt:hover,
            #${ROOT_ID} .ctb-theme-blue .ctb-export-epub:hover,#${ROOT_ID} .ctb-theme-green .ctb-export-epub:hover{background:var(--ctb-accent-strong)!important;}
            #${ROOT_ID} .ctb-tab.is-active{color:var(--ctb-accent-ink)!important;border-bottom-color:var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-theme-blue .ctb-input:focus,#${ROOT_ID} .ctb-theme-green .ctb-input:focus{border-color:var(--ctb-accent)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--ctb-accent) 18%,transparent)!important;}
            #${ROOT_ID} input[type="checkbox"]{accent-color:var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-scope.is-active{border-color:var(--ctb-accent)!important;background:var(--ctb-accent-soft)!important;color:var(--ctb-accent-ink)!important;}
            #${ROOT_ID} .ctb-primary-soft{border-color:var(--ctb-accent)!important;background:var(--ctb-accent-soft)!important;color:var(--ctb-accent-ink)!important;}
            #${ROOT_ID} .ctb-info:hover{border-color:var(--ctb-accent)!important;color:var(--ctb-accent-ink)!important;background:var(--ctb-accent-soft)!important;}
            #${ROOT_ID} .ctb-info-popup{border-left-color:var(--ctb-accent)!important;background:var(--ctb-accent-soft-strong)!important;}
            #${ROOT_ID} .ctb-jump-highlight{outline-color:var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:24px;height:27px;padding:0;border:0;border-radius:0;background:transparent;color:var(--ctb-accent);font-size:16px;cursor:pointer;}
            #${ROOT_ID} .ctb-theme-toggle:hover{background:transparent;color:var(--ctb-accent-strong);transform:scale(1.08);}

            #${ROOT_ID} .ctb-worldbook-status-controls{display:inline-flex;align-items:center;gap:5px;min-width:0;}
            #${ROOT_ID} .ctb-worldbook-light-button,#${ROOT_ID} .ctb-worldbook-enabled-button{display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;box-shadow:none;}
            #${ROOT_ID} .ctb-worldbook-light-button:focus-visible,#${ROOT_ID} .ctb-worldbook-enabled-button:focus-visible{outline:2px solid color-mix(in srgb,var(--ctb-accent) 65%,#fff);outline-offset:2px;}
            #${ROOT_ID} .ctb-worldbook-enabled-button{width:30px;height:17px;border-radius:999px;}
            #${ROOT_ID} .ctb-worldbook-power-track{position:relative;display:block;width:30px;height:16px;border-radius:999px;background:#c7ccd3;box-shadow:inset 0 0 0 1px rgba(15,23,42,.1);transition:background .15s;}
            #${ROOT_ID} .ctb-worldbook-power-track::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.28);transition:left .15s;}
            #${ROOT_ID} .ctb-worldbook-enabled-button.is-on .ctb-worldbook-power-track{background:#4b5563;}
            #${ROOT_ID} .ctb-worldbook-enabled-button.is-on .ctb-worldbook-power-track::after{left:16px;}
            #${ROOT_ID} .ctb-worldbook-enabled-button:hover .ctb-worldbook-power-track{filter:brightness(1.08);}
            #${ROOT_ID} .ctb-worldbook-light-button{width:18px;height:18px;border-radius:50%;}
            #${ROOT_ID} .ctb-worldbook-light-dot{display:block;width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 1px rgba(15,23,42,.16);}
            #${ROOT_ID} .ctb-worldbook-light-button.is-blue .ctb-worldbook-light-dot{background:#4f86cf;}
            #${ROOT_ID} .ctb-worldbook-light-button.is-green .ctb-worldbook-light-dot{background:#579a6b;}
            #${ROOT_ID} .ctb-worldbook-light-button.is-off .ctb-worldbook-light-dot{background:#aeb4bc;}
            #${ROOT_ID} .ctb-worldbook-light-button:hover .ctb-worldbook-light-dot{transform:scale(1.1);}
            #${ROOT_ID} .ctb-worldbook-word-count{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:20px;padding:0 4px;border:1px solid #cbd5e1;border-radius:3px;background:#fff;color:#475569;font-size:9px;line-height:1;white-space:nowrap;}
            #${ROOT_ID} .ctb-worldbook-entry.is-off .ctb-worldbook-word-count{background:#e7e9ed;border-color:#c9ced5;color:#8a919b;}
            #${ROOT_ID} .ctb-worldbook-entry.is-expanded{border-color:var(--ctb-accent)!important;box-shadow:0 3px 12px rgba(15,23,42,.09);}
            #${ROOT_ID} .ctb-worldbook-entry.is-selected{outline-color:color-mix(in srgb,var(--ctb-accent) 45%,#fff)!important;}
            #${ROOT_ID} .ctb-worldbook-entry-list{margin-top:8px;}
            #${ROOT_ID} .ctb-worldbook-batch-panel{display:grid;gap:7px;margin:8px 0 0;padding:7px 8px;border:1px solid #cbd5e1;border-radius:5px;background:#f8fafc;}
            #${ROOT_ID} .ctb-worldbook-batch-head{display:flex;align-items:center;gap:10px;min-width:0;}
            #${ROOT_ID} .ctb-worldbook-selected-count{flex:0 0 auto;margin-right:auto;font-weight:600;white-space:nowrap;}
            #${ROOT_ID} .ctb-worldbook-batch-actions,#${ROOT_ID} .ctb-worldbook-copy-row{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;flex-wrap:wrap;}
            #${ROOT_ID} .ctb-worldbook-batch-actions .ctb-button,#${ROOT_ID} .ctb-worldbook-copy-row .ctb-button{height:27px;}
            #${ROOT_ID} .ctb-worldbook-copy-target{flex:0 1 230px;min-width:170px;height:27px;padding:0 7px;font-size:10px;}
            #${ROOT_ID} .ctb-worldbook-selected-count{margin-right:auto;color:#334155;font-weight:700;}
            #${ROOT_ID} .ctb-worldbook-inline-editor .ctb-manager-checks{flex-wrap:wrap;align-items:center;}
            #${ROOT_ID} .ctb-recursion-quick{margin-left:auto;}

            #${ROOT_ID} .ctb-preset-entry.is-selected{background:var(--ctb-accent-soft-strong)!important;box-shadow:inset 3px 0 var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-preset-placement{border-color:color-mix(in srgb,var(--ctb-accent) 55%,#cbd5e1)!important;background:var(--ctb-accent-soft-strong)!important;}
            #${ROOT_ID} .ctb-preset-placement-label strong{color:var(--ctb-accent-ink)!important;}
            #${ROOT_ID} .ctb-preset-compare-title span{color:var(--ctb-accent-ink)!important;}
            #${ROOT_ID} .ctb-preset-compare-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
            #${ROOT_ID} .ctb-preset-compare-edit{height:24px;padding:0 7px;font-size:10px;}
            #${ROOT_ID} .ctb-preset-compare-side.is-editing{background:var(--ctb-accent-soft-strong);}
            #${ROOT_ID} .ctb-preset-compare-editor{display:grid;gap:6px;margin-top:6px;}
            #${ROOT_ID} .ctb-preset-compare-editor .ctb-field{display:grid;gap:3px;color:#334155;font-size:10px;font-weight:600;}
            #${ROOT_ID} .ctb-preset-compare-editor .ctb-input{height:27px;font-size:11px;}
            #${ROOT_ID} .ctb-preset-compare-editor textarea{min-height:120px;height:120px;resize:vertical;line-height:1.45;}
            #${ROOT_ID} .ctb-preset-compare-editor .ctb-check{font-size:10px;}
            #${ROOT_ID} .ctb-preset-compare-editor .ctb-inline{flex-wrap:wrap;}
            #${ROOT_ID} .ctb-placement-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
            #${ROOT_ID} .ctb-placement-choice{min-width:0;height:30px;padding:0 7px;background:#fff;color:#334155;border-color:#cbd5e1;white-space:normal;}
            #${ROOT_ID} .ctb-placement-choice:hover{border-color:var(--ctb-accent);background:var(--ctb-accent-soft);}
            #${ROOT_ID} .ctb-placement-choice.is-active{background:var(--ctb-accent)!important;border-color:var(--ctb-accent-strong)!important;color:#fff!important;font-weight:700;}
            #${ROOT_ID} .ctb-preset-placement-main{display:grid;gap:6px;min-width:0;}
            #${ROOT_ID} .ctb-placement-reference{display:flex;align-items:center;gap:7px;min-width:0;color:#334155;font-size:10px;}
            #${ROOT_ID} .ctb-placement-reference span{flex:0 0 auto;}
            #${ROOT_ID} .ctb-placement-reference .ctb-input{flex:1;}
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-tab.is-active{color:var(--ctb-accent-ink)!important;border-bottom-color:var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-primary,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-save,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-export-txt,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-export-epub{background:var(--ctb-accent)!important;border-color:var(--ctb-accent-strong)!important;color:#fff!important;}
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-primary:hover,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-save:hover,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-export-txt:hover,
            #${ROOT_ID} .ctb-card.ctb-card-wide .ctb-export-epub:hover{background:var(--ctb-accent-strong)!important;}
            #${ROOT_ID} .ctb-card.ctb-card-wide input[type="checkbox"]{accent-color:var(--ctb-accent)!important;}
            #${ROOT_ID} .ctb-theme-green .ctb-export-epub-combo,#${ROOT_ID} .ctb-theme-blue .ctb-export-epub-combo{background:var(--ctb-accent)!important;}
            @supports not (color:color-mix(in srgb,white,black)){#${ROOT_ID} .ctb-theme-blue .ctb-input:focus,#${ROOT_ID} .ctb-theme-green .ctb-input:focus{box-shadow:0 0 0 2px rgba(91,120,157,.18)!important;}#${ROOT_ID} .ctb-theme-green .ctb-input:focus{box-shadow:0 0 0 2px rgba(95,134,110,.18)!important;}}
            @media (max-width:700px){
                #${ROOT_ID} .ctb-worldbook-entry-head{grid-template-columns:auto minmax(0,1fr);gap:6px;}
                #${ROOT_ID} .ctb-worldbook-entry-head.is-batch-mode{grid-template-columns:16px auto minmax(0,1fr);}
                #${ROOT_ID} .ctb-worldbook-entry-toggle{grid-template-columns:minmax(0,1fr) 24px;}
                #${ROOT_ID} .ctb-worldbook-chevron{grid-column:2;grid-row:1;}
                #${ROOT_ID} .ctb-recursion-quick{margin-left:0;}
            }
            @media (max-width:560px){
                #${ROOT_ID} .ctb-header-side{gap:6px;}
                #${ROOT_ID} .ctb-theme-toggle{width:22px;height:25px;padding:0;font-size:15px;}
                #${ROOT_ID} .ctb-worldbook-entry-head{gap:5px;padding:6px;}
                #${ROOT_ID} .ctb-worldbook-status-controls{gap:3px;}
                #${ROOT_ID} .ctb-worldbook-enabled-button{width:28px;height:16px;}
                #${ROOT_ID} .ctb-worldbook-power-track{width:28px;height:15px;}
                #${ROOT_ID} .ctb-worldbook-light-button{width:17px;height:17px;}
                #${ROOT_ID} .ctb-worldbook-batch-head{align-items:flex-start;flex-direction:column;}
                #${ROOT_ID} .ctb-worldbook-selected-count{margin-right:0;}
                #${ROOT_ID} .ctb-worldbook-batch-actions,#${ROOT_ID} .ctb-worldbook-copy-row{width:100%;}
                #${ROOT_ID} .ctb-placement-choices{grid-template-columns:repeat(2,minmax(0,1fr));}
                #${ROOT_ID} .ctb-placement-reference{align-items:stretch;flex-direction:column;gap:3px;}
            }
        `;
        doc.head.appendChild(style);

        root = doc.createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        root.addEventListener('click', (event) => {
            if (event.target === root) closePanel();
            if (event.target.classList?.contains('ctb-reader-overlay')) {
                theaterReader = null;
                renderPanel();
            }
        });
        root.addEventListener('input', handleInput);
        root.addEventListener('change', handleChange);
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && theaterReader) {
                event.preventDefault();
                theaterReader = null;
                renderPanel();
                return;
            }
            if (event.key === 'Enter' && event.target?.id === 'ctb-query') {
                event.preventDefault();
                executeSearch();
            }
        });
        root.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            if (button) handleAction(button.dataset.action, button.dataset, event);
        });
        doc.body.appendChild(root);
    }

    function handleInput(event) {
        const target = event.target;
        if (!target) return;
        const id = target.id;
        if (id === 'ctb-query') ui.query = target.value;
        else if (id === 'ctb-replacement') ui.replacement = target.value;
        else if (id === 'ctb-floor') ui.floor = target.value;
        else if (id === 'ctb-bookmark-name') ui.bookmarkName = target.value;
        else if (id === 'ctb-export-filename') ui.exportFilename = target.value;
        else if (id === 'ctb-export-start') ui.exportStart = target.value;
        else if (id === 'ctb-export-end') ui.exportEnd = target.value;
        else if (id === 'ctb-export-tags') ui.exportTags = target.value;
        else if (id === 'ctb-post-edit-floor') settings.postEdit.floor = target.value;
        else if (id === 'ctb-post-edit-tag') settings.postEdit.tag = target.value;
        else if (id === 'ctb-post-edit-system') settings.postEdit.systemPrompt = target.value;
        else if (id === 'ctb-post-edit-rules') settings.postEdit.rules = target.value;
        else if (id === 'ctb-post-edit-preset-name') settings.postEdit.presetName = target.value;
        else if (id === 'ctb-post-edit-revised') {
            if (postEditDraft) postEditDraft.revisedContent = target.value;
            return;
        }
        else if (id?.startsWith('ctb-post-edit-review-revised-')) {
            const index = Number(id.slice('ctb-post-edit-review-revised-'.length));
            if (postEditReview[index]) {
                postEditReview[index].replacement = target.value;
                if (postEditDraft) {
                    const current = postEditReview.filter((item) => item.decision === 'accept');
                    postEditDraft.revisedContent = postEditParagraphs(postEditDraft.originalContent).map((paragraph, paragraphIndex) => {
                        const item = current.find((review) => review.paragraph === paragraphIndex + 1);
                        return item ? item.replacement : paragraph;
                    }).join('\n\n');
                }
            }
            return;
        }
        else if (id === 'ctb-rewrite-floor') settings.rewrite.floor = target.value;
        else if (id === 'ctb-rewrite-tag') settings.rewrite.tag = target.value;
        else if (id === 'ctb-rewrite-context-floors') settings.rewrite.contextFloors = target.value;
        else if (id === 'ctb-rewrite-context-tags') settings.rewrite.contextTags = target.value;
        else if (id === 'ctb-rewrite-global') settings.rewrite.globalInstruction = target.value;
        else if (id === 'ctb-rewrite-system') settings.rewrite.systemPrompt = target.value;
        else if (id === 'ctb-theater-prompt') settings.theater.prompt = target.value;
        else if (id === 'ctb-theater-preset-name') settings.theater.presetName = target.value;
        else if (id === 'ctb-theater-world-preset-name') settings.theater.worldPresetName = target.value;
        else if (id === 'ctb-theater-context-floors') settings.theater.contextFloors = target.value;
        else if (id === 'ctb-theater-context-tags') settings.theater.contextTags = target.value;
        else if (id === 'ctb-worldbook-search') { worldbookSearch = target.value; return; }
        else if (id === 'ctb-worldbook-comment' && worldbookDraft) { worldbookDraft.comment = target.value; markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-worldbook-keys' && worldbookDraft) { worldbookDraft.key = target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-worldbook-keysecondary' && worldbookDraft) { worldbookDraft.keysecondary = target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-worldbook-content' && worldbookDraft) { worldbookDraft.content = target.value; markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-worldbook-order' && worldbookDraft) { worldbookDraft.order = Number(target.value) || 0; markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-worldbook-depth' && worldbookDraft) { worldbookDraft.depth = Math.max(0, Number(target.value) || 0); markWorldbookDraftDirtyV2(); return; }
        else if (id === 'ctb-preset-draft-name' && presetTransferDraft) {
            presetTransferDraft.raw.name = target.value;
            return;
        }
        else if (id === 'ctb-preset-transfer-search') { presetTransferSearch = target.value; return; }
        else if (id === 'ctb-preset-draft-content' && presetTransferDraft) {
            // Chat Completion prompts normally use `content`; preserve the
            // original field shape for older preset variants.
            if (Object.prototype.hasOwnProperty.call(presetTransferDraft.raw, 'content')) {
                presetTransferDraft.raw.content = target.value;
            } else if (Object.prototype.hasOwnProperty.call(presetTransferDraft.raw, 'prompt')) {
                presetTransferDraft.raw.prompt = target.value;
            } else {
                presetTransferDraft.raw.content = target.value;
            }
            return;
        }
        else if (target.dataset.channelId) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (!channel) return;
            if (id.endsWith('-channel-name')) channel.name = target.value;
            else if (id.endsWith('-channel-url')) channel.url = target.value;
            else if (id.endsWith('-channel-key')) channel.key = target.value;
            else if (id.endsWith('-channel-temperature')) channel.temperature = target.value;
            else if (id.endsWith('-channel-tokens')) channel.maxTokens = target.value;
            return;
        } else if (target.dataset.paragraphIndex !== undefined && target.dataset.action === 'rewrite-instruction') {
            const paragraph = rewriteDraft?.paragraphs?.[Number(target.dataset.paragraphIndex)];
            if (paragraph) paragraph.instruction = target.value;
            return;
        }
        if (id === 'ctb-post-edit-system' || id === 'ctb-post-edit-rules' || id === 'ctb-rewrite-system') saveSettings();
    }

    async function handleChange(event) {
        const target = event.target;
        if (!target) return;
        const id = target.id;
        if (id === 'ctb-regex') ui.regex = target.checked;
        else if (id === 'ctb-export-clean') ui.exportClean = target.checked;
        else if (id === 'ctb-export-user') ui.exportIncludeUser = target.checked;
        else if (id === 'ctb-export-name') ui.exportShowName = target.checked;
        else if (id === 'ctb-export-floor') ui.exportShowFloor = target.checked;
        else if (target.dataset.exportTag !== undefined) {
            setExportTagSelected(target.dataset.exportTag, target.checked);
            return;
        }
        else if (target.dataset.worldEntryUid !== undefined) {
            setRewriteWorldEntrySelected(target.dataset.worldName, target.dataset.worldEntryUid, target.checked);
            return;
        }
        else if (target.dataset.theaterWorldEntryUid !== undefined) {
            setTheaterWorldEntrySelected(target.dataset.theaterWorldName, target.dataset.theaterWorldEntryUid, target.checked);
            return;
        }
        else if (target.dataset.theaterNativeEntryId !== undefined) {
            setTheaterNativePresetEntrySelected(target.dataset.theaterNativeEntryId, target.checked);
            return;
        }
        else if (target.dataset.worldbookSelectUid !== undefined) {
            const uid = String(target.dataset.worldbookSelectUid);
            if (target.checked) worldbookSelected.add(uid);
            else worldbookSelected.delete(uid);
            syncWorldbookSelectionUI();
            return;
        }
        else if (target.dataset.presetEntryId !== undefined) {
            const idValue = String(target.dataset.presetEntryId);
            if (target.checked) presetTransferSelected.add(idValue);
            else presetTransferSelected.delete(idValue);
            // Do not rebuild the panel here: rebuilding loses the list's
            // scroll position and made selecting an entry jump to the top.
            updatePresetTransferSelectionUi();
            return;
        }
        else if (id === 'ctb-rewrite-world-book') {
            await chooseRewriteWorldBook(target.value);
            return;
        }
        else if (id === 'ctb-theater-world-book') {
            await chooseTheaterWorldBook(target.value);
            return;
        }
        else if (id === 'ctb-theater-native-preset') {
            await chooseTheaterNativePreset(target.value);
            return;
        }
        else if (id === 'ctb-worldbook-copy-target') {
            worldbookCopyTarget = String(target.value || '');
            syncWorldbookSelectionUI();
            return;
        }
        else if (id === 'ctb-worldbook-book') {
            await chooseWorldbook(target.value);
            return;
        }
        else if (id === 'ctb-worldbook-position' && worldbookDraft) {
            worldbookDraft.position = Number(target.value) || 0;
            markWorldbookDraftDirtyV2();
            renderPanel();
            return;
        }
        else if (id === 'ctb-worldbook-selective-logic' && worldbookDraft) {
            worldbookDraft.selectiveLogic = [0, 1, 2, 3].includes(Number(target.value)) ? Number(target.value) : 0;
            markWorldbookDraftDirtyV2();
            return;
        }
        else if (id === 'ctb-worldbook-exclude-recursion' && worldbookDraft) {
            worldbookDraft.excludeRecursion = target.checked;
            worldbookDraft.extensions = { ...(worldbookDraft.extensions && typeof worldbookDraft.extensions === 'object' ? worldbookDraft.extensions : {}) };
            worldbookDraft.extensions.exclude_recursion = target.checked;
            markWorldbookDraftDirtyV2();
            return;
        }
        else if (id === 'ctb-worldbook-prevent-recursion' && worldbookDraft) {
            worldbookDraft.preventRecursion = target.checked;
            worldbookDraft.extensions = { ...(worldbookDraft.extensions && typeof worldbookDraft.extensions === 'object' ? worldbookDraft.extensions : {}) };
            worldbookDraft.extensions.prevent_recursion = target.checked;
            markWorldbookDraftDirtyV2();
            return;
        }
        else if (id === 'ctb-preset-transfer-source') {
            await choosePresetTransferSide('source', target.value);
            return;
        }
        else if (id === 'ctb-preset-transfer-target') {
            await choosePresetTransferSide('target', target.value);
            return;
        }
        else if (id === 'ctb-preset-transfer-anchor') {
            presetTransferAnchor.anchorId = String(target.value || '');
            renderPanel();
            return;
        }
        else if (id === 'ctb-preset-transfer-load-source' || id === 'ctb-preset-transfer-load-target') {
            presetTransferLoadModeValue = target.value === 'enabled' ? 'enabled' : 'all';
            presetTransferSelected = new Set();
            presetTransferAnchor = { kind: 'top', anchorId: '' };
            presetTransferDraft = null;
            presetTransferVisibleLimit = 120;
            renderPanel();
            return;
        }
        else if (id === 'ctb-preset-draft-role' && presetTransferDraft) {
            presetTransferDraft.raw.role = target.value;
            return;
        }
        else if (id === 'ctb-preset-draft-enabled' && presetTransferDraft) {
            presetTransferDraft.enabled = target.checked;
            return;
        }
        else if (id === 'ctb-postEdit-channel') {
            settings.postEdit.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-rewrite-channel') {
            settings.rewrite.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-theater-channel') {
            settings.theater.channelId = target.value;
            channelEditor = null;
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-post-edit-preset') {
            settings.postEdit.selectedPresetId = target.value;
            const preset = settings.postEdit.presets.find((item) => item.id === target.value);
            if (preset) {
                settings.postEdit.presetName = preset.name;
                settings.postEdit.rules = preset.rules;
            } else {
                settings.postEdit.presetName = '';
            }
            saveSettings();
            renderPanel();
        } else if (id === 'ctb-rewrite-character') {
            settings.rewrite.includeCharacter = target.checked;
        } else if (id === 'ctb-rewrite-persona') {
            settings.rewrite.includePersona = target.checked;
        } else if (id === 'ctb-theater-character') {
            settings.theater.includeCharacter = target.checked;
        } else if (id === 'ctb-theater-persona') {
            settings.theater.includePersona = target.checked;
        } else if (id === 'ctb-theater-world-preset') {
            await selectTheaterWorldPreset(target.value);
        } else if (id === 'ctb-theater-preset') {
            settings.theater.selectedPresetId = target.value;
            const preset = settings.theater.presets.find((item) => item.id === target.value);
            if (preset) {
                settings.theater.presetName = preset.name || '';
                settings.theater.prompt = preset.prompt || '';
                settings.theater.contextFloors = preset.contextFloors ?? 6;
                settings.theater.contextTags = preset.contextTags || '';
                settings.theater.includeCharacter = preset.includeCharacter !== false;
                settings.theater.includePersona = preset.includePersona !== false;
                settings.theater.nativePresetName = preset.nativePresetName || '';
                settings.theater.nativePresetEntryIds = Array.isArray(preset.nativePresetEntryIds) ? preset.nativePresetEntryIds.map(String) : [];
                settings.theater.worldEntries = normalizeWorldEntrySelections(preset.worldEntries);
                settings.theater.selectedWorldPresetId = '';
                settings.theater.worldPresetName = '';
                settings.theater.channelId = preset.channelId || 'main';
                theaterNativePresetName = settings.theater.nativePresetName;
            } else {
                settings.theater.presetName = '';
                settings.theater.nativePresetName = '';
                settings.theater.nativePresetEntryIds = [];
                theaterNativePresetName = '';
            }
            saveSettings();
            if (settings.theater.nativePresetName) await loadTheaterNativePresets({ name: settings.theater.nativePresetName });
            else renderPanel();
        } else if (target.dataset.channelId && id.endsWith('-channel-model')) {
            const channel = channelEditor?.draft?.id === target.dataset.channelId ? channelEditor.draft : null;
            if (channel) channel.model = target.value;
        } else if (target.dataset.action === 'rewrite-selected') {
            const paragraph = rewriteDraft?.paragraphs?.[Number(target.dataset.paragraphIndex)];
            if (paragraph) paragraph.selected = target.checked;
        }
    }

    async function handleAction(action, data) {
        switch (action) {
            case 'close': return closePanel();
            case 'toggle-ui-theme':
                settings.uiTheme = settings.uiTheme === 'green' ? 'blue' : 'green';
                return renderPanel();
            case 'close-notice': transientNotice = null; return renderPanel();
            case 'confirm-dialog': {
                const confirm = pendingConfirm;
                pendingConfirm = null;
                renderPanel();
                if (confirm?.action === 'replace-all') return replaceAllNow();
                if (confirm?.action === 'close-worldbook') return closePanel({ confirmed: true });
                if (confirm?.action === 'delete-worldbook-entries') return deleteSelectedWorldbookEntries({ confirmed: true });
                return undefined;
            }
            case 'discard-worldbook-close':
                if (pendingConfirm?.action !== 'close-worldbook') return undefined;
                pendingConfirm = null;
                return closePanel({ discarded: true });
            case 'cancel-dialog': pendingConfirm = null; return renderPanel();
            case 'show-info': infoMessage = infoMessage === data.infoKey ? null : data.infoKey; return renderPanel();
            case 'close-info': infoMessage = null; return renderPanel();
            case 'tab':
                rememberPanelScroll(activeTab);
                infoMessage = null;
                activeTab = data.tab;
                return renderPanel({ remember: false });
            case 'jump-floor': return jumpToFloor(ui.floor);
            case 'open-bookmark': ui.bookmarkEditing = true; ui.bookmarkName = ui.bookmarkName || (ui.floor !== '' ? `楼层 ${ui.floor}` : ''); return renderPanel();
            case 'cancel-bookmark': ui.bookmarkEditing = false; return renderPanel();
            case 'save-bookmark': return saveBookmark();
            case 'jump-bookmark': return jumpToFloor(data.floor);
            case 'remove-bookmark': return removeBookmark(Number(data.bookmarkIndex));
            case 'set-scope': ui.scope = data.scope; results = []; currentResultIndex = -1; return renderPanel();
            case 'remove-extra-blank-lines': return stageBlankLineCleanup();
            case 'find': return executeSearch();
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
            case 'close-post-edit-preview': postEditPromptPreview = null; return renderPanel();
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
            case 'clear-post-edit': postEditDraft = null; postEditEditing = false; postEditReview = []; postEditPromptPreview = null; postEditReviewEditingIndex = -1; return renderPanel();
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
            case 'close-rewrite-preview': rewritePromptPreview = null; return renderPanel();
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
            case 'save-theater-world-preset': return saveTheaterWorldPreset();
            case 'delete-theater-world-preset': return deleteTheaterWorldPreset();
            case 'refresh-theater-native-presets': return loadTheaterNativePresets({ force: true });
            case 'select-theater-native-preset-all': return setTheaterNativePresetSelection(true);
            case 'clear-theater-native-preset': return setTheaterNativePresetSelection(false);
            case 'save-theater-preset': return saveTheaterPreset();
            case 'delete-theater-preset': return deleteTheaterPreset();
            case 'run-theater': return runTheater();
            case 'preview-theater-prompt': return previewTheaterPrompt();
            case 'close-theater-preview': theaterPromptPreview = null; return renderPanel();
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
        });
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
