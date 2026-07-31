// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      0.8.0
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改、逐段改写、小剧场、世界书管理与预设条目转移
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.8.0';
    const PREFIX = 'ctb-v080';
    const STYLE_ID = `${PREFIX}-style`;
    const ROOT_ID = `${PREFIX}-root`;
    const FLOAT_ID = `${PREFIX}-float`;
    const ENTRY_ID = `${PREFIX}-menu-entry`;
    const SETTINGS_ID = `${PREFIX}-extension-settings`;
    const INSTANCE_KEY = '__ChatToolbox_v080__';
    const LEGACY_INSTANCE_KEY = '__ChatToolbox_v020__';
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

    // 让从旧版查找替换脚本直接升级的用户不会同时留下旧的悬浮图标。
    try { host.__ChatSearchReplace_v010__?.(); } catch (_) {}
    try { host[LEGACY_INSTANCE_KEY]?.(); } catch (_) {}
    try { host[INSTANCE_KEY]?.(); } catch (_) {}

    let root = null;
    let menuObserver = null;
    let destroyed = false;
    let activeTab = 'search';
    let results = [];
    let currentResultIndex = -1;
    let infoMessage = null;
    // Keep plugin notifications inside the toolbox so API/save errors do not
    // leak into SillyTavern's page-level toastr layer while the panel is open.
    let notice = null;
    let noticeTimer = null;
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
    let theaterHistory = [];
    let theaterWorldPickerOpen = false;
    let theaterWorldLoading = false;
    let theaterWorldError = '';
    let theaterWorldBooks = [];
    let theaterWorldBook = '';
    const theaterWorldEntryCache = new Map();
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
    let worldbookDirty = false;
    let worldbookTransferTarget = '';
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
    let initAttempts = 0;
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
        'theater-scope': '小剧场只在插件里独立生成和保存最近结果，不会插入聊天楼层，也不会改动原聊天。',
        'worldbook-save': '世界书编辑采用先在界面修改、再一次保存的方式。移动条目时会先保存目标世界书，确认成功后才从来源删除。',
        'preset-transfer': '这里只处理预设中的提示词条目：复制会保留来源，移动会在目标保存成功后删除来源；不会修改其他预设参数。',
    });

    function defaults() {
        return {
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
                history: [],
            },
            worldbook: {
                currentBook: '',
            },
            presetTransfer: {
                apiId: 'openai',
                source: '',
                target: '',
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

    function loadSettings() {
        try {
            const contextStored = getContext()?.extensionSettings?.[STORAGE_KEY];
            const localStored = contextStored && typeof contextStored === 'object'
                ? {}
                : JSON.parse(host.localStorage?.getItem(STORAGE_KEY) || '{}');
            const stored = contextStored && typeof contextStored === 'object' ? contextStored : localStored;
            const base = defaults();
            const next = {
                modules: {
                    ...base.modules,
                    ...(stored.modules && typeof stored.modules === 'object' ? stored.modules : {}),
                },
                bookmarks: stored.bookmarks && typeof stored.bookmarks === 'object' ? stored.bookmarks : {},
                ai: {
                    ...base.ai,
                    ...(stored.ai && typeof stored.ai === 'object' ? stored.ai : {}),
                    channels: Array.isArray(stored.ai?.channels) ? stored.ai.channels : [],
                },
                postEdit: {
                    ...base.postEdit,
                    ...(stored.postEdit && typeof stored.postEdit === 'object' ? stored.postEdit : {}),
                    presets: Array.isArray(stored.postEdit?.presets) ? stored.postEdit.presets : [],
                },
                rewrite: {
                    ...base.rewrite,
                    ...(stored.rewrite && typeof stored.rewrite === 'object' ? stored.rewrite : {}),
                    worldEntries: Array.isArray(stored.rewrite?.worldEntries)
                        ? stored.rewrite.worldEntries
                            .filter((item) => item && item.world !== undefined && item.uid !== undefined)
                            .map((item) => ({ world: String(item.world), uid: String(item.uid) }))
                        : [],
                },
                theater: {
                    ...base.theater,
                    ...(stored.theater && typeof stored.theater === 'object' ? stored.theater : {}),
                    presets: Array.isArray(stored.theater?.presets) ? stored.theater.presets : [],
                    history: Array.isArray(stored.theater?.history) ? stored.theater.history.slice(0, 20) : [],
                    worldEntries: Array.isArray(stored.theater?.worldEntries)
                        ? stored.theater.worldEntries
                            .filter((item) => item && item.world !== undefined && item.uid !== undefined)
                            .map((item) => ({ world: String(item.world), uid: String(item.uid) }))
                        : [],
                },
                worldbook: {
                    ...base.worldbook,
                    ...(stored.worldbook && typeof stored.worldbook === 'object' ? stored.worldbook : {}),
                },
                presetTransfer: {
                    ...base.presetTransfer,
                    ...(stored.presetTransfer && typeof stored.presetTransfer === 'object' ? stored.presetTransfer : {}),
                },
            };
            if (stored.rewrite?.contextFloors === undefined && stored.rewrite?.contextRounds !== undefined) {
                next.rewrite.contextFloors = Math.max(0, Number(stored.rewrite.contextRounds) || 0) * 2;
            }
            delete next.rewrite.includeWorldInfo;
            delete next.rewrite.worldBefore;
            delete next.rewrite.worldAfter;
            delete next.rewrite.worldDepth;
            if (!next.ai.channels.length && stored.postEdit?.endpoint) {
                const legacyId = `legacy-${Date.now().toString(36)}`;
                next.ai.channels.push({
                    id: legacyId,
                    name: '原 API 设置',
                    url: String(stored.postEdit.endpoint || ''),
                    key: String(stored.postEdit.apiKey || ''),
                    model: String(stored.postEdit.model || ''),
                    models: [],
                    temperature: Number(stored.postEdit.temperature) || 0.2,
                    maxTokens: 65535,
                    timeoutSec: 120,
                });
                next.postEdit.channelId = legacyId;
            }
            return next;
        } catch (_) {
            return defaults();
        }
    }

    function saveSettings() {
        let savedToExtension = false;
        try {
            const context = getContext();
            if (context.extensionSettings && typeof context.extensionSettings === 'object') {
                context.extensionSettings[STORAGE_KEY] = JSON.parse(JSON.stringify(settings));
                context.saveSettingsDebounced?.();
                savedToExtension = true;
            }
        } catch (_) {}
        if (!savedToExtension) {
            try { host.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
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
        return `<div class="ctb-notice-overlay" role="dialog" aria-modal="true"><div class="ctb-notice-card is-warning"><div class="ctb-notice-title">${escapeHTML(pendingConfirm.title || '请确认')}</div><div class="ctb-notice-message">${escapeHTML(pendingConfirm.message)}</div><div class="ctb-inline ctb-confirm-actions"><button type="button" class="ctb-button ctb-primary" data-action="confirm-dialog">确认</button><button type="button" class="ctb-button" data-action="cancel-dialog">取消</button></div></div></div>`;
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

    async function verifySavedEntries(entries) {
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
            const timeout = controller ? host.setTimeout(() => controller.abort(), 6000) : null;
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
                const expected = entry.field === 'mes' ? normalizeBlankLines(entry.after) : String(entry.after);
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
            searchSaveState.phase = '正在从聊天文件回读并核验（最多 6 秒）…';
            updateSearchSaveStatus();
            const verified = await verifySavedEntries(entries);
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
        saveSettings();
        ui.bookmarkEditing = false;
        renderPanel();
    }

    function removeBookmark(index) {
        const list = currentBookmarks();
        list.splice(index, 1);
        settings.bookmarks[chatKey()] = list;
        saveSettings();
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
            postEditPromptPreview = '';
            settings.postEdit.floor = String(selected.id);
            saveSettings();
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

    function preparePostEditLatest(options = {}) {
        settings.postEdit.floor = '';
        return preparePostEditFloor(options);
    }

    function postEditEndpoint(value) {
        let endpoint = String(value || '').trim().replace(/\/+$/, '');
        if (!endpoint) throw new Error('请填写 API 地址');
        if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
        if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
        return `${endpoint}/v1/chat/completions`;
    }

    function requestJson(url, apiKey, body) {
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                    },
                    data: JSON.stringify(body),
                    timeout: 120000,
                    onload(response) {
                        let json;
                        try { json = JSON.parse(response.responseText || '{}'); }
                        catch (_) { return reject(new Error(`API 返回的不是 JSON（HTTP ${response.status}）`)); }
                        if (response.status < 200 || response.status >= 300) {
                            return reject(new Error(json?.error?.message || `API 请求失败（HTTP ${response.status}）`));
                        }
                        resolve(json);
                    },
                    ontimeout() { reject(new Error('API 请求超时')); },
                    onerror() { reject(new Error('API 请求失败，请检查地址、网络或跨域设置')); },
                });
            });
        }
        return (host.fetch || fetch)(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
        }).then(async (response) => {
            const json = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(json?.error?.message || `API 请求失败（HTTP ${response.status}）`);
            return json;
        });
    }

    function apiOutputText(json) {
        const standard = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? json?.output_text;
        if (typeof standard === 'string') return standard;
        const blocks = json?.output?.flatMap?.((item) => item?.content || []) || [];
        const text = blocks.map((item) => item?.text || item?.content || '').filter(Boolean).join('\n');
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
            maxTokens: 65535,
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

    async function stProxyJson(path, body) {
        const response = await (host.fetch || fetch)(path, {
            method: 'POST',
            headers: stRequestHeaders(),
            body: JSON.stringify(body),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(json?.error?.message || json?.message || `酒馆代理请求失败（HTTP ${response.status}）`);
        return json;
    }

    async function callAiText(feature, messages) {
        const channel = selectedChannel(feature);
        if (!channel) {
            const context = getContext();
            if (typeof context.generateRaw !== 'function') throw new Error('当前酒馆版本没有公开“跟随主接口”的生成方法，请添加自定义渠道');
            const output = await context.generateRaw({ prompt: messages, responseLength: 65535 });
            if (typeof output === 'string') return output;
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
            max_tokens: Math.max(256, Number(channel.maxTokens) || 65535),
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

    function parsePostEditResult(value, originalContent) {
        const originalParagraphs = postEditParagraphs(originalContent);
        let text = String(value ?? '').trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        let parsed = null;
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) {}
        }
        const rawItems = Array.isArray(parsed?.paragraphs)
            ? parsed.paragraphs
            : Array.isArray(parsed?.changes) ? parsed.changes : null;
        if (!rawItems) {
            const revised = cleanPostEditOutput(value, '');
            return {
                fullRevised: revised,
                reviews: postEditParagraphs(revised).map((replacement, index) => ({
                    paragraph: index + 1,
                    original: originalParagraphs[index] || '',
                    reason: '模型未返回逐段原因；请人工核对。',
                    replacement,
                    decision: 'pending',
                })).filter((item) => item.original !== item.replacement),
            };
        }
        const reviews = rawItems.map((item, index) => {
            const paragraph = Number(item?.paragraph ?? item?.index ?? index + 1);
            const original = String(item?.original ?? originalParagraphs[paragraph - 1] ?? '');
            const replacement = String(item?.revised ?? item?.replacement ?? item?.after ?? '');
            return {
                paragraph,
                original,
                reason: String(item?.reason ?? item?.why ?? '未提供修改原因'),
                replacement,
                decision: 'pending',
            };
        }).filter((item) => item.original && item.replacement !== item.original);
        const fullText = parsed?.full_text ?? parsed?.fullText ?? parsed?.revised_text ?? parsed?.revisedText;
        let fullRevised = typeof fullText === 'string' && fullText.trim()
            ? cleanPostEditOutput(fullText, '')
            : originalParagraphs.map((paragraph, index) => {
                const review = reviews.find((item) => item.paragraph === index + 1);
                return review ? review.replacement : paragraph;
            }).join('\n\n');
        fullRevised = normalizeBlankLines(fullRevised);
        return { fullRevised, reviews };
    }

    function buildPostEditRequest() {
        const config = settings.postEdit;
        return [
            { role: 'system', content: String(typeof config.systemPrompt === 'string' ? config.systemPrompt : defaultPostEditSystemPrompt()).trim() },
            {
                role: 'user',
                content: `【修改规则】\n${String(config.rules || '').trim()}\n\n【正文】\n${postEditDraft?.originalContent || ''}\n\n【返回格式】\n{"paragraphs":[{"paragraph":1,"original":"原段落","reason":"修改或不修改的原因","revised":"修改后的完整段落"}],"full_text":"完整修改后的正文"}`,
            },
        ];
    }

    function formatPromptPreview(messages) {
        return messages.map((message, index) => `===== ${index + 1}. ${message.role === 'system' ? 'SYSTEM' : 'USER'} =====\n${message.content}`).join('\n\n');
    }

    async function previewPostEditPrompt() {
        if (postEditPreviewLoading) return;
        if (!postEditDraft && !preparePostEditFloor({ silent: true })) return notify('请先读取要修改的 AI 楼层', 'warning');
        postEditPreviewLoading = true;
        renderPanel();
        try {
            postEditPromptPreview = formatPromptPreview(buildPostEditRequest());
        } catch (error) {
            postEditPromptPreview = '';
            notify(`无法生成发送预览：${error.message}`, 'error');
        } finally {
            postEditPreviewLoading = false;
            renderPanel();
        }
    }

    function diffPostEditHtml(before, after) {
        const splitParagraphsForDiff = (value) => String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .split(/\n[ \t]*\n+/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean);
        const oldParagraphs = splitParagraphsForDiff(before);
        const newParagraphs = splitParagraphsForDiff(after);
        // 用段落级 LCS 对齐，避免模型增删一个空行后把后面整篇误判为修改。
        const rows = oldParagraphs.length + 1;
        const cols = newParagraphs.length + 1;
        const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));
        for (let oldIndex = oldParagraphs.length - 1; oldIndex >= 0; oldIndex -= 1) {
            for (let newIndex = newParagraphs.length - 1; newIndex >= 0; newIndex -= 1) {
                lcs[oldIndex][newIndex] = oldParagraphs[oldIndex] === newParagraphs[newIndex]
                    ? lcs[oldIndex + 1][newIndex + 1] + 1
                    : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
            }
        }
        const unchangedNewIndexes = new Set();
        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < oldParagraphs.length && newIndex < newParagraphs.length) {
            if (oldParagraphs[oldIndex] === newParagraphs[newIndex]) {
                unchangedNewIndexes.add(newIndex);
                oldIndex += 1;
                newIndex += 1;
            } else if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
                oldIndex += 1;
            } else {
                newIndex += 1;
            }
        }
        return newParagraphs.map((paragraph, index) => (
            unchangedNewIndexes.has(index)
                ? escapeHTML(paragraph)
                : `<mark class="ctb-diff-add ctb-diff-paragraph">${escapeHTML(paragraph)}</mark>`
        )).join('\n\n');
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
        postEditPromptPreview = '';
        renderPanel();
        try {
            const messages = buildPostEditRequest();
            postEditPromptPreview = formatPromptPreview(messages);
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
            const paragraphs = postEditParagraphs(match.content);
            const acceptedMap = new Map(accepted.map((item) => [item.paragraph, item.replacement]));
            const revisedContent = normalizeBlankLines(paragraphs.map((paragraph, index) => acceptedMap.get(index + 1) ?? paragraph).join('\n\n'));
            const after = normalizeBlankLines(before.slice(0, match.innerStart) + revisedContent + before.slice(match.innerEnd));
            if (after === before) return notify('采用后内容没有变化', 'info');
            setMessageText(message, after);
            const saved = await saveChat();
            if (!saved) {
                setMessageText(message, before);
                throw new Error('酒馆没有返回可用的保存结果');
            }
            const verified = await verifySavedEntries([{ rawIndex: postEditDraft.rawIndex, field: 'mes', after }]);
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
            postEditPromptPreview = '';
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
            rewritePromptPreview = '';
            settings.rewrite.floor = String(selected.id);
            saveSettings();
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
        return Object.entries(data?.entries || {})
            .map(([entryKey, value]) => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
                const uid = String(value.uid ?? entryKey);
                const keys = Array.isArray(value.key) ? value.key.map(String).filter(Boolean) : [];
                const comment = String(value.comment || value.name || keys.join('、') || `条目 ${uid}`);
                return {
                    world: String(world),
                    uid,
                    comment,
                    keys,
                    content: String(value.content ?? ''),
                    disabled: value.disable === true || value.enabled === false,
                    order: Number(value.order) || 0,
                };
            })
            .filter(Boolean)
            .sort((left, right) => right.order - left.order || left.comment.localeCompare(right.comment));
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
                const data = await stProxyJson('/api/settings/get', {});
                rewriteWorldBooks = [...new Set((Array.isArray(data?.world_names) ? data.world_names : []).map(String).filter(Boolean))]
                    .sort((left, right) => left.localeCompare(right));
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
        saveSettings();
        renderPanel();
    }

    function setCurrentWorldBookSelection(selected) {
        if (!rewriteWorldBook) return;
        const entries = rewriteWorldEntryCache.get(rewriteWorldBook) || [];
        const currentWorld = String(rewriteWorldBook);
        const otherWorlds = (settings.rewrite.worldEntries || []).filter((item) => item.world !== currentWorld);
        settings.rewrite.worldEntries = selected
            ? [...otherWorlds, ...entries.map((entry) => ({ world: entry.world, uid: entry.uid }))]
            : otherWorlds;
        saveSettings();
        renderPanel();
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

    function formatRewritePromptPreview(messages) {
        return messages.map((message, index) => `===== ${index + 1}. ${message.role === 'system' ? 'SYSTEM' : 'USER'} =====\n${message.content}`).join('\n\n');
    }

    async function previewRewritePrompt() {
        if (rewritePreviewLoading) return;
        if (!rewriteDraft && !prepareRewriteFloor({ silent: true })) return notify('请先读取要改写的 AI 楼层', 'warning');
        rewritePreviewLoading = true;
        renderPanel();
        try {
            const messages = await buildRewriteRequest(rewriteDraft);
            rewritePromptPreview = formatRewritePromptPreview(messages);
        } catch (error) {
            rewritePromptPreview = '';
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
            rewritePromptPreview = formatRewritePromptPreview(messages);
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
            const verified = await verifySavedEntries([{ rawIndex: rewriteDraft.rawIndex, field: 'mes', after }]);
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

    function closePanel() {
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
            <div class="ctb-export-actions"><button type="button" class="ctb-button ctb-export-txt" data-action="export-txt"><i class="fa-solid fa-file-lines"></i> 导出 TXT</button><span class="ctb-export-epub-combo"><button type="button" class="ctb-button ctb-export-epub" data-action="export-epub"><i class="fa-solid fa-book-open"></i> 导出 EPUB</button>${infoButton('export-epub', 'ctb-export-info ctb-info-on-button')}</span></div>`;
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
                    <label class="ctb-mini-field">最大输出 <input class="ctb-input" id="ctb-${feature}-channel-tokens" data-channel-id="${escapeHTML(editing.id)}" type="number" min="256" step="256" value="${escapeHTML(editing.maxTokens || 65535)}"></label>
                </div>
                <div class="ctb-channel-editor-actions"><button type="button" class="ctb-button ctb-primary" data-action="save-channel">保存渠道</button><button type="button" class="ctb-button" data-action="cancel-channel">取消</button>${editor.isNew ? '' : `<button type="button" class="ctb-button ctb-danger" data-action="delete-channel" data-channel-id="${escapeHTML(editing.id)}">删除渠道</button>`}</div>
            </div>` : '';
        const summary = current ? `<div class="ctb-channel-summary"><div><strong>${escapeHTML(current.name || '未命名渠道')}</strong><small>${escapeHTML([current.model || '未选择模型', (() => { try { return new URL(normalizeProxyUrl(current.url)).host; } catch (_) { return current.url || '未填写地址'; } })()].join(' · '))}</small></div><button type="button" class="ctb-button" data-action="edit-channel" data-feature="${feature}" data-channel-id="${escapeHTML(current.id)}"><i class="fa-solid fa-pen"></i> 编辑</button></div>` : '<div class="ctb-hint">使用酒馆当前生成渠道与主接口设置。</div>';
        return `
            <div class="ctb-inline ctb-channel-picker">
                <select class="ctb-input" id="ctb-${feature}-channel">${options}</select>
                <button type="button" class="ctb-button" data-action="add-channel" data-feature="${feature}"><i class="fa-solid fa-plus"></i> 新渠道</button>
            </div>
            ${editorForm || summary}`;
    }

    function renderPostEditTab() {
        const config = settings.postEdit || defaults().postEdit;
        const draft = postEditDraft;
        const revised = draft?.revisedContent || '';
        const acceptedCount = postEditReview.filter((item) => item.decision === 'accept').length;
        const presetOptions = [`<option value="">选择规则预设…</option>`].concat((config.presets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${config.selectedPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`)).join('');
        const reviewList = postEditReview.length ? `<section class="ctb-section">
            <div class="ctb-section-title">逐段审核 <span>${acceptedCount} / ${postEditReview.length} 段将采用</span></div>
            <div class="ctb-rewrite-reviews">
                ${postEditReview.map((review, index) => `<div class="ctb-rewrite-review${review.decision === 'accept' ? ' is-accepted' : review.decision === 'reject' ? ' is-rejected' : ''}">
                    <div class="ctb-rewrite-review-title"><span>P${review.paragraph}</span><span>${review.decision === 'accept' ? '将采用' : review.decision === 'reject' ? '不采用' : '等待决定'}</span></div>
                    <div class="ctb-rewrite-compare ctb-post-review-grid">
                        <div><small>原文</small><p>${escapeHTML(review.original)}</p></div>
                        <div><small>修改原因</small><p>${escapeHTML(review.reason || '未提供修改原因')}</p></div>
                        <div><small>修改后</small>${postEditReviewEditingIndex === index ? `<textarea class="ctb-input ctb-review-edit" id="ctb-post-edit-review-revised-${index}">${escapeHTML(review.replacement)}</textarea>` : `<p class="ctb-diff-review-text">${escapeHTML(review.replacement)}</p>`}</div>
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
                <div class="ctb-section-title">生成渠道</div>
                ${renderChannelSettings('postEdit')}
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">内置 system 提示词 <span>可修改并保存在插件缓存</span></div>
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
            ${postEditPromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览（与生成共用同一份消息）</span><button type="button" class="ctb-review-expand" data-action="close-post-edit-preview" title="关闭预览" aria-label="关闭预览">×</button></div><pre>${escapeHTML(postEditPromptPreview)}</pre></section>` : ''}
            ${draft ? `<section class="ctb-section ctb-post-preview">
                <div class="ctb-section-title">楼层 #${escapeHTML(draft.floor)} · 修改预览</div>
                <div class="ctb-post-column"><div class="ctb-post-label">原正文</div><pre class="ctb-post-text">${escapeHTML(draft.originalContent)}</pre></div>
                <div class="ctb-post-column"><div class="ctb-post-label ctb-post-label-actions"><span>完整修改后（备用总稿）</span>${revised ? `<button type="button" class="ctb-review-expand" data-action="toggle-post-edit-editor" title="${postEditEditing ? '完成编辑' : '编辑修改后正文'}" aria-label="${postEditEditing ? '完成编辑' : '编辑修改后正文'}"><i class="fa-solid ${postEditEditing ? 'fa-check' : 'fa-pen'}"></i></button>` : ''}</div>${postEditEditing ? `<textarea class="ctb-input ctb-post-text ctb-post-edit-textarea" id="ctb-post-edit-revised">${escapeHTML(revised)}</textarea>` : `<pre class="ctb-post-text">${revised ? diffPostEditHtml(draft.originalContent, revised) : '点击“调用 API 修改”后显示结果。'}</pre>`}</div>
             </section>` : '<div class="ctb-results ctb-results-empty">先选择楼层并读取正文，再调用 API 生成修改预览。</div>'}
            ${reviewList}`;
    }

    function renderRewriteWorldPicker() {
        const selections = settings.rewrite.worldEntries || [];
        const selectedKeys = selectedWorldEntryKeys();
        const entries = rewriteWorldEntryCache.get(rewriteWorldBook) || [];
        const summary = selections.length
            ? `<div class="ctb-world-selected-summary">${selections.map((item) => `<span title="${escapeHTML(worldEntryDisplayLabel(item))}">${escapeHTML(worldEntryDisplayLabel(item))}</span>`).join('')}</div>`
            : '<div class="ctb-hint">尚未选择条目；不会向模型发送任何世界书内容。</div>';
        const bookOptions = rewriteWorldBooks.map((name) => `<option value="${escapeHTML(name)}"${name === rewriteWorldBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const entryList = rewriteWorldLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : rewriteWorldError
                ? `<div class="ctb-world-empty ctb-world-error">${escapeHTML(rewriteWorldError)}</div>`
                : !rewriteWorldBooks.length
                    ? '<div class="ctb-world-empty">没有读取到世界书。</div>'
                    : entries.length
                        ? `<div class="ctb-world-entry-list">${entries.map((entry) => {
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
                <button type="button" class="ctb-button${selections.length ? ' ctb-primary-soft' : ''}" data-action="toggle-rewrite-world-picker"><i class="fa-solid fa-book-open"></i> 选择世界书具体条目 <span>${selections.length ? `已选 ${selections.length} 条` : '未选择'}</span></button>
                ${selections.length ? '<button type="button" class="ctb-button" data-action="clear-rewrite-world-selection">清空全部</button>' : ''}
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
                    <div class="ctb-rewrite-compare"><div><small>原文</small><p>${escapeHTML(review.original)}</p></div><div><small>改写</small><p>${review.replacement ? escapeHTML(review.replacement) : '<em>（删除本段）</em>'}</p></div></div>
                    <div class="ctb-inline"><button type="button" class="ctb-button ctb-primary" data-action="rewrite-decision" data-review-index="${index}" data-decision="accept">采用这段</button><button type="button" class="ctb-button" data-action="rewrite-decision" data-review-index="${index}" data-decision="reject">不采用</button></div>
                </div>`).join('')}
            </div>
            <div class="ctb-inline ctb-rewrite-final"><button type="button" class="ctb-button" data-action="rewrite-all" data-decision="accept">全部采用</button><button type="button" class="ctb-button" data-action="rewrite-all" data-decision="reject">全部不采用</button><button type="button" class="ctb-button ctb-primary" data-action="apply-rewrite"${acceptedCount && !rewriteApplyLoading ? '' : ' disabled'}>${rewriteApplyLoading ? '保存中…' : `采用 ${acceptedCount} 段并保存`}</button></div>
        </section>` : '';
        return `
            <section class="ctb-section">
                <div class="ctb-section-title">精确到段落的 AI 改写 ${infoButton('rewrite-scope')}</div>
                <div class="ctb-hint">先生成段落补丁，再逐段决定是否采用；审核阶段不会改动聊天。</div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">楼层与正文范围 ${infoButton('rewrite-floor-tag')}</div>
                <div class="ctb-inline"><input class="ctb-input" id="ctb-rewrite-floor" type="number" min="0" placeholder="楼层号（留空=最新 AI）" value="${escapeHTML(config.floor || '')}"><input class="ctb-input" id="ctb-rewrite-tag" placeholder="content" value="${escapeHTML(config.tag || 'content')}"><button type="button" class="ctb-button" data-action="prepare-rewrite">读取楼层</button></div>
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">生成渠道</div>
                ${renderChannelSettings('rewrite')}
            </section>
            <section class="ctb-section">
                <div class="ctb-section-title">内置 system 提示词 <span>可修改并保存在插件缓存</span></div>
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
            ${rewritePromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览（与生成共用同一份消息）</span><button type="button" class="ctb-review-expand" data-action="close-rewrite-preview" title="关闭预览" aria-label="关闭预览">×</button></div><pre>${escapeHTML(rewritePromptPreview)}</pre></section>` : ''}
            ${reviewList}`;
    }

    function theaterSelectionKey(world, uid) {
        return `${String(world)}\u0000${String(uid)}`;
    }

    function theaterSelectedWorldKeys() {
        return new Set((settings.theater?.worldEntries || []).map((item) => theaterSelectionKey(item.world, item.uid)));
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
                const data = await stProxyJson('/api/settings/get', {});
                theaterWorldBooks = [...new Set((Array.isArray(data?.world_names) ? data.world_names : []).map(String).filter(Boolean))]
                    .sort((left, right) => left.localeCompare(right));
            }
            theaterWorldBook = theaterWorldBook || theaterWorldBooks[0] || '';
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
        const key = theaterSelectionKey(world, uid);
        const existing = settings.theater.worldEntries || [];
        settings.theater.worldEntries = selected
            ? (existing.some((item) => theaterSelectionKey(item.world, item.uid) === key)
                ? existing
                : [...existing, { world: String(world), uid: String(uid) }])
            : existing.filter((item) => theaterSelectionKey(item.world, item.uid) !== key);
        saveSettings();
        renderPanel();
    }

    function setTheaterWorldBookSelection(selected) {
        if (!theaterWorldBook) return;
        const entries = theaterWorldEntryCache.get(theaterWorldBook) || [];
        const current = String(theaterWorldBook);
        const other = (settings.theater.worldEntries || []).filter((item) => item.world !== current);
        settings.theater.worldEntries = selected
            ? [...other, ...entries.map((entry) => ({ world: entry.world, uid: entry.uid }))]
            : other;
        saveSettings();
        renderPanel();
    }

    async function collectTheaterWorldEntries() {
        const selections = settings.theater?.worldEntries || [];
        if (!selections.length) return '';
        const books = [...new Set(selections.map((item) => item.world))];
        const loaded = new Map();
        for (const world of books) {
            try { loaded.set(world, await fetchTheaterWorldEntries(world)); } catch (_) {}
        }
        return selections.map((selection) => {
            const entry = (loaded.get(selection.world) || []).find((item) => item.uid === String(selection.uid));
            return entry?.content?.trim() ? `【${entry.world} · ${entry.comment}】\n${entry.content.trim()}` : '';
        }).filter(Boolean).join('\n\n');
    }

    function theaterWorldLabel(item) {
        const entries = theaterWorldEntryCache.get(item.world) || [];
        const entry = entries.find((candidate) => candidate.uid === String(item.uid));
        return `${item.world} · ${entry?.comment || `条目 ${item.uid}`}`;
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
        const history = getRows().slice(-limit).map((row) => {
            const text = extractTags(row.text, tags).trim();
            return text ? `${row.isUser ? '用户' : row.name}（#${row.id}）：${text}` : '';
        }).filter(Boolean).join('\n\n');
        const worldEntries = await collectTheaterWorldEntries();
        const contextParts = [
            ...theaterCharacterAndPersona(),
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
            worldEntries: (config.worldEntries || []).map((item) => ({ world: String(item.world), uid: String(item.uid) })),
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
            const item = { id: `theater-result-${Date.now().toString(36)}`, prompt: settings.theater.prompt, output: theaterResult, time: new Date().toLocaleString() };
            theaterHistory = [item, ...(theaterHistory || [])].slice(0, 20);
            settings.theater.history = theaterHistory;
            saveSettings();
            notify('小剧场生成完成；内容只保存在插件缓存中', 'success');
        } catch (error) {
            notify(`小剧场生成失败：${error.message}`, 'error');
        } finally {
            theaterLoading = false;
            renderPanel();
        }
    }

    function renderTheaterWorldPicker() {
        const selections = settings.theater.worldEntries || [];
        const selected = theaterSelectedWorldKeys();
        const entries = theaterWorldEntryCache.get(theaterWorldBook) || [];
        const books = theaterWorldBooks.map((name) => `<option value="${escapeHTML(name)}"${name === theaterWorldBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const list = theaterWorldLoading
            ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>'
            : theaterWorldError
                ? `<div class="ctb-world-empty ctb-world-error">${escapeHTML(theaterWorldError)}</div>`
                : entries.length
                    ? `<div class="ctb-world-entry-list">${entries.map((entry) => `<label class="ctb-world-entry${selected.has(theaterSelectionKey(entry.world, entry.uid)) ? ' is-selected' : ''}"><input type="checkbox" data-theater-world-entry-uid="${escapeHTML(entry.uid)}" data-theater-world-name="${escapeHTML(entry.world)}"${selected.has(theaterSelectionKey(entry.world, entry.uid)) ? ' checked' : ''}><span class="ctb-world-entry-main"><strong>${escapeHTML(entry.comment)}</strong><small>${escapeHTML(entry.content.trim().replace(/\s+/g, ' ').slice(0, 110) || '（空条目）')}</small></span><span class="ctb-world-entry-meta">UID ${escapeHTML(entry.uid)}</span></label>`).join('')}</div>`
                    : '<div class="ctb-world-empty">没有可选条目。</div>';
        return `<div class="ctb-world-picker-summary"><button type="button" class="ctb-button${selections.length ? ' ctb-primary-soft' : ''}" data-action="toggle-theater-world-picker"><i class="fa-solid fa-book-open"></i> 世界书条目 <span>${selections.length ? `已选 ${selections.length} 条` : '未选择'}</span></button>${selections.length ? '<button type="button" class="ctb-button" data-action="clear-theater-world-selection">清空</button>' : ''}</div>${selections.length ? `<div class="ctb-world-selected-summary">${selections.map((item) => `<span title="${escapeHTML(theaterWorldLabel(item))}">${escapeHTML(theaterWorldLabel(item))}</span>`).join('')}</div>` : ''}${theaterWorldPickerOpen ? `<div class="ctb-world-picker"><div class="ctb-inline ctb-world-book-row"><select class="ctb-input" id="ctb-theater-world-book">${books || '<option value="">没有世界书</option>'}</select><button type="button" class="ctb-icon-button" data-action="refresh-theater-world-books" title="刷新"><i class="fa-solid fa-rotate"></i></button><button type="button" class="ctb-button" data-action="close-theater-world-picker">完成</button></div>${theaterWorldBook ? `<div class="ctb-inline ctb-world-bulk"><span>${escapeHTML(theaterWorldBook)} · ${entries.length} 条</span><button type="button" class="ctb-button" data-action="select-theater-world-all">全选</button><button type="button" class="ctb-button" data-action="clear-theater-world-book">清空本书</button></div>` : ''}${list}</div>` : ''}`;
    }

    function renderTheaterTab() {
        const config = settings.theater;
        const presetOptions = ['<option value="">选择小剧场预设…</option>'].concat((config.presets || []).map((preset) => `<option value="${escapeHTML(preset.id)}"${config.selectedPresetId === preset.id ? ' selected' : ''}>${escapeHTML(preset.name)}</option>`)).join('');
        const history = (theaterHistory || []).map((item, index) => `<details class="ctb-theater-history"><summary>${escapeHTML(item.time || '')} · ${escapeHTML(item.prompt || '').slice(0, 70)}</summary><pre>${escapeHTML(item.output || '')}</pre><button type="button" class="ctb-button" data-action="use-theater-history" data-history-index="${index}">载入结果</button></details>`).join('');
        return `<section class="ctb-section"><div class="ctb-section-title">独立小剧场 ${infoButton('theater-scope')}</div><div class="ctb-hint">只在这里查看 IF 线、角色想法和幕后片段，不会写入聊天楼层。</div></section>
            <section class="ctb-section"><div class="ctb-section-title">生成渠道</div>${renderChannelSettings('theater')}</section>
            <section class="ctb-section"><div class="ctb-section-title">小剧场预设</div><div class="ctb-inline ctb-preset-row"><select class="ctb-input" id="ctb-theater-preset">${presetOptions}</select><input class="ctb-input" id="ctb-theater-preset-name" placeholder="预设名称" value="${escapeHTML(config.presetName || '')}"><button type="button" class="ctb-button" data-action="save-theater-preset">保存</button><button type="button" class="ctb-button ctb-danger" data-action="delete-theater-preset"${config.selectedPresetId ? '' : ' disabled'}>删除</button></div></section>
            <section class="ctb-section"><div class="ctb-section-title">剧情与设定</div><div class="ctb-inline ctb-context-row"><label class="ctb-mini-field">最近楼层 <input class="ctb-input" id="ctb-theater-context-floors" type="number" min="0" max="50" value="${escapeHTML(config.contextFloors ?? 6)}"></label><label class="ctb-check"><input id="ctb-theater-character" type="checkbox"${config.includeCharacter !== false ? ' checked' : ''}> 角色卡</label><label class="ctb-check"><input id="ctb-theater-persona" type="checkbox"${config.includePersona !== false ? ' checked' : ''}> 用户设定</label></div><input class="ctb-input ctb-context-tags" id="ctb-theater-context-tags" placeholder="上下文标签筛选（留空=整层）" value="${escapeHTML(config.contextTags || '')}">${renderTheaterWorldPicker()}</section>
            <section class="ctb-section"><div class="ctb-section-title">小剧场请求</div><textarea class="ctb-input ctb-textarea ctb-theater-prompt" id="ctb-theater-prompt" placeholder="例如：如果这一刻没有人打断，角色会怎么想？">${escapeHTML(config.prompt || '')}</textarea><div class="ctb-inline ctb-theater-actions"><button type="button" class="ctb-button ctb-primary" data-action="run-theater"${theaterLoading ? ' disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> ${theaterLoading ? '生成中…' : '生成小剧场'}</button><button type="button" class="ctb-button" data-action="preview-theater-prompt">预览发送内容</button></div></section>
            ${theaterResult ? `<section class="ctb-section"><div class="ctb-section-title">本次结果</div><pre class="ctb-theater-result">${escapeHTML(theaterResult)}</pre></section>` : ''}
            ${theaterHistory.length ? `<section class="ctb-section"><div class="ctb-section-title">最近结果 <span>最多保留 20 条</span></div>${history}</section>` : ''}${theaterPromptPreview ? `<section class="ctb-section ctb-prompt-preview"><div class="ctb-section-title"><span>实际发送预览</span><button type="button" class="ctb-review-expand" data-action="close-theater-preview">×</button></div><pre>${escapeHTML(theaterPromptPreview)}</pre></section>` : ''}`;
    }

    let theaterPromptPreview = '';

    async function previewTheaterPrompt() {
        try {
            theaterPromptPreview = formatPromptPreview(await buildTheaterMessages());
        } catch (error) {
            notify(error.message, 'warning');
        }
        renderPanel();
    }

    function loadTheaterHistory(index) {
        const item = theaterHistory[Number(index)];
        if (!item) return;
        settings.theater.prompt = item.prompt || '';
        theaterResult = item.output || '';
        renderPanel();
    }

    function deepClone(value) {
        try { return structuredClone(value); } catch (_) {
            return JSON.parse(JSON.stringify(value));
        }
    }

    async function getWorldBookNames() {
        const context = getContext();
        try { await context.updateWorldInfoList?.(); } catch (_) {}
        const direct = context.world_names || context.worldNames || host.world_names || host.worldNames;
        if (Array.isArray(direct) && direct.length) return [...new Set(direct.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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

    async function saveWorldInfoDocument(name, data, createNew = false) {
        const context = getContext();
        if (typeof context.saveWorldInfo !== 'function') throw new Error('当前酒馆版本没有公开世界书保存接口');
        await context.saveWorldInfo(name, deepClone(data), Boolean(createNew));
        try { await context.updateWorldInfoList?.(); } catch (_) {}
        const verify = await loadWorldInfoDocument(name);
        if (!verify || typeof verify.entries !== 'object') throw new Error('保存后无法回读世界书');
        return verify;
    }

    function worldbookRecords(data) {
        return Object.entries(data?.entries || {}).map(([key, raw]) => {
            const value = raw && typeof raw === 'object' ? deepClone(raw) : {};
            const uid = String(value.uid ?? key);
            if (value.uid === undefined) value.uid = uid;
            return { uid, sourceKey: String(key), raw: value };
        });
    }

    function serializeWorldbookRecords(records) {
        const entries = {};
        for (const record of records) {
            const raw = deepClone(record.raw || {});
            const uid = String(raw.uid ?? record.uid);
            raw.uid = raw.uid ?? uid;
            entries[uid] = raw;
        }
        return entries;
    }

    function worldbookRecordLabel(record) {
        const raw = record?.raw || {};
        const keys = Array.isArray(raw.key) ? raw.key.filter(Boolean).join('、') : '';
        return String(raw.comment || raw.name || keys || `条目 ${record?.uid || ''}`);
    }

    function worldbookRecordPreview(record) {
        return String(record?.raw?.content || '').replace(/\s+/g, ' ').trim().slice(0, 130);
    }

    async function loadWorldbookManager({ force = false, book = '' } = {}) {
        if (worldbookLoading) return;
        worldbookLoading = true;
        renderPanel();
        try {
            if (force || !worldbookBooks.length) worldbookBooks = await getWorldBookNames();
            const preferred = String(book || worldbookBook || settings.worldbook.currentBook || '');
            worldbookBook = worldbookBooks.includes(preferred) ? preferred : (worldbookBooks[0] || '');
            settings.worldbook.currentBook = worldbookBook;
            if (worldbookBook) {
                worldbookDocument = await loadWorldInfoDocument(worldbookBook);
                worldbookEntries = worldbookRecords(worldbookDocument);
            } else {
                worldbookDocument = null;
                worldbookEntries = [];
            }
            worldbookSelected = new Set();
            worldbookVisibleLimit = 120;
            worldbookEditingUid = '';
            worldbookDraft = null;
            worldbookDirty = false;
            worldbookTransferTarget = worldbookBooks.find((name) => name !== worldbookBook) || '';
            saveSettings();
        } catch (error) {
            notify(`读取世界书失败：${error.message}`, 'error');
        } finally {
            worldbookLoading = false;
            worldbookLoadedOnce = true;
            renderPanel();
        }
    }

    async function chooseWorldbook(name) {
        if (worldbookDirty && !host.confirm('当前世界书有尚未保存的修改。放弃修改并切换吗？')) {
            return renderPanel();
        }
        return loadWorldbookManager({ force: false, book: name });
    }

    function editWorldbookEntry(uid) {
        const record = worldbookEntries.find((item) => item.uid === String(uid));
        if (!record) return;
        worldbookEditingUid = record.uid;
        worldbookDraft = deepClone(record.raw);
        renderPanel();
    }

    function applyWorldbookDraft({ quiet = false } = {}) {
        if (!worldbookDraft || !worldbookEditingUid) return false;
        const record = worldbookEntries.find((item) => item.uid === worldbookEditingUid);
        if (!record) return false;
        record.raw = deepClone(worldbookDraft);
        record.raw.uid = record.raw.uid ?? record.uid;
        worldbookDirty = true;
        if (!quiet) {
            renderPanel();
            notify('条目修改已暂存；请点击“保存世界书”写入文件', 'success');
        }
        return true;
    }

    function createWorldbookEntry() {
        const uid = `ctb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const raw = {
            uid,
            comment: '新条目',
            key: [],
            keysecondary: [],
            content: '',
            constant: false,
            selective: true,
            order: 100,
            position: 0,
            disable: false,
            depth: 4,
        };
        worldbookEntries.unshift({ uid, sourceKey: uid, raw });
        worldbookEditingUid = uid;
        worldbookDraft = deepClone(raw);
        worldbookDirty = true;
        renderPanel();
    }

    async function saveCurrentWorldbook() {
        if (!worldbookBook || worldbookSaving) return;
        applyWorldbookDraft({ quiet: true });
        worldbookSaving = true;
        renderPanel();
        try {
            const next = { ...(worldbookDocument || {}), entries: serializeWorldbookRecords(worldbookEntries) };
            const verified = await saveWorldInfoDocument(worldbookBook, next, false);
            worldbookDocument = verified;
            worldbookEntries = worldbookRecords(verified);
            worldbookDirty = false;
            rewriteWorldEntryCache.delete(worldbookBook);
            theaterWorldEntryCache.delete(worldbookBook);
            notify(`世界书“${worldbookBook}”已保存，共 ${worldbookEntries.length} 条`, 'success');
        } catch (error) {
            notify(`保存世界书失败：${error.message}`, 'error');
        } finally {
            worldbookSaving = false;
            renderPanel();
        }
    }

    async function createWorldbookBook() {
        const name = String(host.prompt('新世界书名称：') || '').trim();
        if (!name) return;
        if (worldbookBooks.includes(name)) return notify('已经存在同名世界书', 'warning');
        try {
            await saveWorldInfoDocument(name, { entries: {} }, true);
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
            applyWorldbookDraft({ quiet: true });
            const next = { ...(worldbookDocument || {}), entries: serializeWorldbookRecords(worldbookEntries) };
            await saveWorldInfoDocument(name, next, true);
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
        if (!ids.length || !host.confirm(`确定删除选中的 ${ids.length} 个世界书条目并保存吗？`)) return;
        worldbookEntries = worldbookEntries.filter((record) => !worldbookSelected.has(record.uid));
        worldbookSelected = new Set();
        if (ids.includes(worldbookEditingUid)) {
            worldbookEditingUid = '';
            worldbookDraft = null;
        }
        worldbookDirty = true;
        await saveCurrentWorldbook();
    }

    function nextWorldbookUid(existing) {
        let uid;
        do { uid = `ctb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; } while (existing.has(uid));
        existing.add(uid);
        return uid;
    }

    async function transferWorldbookEntries(mode) {
        const selected = worldbookEntries.filter((record) => worldbookSelected.has(record.uid));
        const targetName = String(worldbookTransferTarget || '');
        if (!selected.length) return notify('请先勾选要转移的世界书条目', 'warning');
        if (!targetName || targetName === worldbookBook) return notify('请选择另一本目标世界书', 'warning');
        if (worldbookDirty) return notify('请先保存当前世界书，再执行跨书转移', 'warning');
        worldbookSaving = true;
        renderPanel();
        try {
            const targetDocument = await loadWorldInfoDocument(targetName);
            const targetRecords = worldbookRecords(targetDocument);
            const existing = new Set(targetRecords.map((record) => record.uid));
            for (const source of selected) {
                const raw = deepClone(source.raw);
                let uid = String(raw.uid ?? source.uid);
                if (existing.has(uid)) {
                    uid = nextWorldbookUid(existing);
                    raw.uid = uid;
                } else existing.add(uid);
                targetRecords.push({ uid, sourceKey: uid, raw });
            }
            const targetNext = { ...targetDocument, entries: serializeWorldbookRecords(targetRecords) };
            await saveWorldInfoDocument(targetName, targetNext, false);
            if (mode === 'move') {
                const sourceNextRecords = worldbookEntries.filter((record) => !worldbookSelected.has(record.uid));
                const sourceNext = { ...worldbookDocument, entries: serializeWorldbookRecords(sourceNextRecords) };
                const sourceVerified = await saveWorldInfoDocument(worldbookBook, sourceNext, false);
                worldbookDocument = sourceVerified;
                worldbookEntries = worldbookRecords(sourceVerified);
            }
            worldbookSelected = new Set();
            rewriteWorldEntryCache.delete(targetName);
            theaterWorldEntryCache.delete(targetName);
            notify(`已${mode === 'move' ? '移动' : '复制'} ${selected.length} 个条目到“${targetName}”`, 'success');
        } catch (error) {
            notify(`世界书条目${mode === 'move' ? '移动' : '复制'}失败：${error.message}`, 'error');
        } finally {
            worldbookSaving = false;
            renderPanel();
        }
    }

    function renderWorldbookTab() {
        if (!worldbookLoadedOnce && !worldbookLoading) host.setTimeout(() => loadWorldbookManager(), 0);
        const filtered = worldbookEntries.filter((record) => {
            const query = worldbookSearch.trim().toLowerCase();
            if (!query) return true;
            const raw = record.raw || {};
            return [worldbookRecordLabel(record), record.uid, ...(Array.isArray(raw.key) ? raw.key : []), raw.content || ''].join('\n').toLowerCase().includes(query);
        });
        const visible = filtered.slice(0, worldbookVisibleLimit);
        const books = worldbookBooks.map((name) => `<option value="${escapeHTML(name)}"${name === worldbookBook ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const targets = worldbookBooks.filter((name) => name !== worldbookBook).map((name) => `<option value="${escapeHTML(name)}"${name === worldbookTransferTarget ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const list = worldbookLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 正在读取世界书…</div>' : filtered.length
            ? `<div class="ctb-manager-list">${visible.map((record) => `<div class="ctb-manager-row${record.uid === worldbookEditingUid ? ' is-active' : ''}"><input type="checkbox" data-worldbook-select-uid="${escapeHTML(record.uid)}"${worldbookSelected.has(record.uid) ? ' checked' : ''}><button type="button" data-action="edit-worldbook-entry" data-worldbook-uid="${escapeHTML(record.uid)}"><strong>${escapeHTML(worldbookRecordLabel(record))}</strong><small>${escapeHTML(worldbookRecordPreview(record) || '（空条目）')}</small></button><span>优先级 ${escapeHTML(record.raw?.order ?? 0)}</span></div>`).join('')}${filtered.length > visible.length ? `<button type="button" class="ctb-list-more" data-action="more-worldbook-entries">再显示 ${Math.min(120, filtered.length - visible.length)} 条（共 ${filtered.length} 条）</button>` : ''}</div>`
            : '<div class="ctb-world-empty">没有符合条件的条目。</div>';
        const draft = worldbookDraft;
        const editor = draft ? `<div class="ctb-manager-editor"><div class="ctb-section-title">编辑条目 <span>UID ${escapeHTML(worldbookEditingUid)}</span></div><input class="ctb-input" id="ctb-worldbook-comment" placeholder="条目名称/备注" value="${escapeHTML(draft.comment || '')}"><input class="ctb-input" id="ctb-worldbook-keys" placeholder="关键词，用逗号分隔" value="${escapeHTML((Array.isArray(draft.key) ? draft.key : []).join(', '))}"><textarea class="ctb-input ctb-textarea ctb-manager-content" id="ctb-worldbook-content" placeholder="世界书内容">${escapeHTML(draft.content || '')}</textarea><div class="ctb-inline ctb-manager-fields"><label class="ctb-mini-field">优先级 <input class="ctb-input" id="ctb-worldbook-order" type="number" value="${escapeHTML(draft.order ?? 100)}"></label><label class="ctb-mini-field">深度 <input class="ctb-input" id="ctb-worldbook-depth" type="number" min="0" value="${escapeHTML(draft.depth ?? 4)}"></label><select class="ctb-input" id="ctb-worldbook-position">${[['0','角色定义前'],['1','角色定义后'],['2','示例前'],['3','示例后'],['4','深度']].map(([value,label]) => `<option value="${value}"${String(draft.position ?? 0) === value ? ' selected' : ''}>${label}</option>`).join('')}</select><label class="ctb-check"><input id="ctb-worldbook-constant" type="checkbox"${draft.constant ? ' checked' : ''}> 常驻</label><label class="ctb-check"><input id="ctb-worldbook-disabled" type="checkbox"${draft.disable ? ' checked' : ''}> 禁用</label></div><div class="ctb-inline ctb-manager-actions"><button type="button" class="ctb-button ctb-primary" data-action="apply-worldbook-entry">暂存条目</button></div></div>` : '<div class="ctb-world-empty">点击条目开始编辑。</div>';
        return `<section class="ctb-section"><div class="ctb-section-title">世界书管理 ${infoButton('worldbook-save')}</div><div class="ctb-inline ctb-manager-toolbar"><select class="ctb-input" id="ctb-worldbook-book">${books || '<option value="">没有世界书</option>'}</select><button type="button" class="ctb-button" data-action="refresh-worldbook">刷新</button><button type="button" class="ctb-button" data-action="create-worldbook">新建书</button><button type="button" class="ctb-button" data-action="rename-worldbook"${worldbookBook ? '' : ' disabled'}>重命名</button><button type="button" class="ctb-button ctb-danger" data-action="delete-worldbook"${worldbookBook ? '' : ' disabled'}>删除书</button></div></section>
            <section class="ctb-section"><div class="ctb-inline ctb-manager-toolbar"><input class="ctb-input" id="ctb-worldbook-search" placeholder="搜索条目名称、关键词或内容" value="${escapeHTML(worldbookSearch)}"><button type="button" class="ctb-button" data-action="filter-worldbook">筛选</button><button type="button" class="ctb-button" data-action="new-worldbook-entry"${worldbookBook ? '' : ' disabled'}>新条目</button><button type="button" class="ctb-button" data-action="sort-worldbook-priority">按优先级排序</button></div><div class="ctb-manager-grid"><div>${list}</div>${editor}</div></section>
            <section class="ctb-section"><div class="ctb-section-title">批量条目操作 <span>已选 ${worldbookSelected.size} 条</span></div><div class="ctb-inline ctb-manager-toolbar"><select class="ctb-input" id="ctb-worldbook-transfer-target">${targets || '<option value="">没有其他世界书</option>'}</select><button type="button" class="ctb-button" data-action="copy-worldbook-entries"${worldbookSelected.size ? '' : ' disabled'}>复制到目标</button><button type="button" class="ctb-button" data-action="move-worldbook-entries"${worldbookSelected.size ? '' : ' disabled'}>移动到目标</button><button type="button" class="ctb-button ctb-danger" data-action="delete-worldbook-entries"${worldbookSelected.size ? '' : ' disabled'}>批量删除</button></div></section>
            <div class="ctb-inline ctb-manager-savebar"><span>${worldbookDirty ? '有尚未保存的修改' : '当前世界书已同步'}</span><button type="button" class="ctb-button ctb-save" data-action="save-worldbook"${worldbookBook && !worldbookSaving ? '' : ' disabled'}>${worldbookSaving ? '保存中…' : '保存世界书'}</button></div>`;
    }

    function getPresetTransferManager() {
        const context = getContext();
        const getter = context.getPresetManager || host.SillyTavern?.getPresetManager || host.getPresetManager;
        if (typeof getter !== 'function') throw new Error('当前酒馆版本没有公开预设管理接口');
        const manager = getter.call(context, presetTransferApi || 'openai');
        if (!manager) throw new Error('没有找到 Chat Completion 预设管理器，请先切换到可用的聊天补全接口');
        return manager;
    }

    function presetTransferNames(manager) {
        if (typeof manager.getAllPresets === 'function') {
            const names = manager.getAllPresets();
            if (Array.isArray(names)) return [...new Set(names.map(String).filter(Boolean))];
        }
        const list = manager.getPresetList?.(presetTransferApi) || {};
        if (Array.isArray(list.preset_names)) return list.preset_names.map(String).filter(Boolean);
        return Object.keys(list.preset_names || {});
    }

    async function loadPresetTransferDocument(manager, name) {
        let data;
        if (typeof manager.getCompletionPresetByName === 'function') data = await manager.getCompletionPresetByName(name);
        if (!data && typeof manager.getPresetList === 'function') {
            const list = manager.getPresetList(presetTransferApi) || {};
            const names = list.preset_names || [];
            const index = Array.isArray(names) ? names.indexOf(name) : names[name];
            if (index !== undefined && index !== -1) data = list.presets?.[index];
        }
        if (!data) throw new Error(`无法读取预设“${name}”`);
        return deepClone(data);
    }

    function presetEntryArrayInfo(document) {
        if (Array.isArray(document?.prompts)) return { key: 'prompts', entries: document.prompts };
        if (Array.isArray(document?.entries)) return { key: 'entries', entries: document.entries };
        throw new Error('所选预设没有可转移的提示词条目');
    }

    function presetTransferRecords(document) {
        const { entries } = presetEntryArrayInfo(document);
        return entries.map((raw, index) => {
            const value = raw && typeof raw === 'object' ? deepClone(raw) : { content: String(raw ?? '') };
            const id = String(value.identifier ?? value.id ?? value.uid ?? `entry-${index}`);
            return {
                id,
                index,
                raw: value,
                name: String(value.name || value.comment || value.identifier || `条目 ${index + 1}`),
                content: String(value.content ?? value.system_prompt ?? value.prompt ?? ''),
                marker: Boolean(value.marker),
            };
        });
    }

    function uniquePresetIdentifier(raw, existing) {
        let id = String(raw.identifier ?? raw.id ?? raw.uid ?? `ctb-prompt-${Date.now().toString(36)}`);
        if (!existing.has(id)) {
            existing.add(id);
            return id;
        }
        const base = id.replace(/-\d+$/, '');
        let counter = 2;
        while (existing.has(`${base}-copy-${counter}`)) counter += 1;
        id = `${base}-copy-${counter}`;
        existing.add(id);
        return id;
    }

    function addPresetPromptOrder(document, identifier, enabled = true) {
        if (!Array.isArray(document?.prompt_order)) return;
        for (const orderGroup of document.prompt_order) {
            if (!Array.isArray(orderGroup?.order)) continue;
            if (!orderGroup.order.some((item) => String(item?.identifier) === String(identifier))) {
                orderGroup.order.push({ identifier, enabled: enabled !== false });
            }
        }
    }

    function removePresetPromptOrder(document, identifiers) {
        const set = new Set([...identifiers].map(String));
        if (!Array.isArray(document?.prompt_order)) return;
        for (const orderGroup of document.prompt_order) {
            if (Array.isArray(orderGroup?.order)) {
                orderGroup.order = orderGroup.order.filter((item) => !set.has(String(item?.identifier)));
            }
        }
    }

    async function savePresetTransferDocument(manager, name, document) {
        if (typeof manager.savePreset !== 'function') throw new Error('当前预设管理器不支持保存');
        const next = deepClone(document);
        await manager.savePreset(name, next, { skipUpdate: true });
        const list = manager.getPresetList?.(presetTransferApi) || {};
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
        if (presetTransferLoading) return;
        presetTransferLoading = true;
        presetTransferError = '';
        renderPanel();
        try {
            const manager = getPresetTransferManager();
            const names = presetTransferNames(manager);
            if (!names.length) throw new Error('没有读取到可用预设');
            const savedSource = force ? presetTransferSource : (presetTransferSource || settings.presetTransfer.source);
            presetTransferSource = names.includes(savedSource) ? savedSource : names[0];
            const targetCandidate = presetTransferTarget || settings.presetTransfer.target;
            presetTransferTarget = names.includes(targetCandidate) && targetCandidate !== presetTransferSource
                ? targetCandidate
                : (names.find((name) => name !== presetTransferSource) || '');
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
            presetTransferVisibleLimit = 120;
            settings.presetTransfer.apiId = presetTransferApi;
            settings.presetTransfer.source = presetTransferSource;
            settings.presetTransfer.target = presetTransferTarget;
            saveSettings();
        } catch (error) {
            presetTransferError = error.message || String(error);
        } finally {
            presetTransferLoading = false;
            presetTransferLoadedOnce = true;
            renderPanel();
        }
    }

    async function choosePresetTransferSide(side, name) {
        if (side === 'source') presetTransferSource = String(name || '');
        else presetTransferTarget = String(name || '');
        if (presetTransferSource && presetTransferSource === presetTransferTarget) {
            presetTransferError = '来源和目标不能是同一个预设';
            return renderPanel();
        }
        return loadPresetTransfer({ force: true });
    }

    async function transferPresetEntries(mode) {
        const selected = presetTransferSourceEntries.filter((entry) => presetTransferSelected.has(entry.id));
        if (!selected.length) return notify('请先勾选要处理的预设条目', 'warning');
        if (!presetTransferTarget || presetTransferTarget === presetTransferSource) return notify('请选择不同的目标预设', 'warning');
        presetTransferLoading = true;
        renderPanel();
        try {
            const manager = getPresetTransferManager();
            const sourceDocument = await loadPresetTransferDocument(manager, presetTransferSource);
            const targetDocument = await loadPresetTransferDocument(manager, presetTransferTarget);
            const sourceInfo = presetEntryArrayInfo(sourceDocument);
            const targetInfo = presetEntryArrayInfo(targetDocument);
            const selectedIds = new Set(selected.map((entry) => entry.id));
            const existing = new Set(presetTransferRecords(targetDocument).map((entry) => entry.id));
            for (const entry of selected) {
                const raw = deepClone(entry.raw);
                const originalId = String(raw.identifier ?? raw.id ?? raw.uid ?? entry.id);
                const nextId = uniquePresetIdentifier(raw, existing);
                if ('identifier' in raw || targetInfo.key === 'prompts') raw.identifier = nextId;
                else if ('id' in raw) raw.id = nextId;
                else raw.uid = nextId;
                targetInfo.entries.push(raw);
                addPresetPromptOrder(targetDocument, nextId, raw.enabled !== false);
                if (nextId !== originalId && raw.name) raw.name = `${raw.name}（副本）`;
            }
            targetDocument[targetInfo.key] = targetInfo.entries;
            await savePresetTransferDocument(manager, presetTransferTarget, targetDocument);
            if (mode === 'move') {
                sourceInfo.entries = sourceInfo.entries.filter((raw, index) => {
                    const id = String(raw?.identifier ?? raw?.id ?? raw?.uid ?? `entry-${index}`);
                    return !selectedIds.has(id);
                });
                sourceDocument[sourceInfo.key] = sourceInfo.entries;
                removePresetPromptOrder(sourceDocument, selectedIds);
                await savePresetTransferDocument(manager, presetTransferSource, sourceDocument);
            }
            notify(`已${mode === 'move' ? '移动' : '复制'} ${selected.length} 个预设条目`, 'success');
            await loadPresetTransfer({ force: true });
        } catch (error) {
            presetTransferError = error.message || String(error);
            notify(`预设条目${mode === 'move' ? '移动' : '复制'}失败：${error.message}`, 'error');
        } finally {
            presetTransferLoading = false;
            renderPanel();
        }
    }

    async function deletePresetEntries() {
        const selected = presetTransferSourceEntries.filter((entry) => presetTransferSelected.has(entry.id));
        if (!selected.length || !host.confirm(`确定从预设“${presetTransferSource}”删除选中的 ${selected.length} 个条目吗？`)) return;
        presetTransferLoading = true;
        renderPanel();
        try {
            const manager = getPresetTransferManager();
            const document = await loadPresetTransferDocument(manager, presetTransferSource);
            const info = presetEntryArrayInfo(document);
            const ids = new Set(selected.map((entry) => entry.id));
            info.entries = info.entries.filter((raw, index) => !ids.has(String(raw?.identifier ?? raw?.id ?? raw?.uid ?? `entry-${index}`)));
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

    function renderPresetTransferTab() {
        if (!presetTransferLoadedOnce && !presetTransferLoading) host.setTimeout(() => loadPresetTransfer(), 0);
        let names = [];
        try { names = presetTransferNames(getPresetTransferManager()); } catch (_) {}
        const sourceOptions = names.map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferSource ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const targetOptions = names.filter((name) => name !== presetTransferSource).map((name) => `<option value="${escapeHTML(name)}"${name === presetTransferTarget ? ' selected' : ''}>${escapeHTML(name)}</option>`).join('');
        const query = presetTransferSearch.trim().toLowerCase();
        const source = presetTransferSourceEntries.filter((entry) => !query || `${entry.name}\n${entry.content}\n${entry.id}`.toLowerCase().includes(query));
        const target = presetTransferTargetEntries.filter((entry) => !query || `${entry.name}\n${entry.content}\n${entry.id}`.toLowerCase().includes(query));
        const visibleSource = source.slice(0, presetTransferVisibleLimit);
        const visibleTarget = target.slice(0, presetTransferVisibleLimit);
        const sourceList = source.length ? visibleSource.map((entry) => `<label class="ctb-preset-entry${presetTransferSelected.has(entry.id) ? ' is-selected' : ''}"><input type="checkbox" data-preset-entry-id="${escapeHTML(entry.id)}"${presetTransferSelected.has(entry.id) ? ' checked' : ''}><span><strong>${escapeHTML(entry.name)}</strong><small>${escapeHTML(entry.content.replace(/\s+/g, ' ').slice(0, 110) || (entry.marker ? '（内置标记）' : '（空内容）'))}</small></span></label>`).join('') + (source.length > visibleSource.length ? `<button type="button" class="ctb-list-more" data-action="more-preset-transfer-entries">再显示 ${Math.min(120, source.length - visibleSource.length)} 条（共 ${source.length} 条）</button>` : '') : '<div class="ctb-world-empty">来源预设没有符合条件的条目。</div>';
        const targetList = target.length ? visibleTarget.map((entry) => `<div class="ctb-preset-entry is-target"><span><strong>${escapeHTML(entry.name)}</strong><small>${escapeHTML(entry.content.replace(/\s+/g, ' ').slice(0, 110) || (entry.marker ? '（内置标记）' : '（空内容）'))}</small></span></div>`).join('') + (target.length > visibleTarget.length ? `<button type="button" class="ctb-list-more" data-action="more-preset-transfer-entries">再显示 ${Math.min(120, target.length - visibleTarget.length)} 条（共 ${target.length} 条）</button>` : '') : '<div class="ctb-world-empty">目标预设没有符合条件的条目。</div>';
        return `<section class="ctb-section"><div class="ctb-section-title">预设条目转移 ${infoButton('preset-transfer')}</div><div class="ctb-hint">仅处理 Chat Completion 预设里的提示词条目；不会带入快照、正则、导入导出或其他功能。</div></section>
            <section class="ctb-section"><div class="ctb-inline ctb-manager-toolbar"><input class="ctb-input" id="ctb-preset-transfer-search" placeholder="搜索条目" value="${escapeHTML(presetTransferSearch)}"><button type="button" class="ctb-button" data-action="filter-preset-transfer">筛选</button><button type="button" class="ctb-button" data-action="refresh-preset-transfer">刷新预设</button></div>${presetTransferError ? `<div class="ctb-readonly-note ctb-world-error">${escapeHTML(presetTransferError)}</div>` : ''}</section>
            <section class="ctb-section ctb-preset-transfer-grid"><div><div class="ctb-section-title">来源预设 <span>${presetTransferSourceEntries.length} 条</span></div><select class="ctb-input" id="ctb-preset-transfer-source">${sourceOptions || '<option value="">没有预设</option>'}</select><div class="ctb-preset-entry-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : sourceList}</div></div><div><div class="ctb-section-title">目标预设 <span>${presetTransferTargetEntries.length} 条</span></div><select class="ctb-input" id="ctb-preset-transfer-target">${targetOptions || '<option value="">没有其他预设</option>'}</select><div class="ctb-preset-entry-list">${presetTransferLoading ? '<div class="ctb-world-empty"><span class="ctb-save-spinner"></span> 读取中…</div>' : targetList}</div></div></section>
            <section class="ctb-section"><div class="ctb-inline ctb-manager-toolbar"><span class="ctb-hint">已选 ${presetTransferSelected.size} 条</span><button type="button" class="ctb-button ctb-primary" data-action="copy-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>复制到目标</button><button type="button" class="ctb-button" data-action="move-preset-entries"${presetTransferSelected.size && presetTransferTarget && !presetTransferLoading ? '' : ' disabled'}>移动到目标</button><button type="button" class="ctb-button ctb-danger" data-action="delete-preset-entries"${presetTransferSelected.size && !presetTransferLoading ? '' : ' disabled'}>批量删除</button></div></section>`;
    }

    function renderPanel() {
        if (!root || root.hidden) return;
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
        root.innerHTML = `<div class="ctb-card" role="dialog" aria-modal="true" aria-label="聊天工具箱">
            <header class="ctb-header"><div class="ctb-title"><i class="fa-solid fa-toolbox"></i> 聊天工具箱</div><div class="ctb-header-side"><span>${total} 条消息</span><button type="button" class="ctb-close" data-action="close" aria-label="关闭">×</button></div></header>
            ${tabs ? `<nav class="ctb-tabs" style="--ctb-tab-count:${Math.min(modules.length, 5)}">${tabs}</nav>` : ''}
            <main class="ctb-body">${body}${renderInfoPopup()}</main>
            ${renderTransientNotice()}
            ${renderConfirmDialog()}
        </div>`;
    }

    function createUI() {
        doc.getElementById(STYLE_ID)?.remove();
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(FLOAT_ID)?.remove();
        doc.getElementById(ENTRY_ID)?.remove();
        doc.getElementById(SETTINGS_ID)?.remove();
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
            #${ROOT_ID} .ctb-card{width:min(650px,calc(100vw - 24px));max-height:min(720px,calc(100dvh - 24px));min-height:0;margin:auto;display:flex;flex-direction:column;overflow:hidden;background:var(--SmartThemeBlurTintColor,var(--SmartThemeBodyColor,#f5f5f7));background:#f6f6f8;border:1px solid rgba(92,99,110,.38);border-radius:5px;box-shadow:0 14px 40px rgba(0,0,0,.32);font-size:12px;line-height:1.35;}
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
            #${ROOT_ID} .ctb-results-empty{margin-top:11px;padding:14px 9px;color:#8b8e93;text-align:center;} #${ROOT_ID} .ctb-result-row{display:block;width:100%;border:0;border-bottom:1px solid #d5d7db;border-radius:0;background:transparent;padding:6px 11px;color:#46494e;text-align:left;cursor:pointer;font:12px var(--mainFontFamily,Arial,sans-serif);} #${ROOT_ID} .ctb-result-row:last-child{border-bottom:0;} #${ROOT_ID} .ctb-result-row:hover{background:#e3e7e4;} #${ROOT_ID} .ctb-result-row.is-active{background:#dfe8e2;} #${ROOT_ID} .ctb-result-meta{display:flex;justify-content:space-between;gap:8px;color:#777a80;font-size:11px;} #${ROOT_ID} .ctb-result-text{display:flex;align-items:baseline;min-width:0;overflow:hidden;margin-top:2px;white-space:nowrap;font-size:12px;} #${ROOT_ID} .ctb-result-before{max-width:34%;overflow:hidden;direction:rtl;text-align:right;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-result-text mark{flex:0 0 auto;} #${ROOT_ID} .ctb-result-after{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} mark,#${ROOT_ID} .ctb-pending-preview mark{padding:0;background:transparent;color:#c1504f;font-weight:700;}
            #${ROOT_ID} .ctb-option-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 10px;margin-top:8px;} #${ROOT_ID} .ctb-export-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px;} #${ROOT_ID} .ctb-export-actions .ctb-button{height:39px;color:#fff!important;font-size:13px;font-weight:700;} #${ROOT_ID} .ctb-export-txt{background:#7da287!important;} #${ROOT_ID} .ctb-export-epub{background:#5f94c4!important;}
            #${ROOT_ID} .ctb-toggle{display:inline-flex;align-items:center;gap:8px;color:#505359;font-weight:700;cursor:pointer;} #${ROOT_ID} .ctb-toggle input{position:absolute;opacity:0;pointer-events:none;} #${ROOT_ID} .ctb-toggle span{position:relative;width:34px;height:18px;border-radius:9px;background:#aeb2b6;} #${ROOT_ID} .ctb-toggle span:after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s;} #${ROOT_ID} .ctb-toggle input:checked+span{background:#7da287;} #${ROOT_ID} .ctb-toggle input:checked+span:after{left:19px;}
            #${ROOT_ID} .ctb-rule-list{display:grid;gap:5px;margin-bottom:7px;} #${ROOT_ID} .ctb-rule-row{display:grid;grid-template-columns:42px minmax(110px,1fr) minmax(100px,1fr) 31px;gap:5px;align-items:center;} #${ROOT_ID} .ctb-rule-switch{display:flex;flex-direction:column;align-items:center;gap:2px;color:#74777c;font-size:10px;} #${ROOT_ID} .ctb-rule-row .ctb-input{font-size:11px;}
            #${ROOT_ID} .ctb-pending-review{margin-bottom:6px;border:1px solid #d0c7c3;border-radius:4px;background:#ebe8e7;overflow:hidden;} #${ROOT_ID} .ctb-pending-title{display:flex;justify-content:space-between;gap:8px;padding:5px 7px;border-bottom:1px solid #d5cfcc;color:#685755;font-size:11px;font-weight:700;} #${ROOT_ID} .ctb-pending-title span+span{color:#85807d;font-weight:400;} #${ROOT_ID} .ctb-pending-preview{padding:6px 7px;color:#55585c;font-size:11px;word-break:break-word;} #${ROOT_ID} .ctb-pending-actions{display:flex;flex-wrap:wrap;gap:5px;padding:0 7px 7px;}
            #${ROOT_ID} .ctb-info{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin:0;padding:0;border:1px solid #9aa0a7;border-radius:50%;background:transparent;color:#7f858c;font-size:11px;line-height:1;cursor:pointer;} #${ROOT_ID} .ctb-info:hover{border-color:#5f826a;color:#51735d;background:#e4ece6;} #${ROOT_ID} .ctb-info-line{display:flex;align-items:center;min-height:5px;margin-top:5px;} #${ROOT_ID} .ctb-info-popup{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-top:10px;padding:7px 8px;border:1px solid #bfc7c2;border-left:3px solid #7da287;border-radius:4px;background:#e7ece8;color:#5e6660;font-size:11px;line-height:1.4;} #${ROOT_ID} .ctb-info-popup button{border:0;background:transparent;color:#747a76;font-size:16px;line-height:12px;padding:0;cursor:pointer;}
            #${ROOT_ID} .ctb-float-setting{padding-top:10px;border-top:1px solid #d7d9dd;}
            .ctb-jump-highlight{outline:2px solid #7da287!important;outline-offset:2px;transition:outline-color .35s;}
            #${ENTRY_ID}{cursor:pointer;}
            @media (max-width:560px){#${ROOT_ID}{padding:max(6px,env(safe-area-inset-top)) max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left));}#${ROOT_ID} .ctb-card{width:calc(100vw - 12px);max-height:calc(100dvh - 12px);}#${ROOT_ID} .ctb-header{padding:10px 12px 8px;}#${ROOT_ID} .ctb-title{font-size:16px;}#${ROOT_ID} .ctb-tabs{padding:0 7px;}#${ROOT_ID} .ctb-tab{font-size:13px;}#${ROOT_ID} .ctb-body{padding:10px 12px 13px;}#${ROOT_ID} .ctb-search-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-search-row .ctb-input{flex-basis:100%;}#${ROOT_ID} .ctb-rule-row{grid-template-columns:39px 1fr 31px;}#${ROOT_ID} .ctb-rule-row .ctb-input:nth-of-type(2){grid-column:2/3;}#${ROOT_ID} .ctb-rule-row .ctb-input:nth-of-type(3){grid-column:2/3;}#${ROOT_ID} .ctb-rule-row .ctb-icon-button{grid-column:3;grid-row:1/3;} }
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
            #${ROOT_ID} .ctb-export-epub-combo{display:flex;align-items:center;min-width:0;height:39px;overflow:hidden;border-radius:4px;background:#5f94c4;}
            #${ROOT_ID} .ctb-export-epub{display:inline-flex;align-items:center;justify-content:center;flex:1;min-width:0;gap:4px;border-radius:4px 0 0 4px;}
            #${ROOT_ID} .ctb-export-info{flex:0 0 auto;margin:0 10px 0 3px;}
            #${ROOT_ID} .ctb-pending-title-side{display:inline-flex;align-items:center;gap:6px;}
            #${ROOT_ID} .ctb-pending-text,#${ROOT_ID} .ctb-review-dialog-text{display:block;max-height:185px;overflow:auto;padding:7px 8px;color:#55585c;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#ebe8e7;}
            #${ROOT_ID} .ctb-pending-text mark,#${ROOT_ID} .ctb-review-dialog-text mark{padding:0;background:transparent;color:#c34f4e;font-weight:700;}
            #${ROOT_ID} .ctb-review-empty{color:#8b8e93;}
            #${ROOT_ID} .ctb-review-expand{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;padding:0;border:1px solid #c8c2bf;border-radius:3px;background:transparent;color:#807a78;cursor:pointer;}
            #${ROOT_ID} .ctb-review-expand:hover{background:#e1dcda;color:#5d5653;}
            #${ROOT_ID} .ctb-review-overlay{position:fixed;inset:0;z-index:2147483100;display:grid;place-items:center;padding:20px;background:rgba(18,21,27,.48);}
            #${ROOT_ID} .ctb-review-dialog{width:min(820px,calc(100vw - 36px));max-height:min(82vh,760px);display:flex;flex-direction:column;overflow:hidden;background:#f5f5f7;border:1px solid #bfc2c7;border-radius:4px;box-shadow:0 14px 38px rgba(0,0,0,.35);}
            #${ROOT_ID} .ctb-review-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid #d2d4d8;color:#555960;font-size:12px;font-weight:700;background:#fafafd;}
            #${ROOT_ID} .ctb-review-dialog-text{max-height:none;flex:1;min-height:120px;overflow:auto;padding:12px;background:#f0f0f2;}
            #${ROOT_ID} .ctb-post-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
            #${ROOT_ID} .ctb-textarea{height:100px;resize:vertical;line-height:1.45;}
            #${ROOT_ID} .ctb-post-actions{flex-wrap:wrap;}
            #${ROOT_ID} .ctb-post-preview{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
            #${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:1/-1;}
            #${ROOT_ID} .ctb-post-column{min-width:0;}
            #${ROOT_ID} .ctb-post-label{margin-bottom:4px;color:#777b81;font-size:11px;}
            #${ROOT_ID} .ctb-post-label-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;}
            #${ROOT_ID} .ctb-post-text{height:170px;max-height:32vh;overflow:auto;margin:0;padding:8px;border:1px solid #d0d2d7;border-radius:3px;background:#ececef;color:#55585d;font:11px/1.5 var(--mainFontFamily,Arial,sans-serif);white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-post-edit-textarea{width:100%;resize:vertical;} #${ROOT_ID} .ctb-diff-add{padding:0;background:transparent;color:#c1504f;font-weight:700;} #${ROOT_ID} .ctb-diff-paragraph{box-decoration-break:clone;-webkit-box-decoration-break:clone;}
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
            #${ROOT_ID} .ctb-preset-row{margin-bottom:6px;} #${ROOT_ID} .ctb-preset-row select{max-width:150px;} #${ROOT_ID} .ctb-preset-row input{flex:1;}
            #${ROOT_ID} .ctb-context-row{flex-wrap:wrap;} #${ROOT_ID} .ctb-context-label{color:#74777c;font-size:10px;} #${ROOT_ID} .ctb-context-tags{margin-top:6px;} #${ROOT_ID} .ctb-rewrite-global{height:62px;margin-top:6px;}
            #${ROOT_ID} .ctb-primary-soft{border-color:#91aa98;background:#e0e9e3;color:#4d6755;} #${ROOT_ID} .ctb-world-picker-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button:first-child{flex:1;justify-content:space-between;} #${ROOT_ID} .ctb-world-picker-summary .ctb-button span{color:#7a817c;font-size:10px;font-weight:400;}
            #${ROOT_ID} .ctb-world-selected-summary{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px;} #${ROOT_ID} .ctb-world-selected-summary span{max-width:100%;overflow:hidden;padding:3px 6px;border:1px solid #c9d2cc;border-radius:3px;background:#e5ebe7;color:#5c6860;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}
            #${ROOT_ID} .ctb-world-picker{margin-top:6px;overflow:hidden;border:1px solid #cbd0cc;border-radius:3px;background:#e9ebeb;} #${ROOT_ID} .ctb-world-book-row{padding:6px;border-bottom:1px solid #cfd3d0;} #${ROOT_ID} .ctb-world-book-row select{flex:1;} #${ROOT_ID} .ctb-world-bulk{justify-content:flex-end;padding:5px 6px;border-bottom:1px solid #d3d6d4;color:#6d716f;font-size:10px;} #${ROOT_ID} .ctb-world-bulk>span{margin-right:auto;}
            #${ROOT_ID} .ctb-world-entry-list{max-height:230px;overflow:auto;} #${ROOT_ID} .ctb-world-entry{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:6px;padding:7px;border-bottom:1px solid #d4d7d5;color:#555b57;cursor:pointer;} #${ROOT_ID} .ctb-world-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-world-entry.is-selected{background:#dfe8e1;} #${ROOT_ID} .ctb-world-entry-main{display:flex;min-width:0;flex-direction:column;gap:2px;} #${ROOT_ID} .ctb-world-entry-main strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-main small{overflow:hidden;color:#858a87;font-size:9px;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-world-entry-meta{color:#8a8d8b;font-size:9px;white-space:nowrap;} #${ROOT_ID} .ctb-world-empty{display:flex;align-items:center;justify-content:center;gap:7px;min-height:70px;padding:10px;color:#858a87;font-size:10px;} #${ROOT_ID} .ctb-world-error{color:#985957;}
            #${ROOT_ID} .ctb-rewrite-list{max-height:280px;overflow:auto;border:1px solid #cfd1d5;border-radius:3px;background:#ededf0;}
            #${ROOT_ID} .ctb-rewrite-paragraph{display:grid;grid-template-columns:42px minmax(0,1fr);gap:5px 8px;padding:7px 8px;border-bottom:1px solid #d5d6da;} #${ROOT_ID} .ctb-rewrite-paragraph:last-child{border-bottom:0;}
            #${ROOT_ID} .ctb-rewrite-select{grid-row:1/3;display:flex;align-items:flex-start;gap:4px;color:#6b6e73;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-source{min-width:0;color:#4f5257;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-rewrite-generate,#${ROOT_ID} .ctb-rewrite-final{justify-content:flex-end;flex-wrap:wrap;margin-top:7px;}
            #${ROOT_ID} .ctb-rewrite-reviews{display:grid;gap:6px;} #${ROOT_ID} .ctb-rewrite-review{overflow:hidden;border:1px solid #cfd1d5;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-rewrite-review.is-accepted{border-color:#92b19a;} #${ROOT_ID} .ctb-rewrite-review.is-rejected{opacity:.68;}
            #${ROOT_ID} .ctb-rewrite-review-title{display:flex;justify-content:space-between;padding:5px 7px;border-bottom:1px solid #d3d5d8;color:#65696e;font-size:10px;font-weight:700;} #${ROOT_ID} .ctb-rewrite-compare{display:grid;grid-template-columns:1fr 1fr;} #${ROOT_ID} .ctb-rewrite-compare>div{min-width:0;padding:7px;} #${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:1px solid #d3d5d8;background:#e5ebe7;} #${ROOT_ID} .ctb-rewrite-compare small{color:#85898e;} #${ROOT_ID} .ctb-rewrite-compare p{margin:3px 0 0;color:#4e5156;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-rewrite-review>.ctb-inline{padding:0 7px 7px;}
            #${ROOT_ID} .ctb-prompt-preview{padding:7px;border:1px solid #cfd3d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-prompt-preview .ctb-section-title{justify-content:space-between;} #${ROOT_ID} .ctb-prompt-preview pre{max-height:320px;overflow:auto;margin:0;padding:8px;background:#f3f3f5;color:#50545a;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-system-prompt{min-height:92px;height:92px;font:11px/1.45 var(--mainFontFamily,Arial,sans-serif);resize:vertical;}
            #${ROOT_ID} .ctb-post-review-grid{grid-template-columns:1fr 1fr 1fr;}
            #${ROOT_ID} .ctb-post-review-grid>div+div{border-left:1px solid #d3d5d8;background:#eef0ee;}
            #${ROOT_ID} .ctb-review-edit{width:100%;min-height:75px;height:75px;resize:vertical;font-size:11px;line-height:1.45;}
            #${ROOT_ID} .ctb-diff-review-text{color:#c1504f!important;font-weight:700;}
            #${ROOT_ID} .ctb-notice-overlay{position:fixed;inset:0;z-index:2147483200;display:grid;place-items:center;padding:20px;background:rgba(18,21,27,.35);}
            #${ROOT_ID} .ctb-notice-card{width:min(420px,calc(100vw - 36px));padding:14px 16px;border:1px solid #c3c7cc;border-radius:4px;background:#f7f7f9;box-shadow:0 12px 30px rgba(0,0,0,.28);color:#50545a;}
            #${ROOT_ID} .ctb-notice-card.is-error{border-left:4px solid #c35a58;} #${ROOT_ID} .ctb-notice-card.is-warning{border-left:4px solid #b58b4d;} #${ROOT_ID} .ctb-notice-card.is-success{border-left:4px solid #7da287;}
            #${ROOT_ID} .ctb-notice-title{margin-bottom:7px;font-size:13px;font-weight:700;} #${ROOT_ID} .ctb-notice-message{margin-bottom:12px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}
            #${ROOT_ID} .ctb-confirm-actions{justify-content:flex-end;}
            #${ROOT_ID} .ctb-tabs{display:flex;overflow-x:auto;scrollbar-width:thin;} #${ROOT_ID} .ctb-tab{flex:0 0 calc(100% / var(--ctb-tab-count,4));min-width:92px;}
            #${ROOT_ID} .ctb-theater-prompt{min-height:92px;height:92px;} #${ROOT_ID} .ctb-theater-actions{justify-content:flex-end;margin-top:7px;} #${ROOT_ID} .ctb-theater-result{max-height:360px;overflow:auto;margin:0;padding:9px;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;color:#4e5257;font:11px/1.55 var(--mainFontFamily,Arial,sans-serif);white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-theater-history{margin-bottom:5px;border:1px solid #d0d2d6;border-radius:3px;background:#ececef;padding:6px 8px;} #${ROOT_ID} .ctb-theater-history summary{cursor:pointer;color:#5e6268;font-size:11px;} #${ROOT_ID} .ctb-theater-history pre{max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:10px/1.5 var(--mainFontFamily,Arial,sans-serif);}
            #${ROOT_ID} .ctb-manager-toolbar{flex-wrap:wrap;} #${ROOT_ID} .ctb-manager-toolbar>.ctb-input{flex:1;min-width:140px;} #${ROOT_ID} .ctb-manager-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:7px;margin-top:7px;} #${ROOT_ID} .ctb-manager-list{max-height:390px;overflow:auto;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-manager-row{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:6px;border-bottom:1px solid #d5d7da;padding:5px 7px;} #${ROOT_ID} .ctb-manager-row:last-child{border-bottom:0;} #${ROOT_ID} .ctb-manager-row.is-active{background:#dfe8e2;} #${ROOT_ID} .ctb-manager-row>button{display:flex;min-width:0;flex-direction:column;align-items:flex-start;border:0;background:transparent;color:#50545a;text-align:left;cursor:pointer;} #${ROOT_ID} .ctb-manager-row strong,#${ROOT_ID} .ctb-manager-row small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-manager-row small,#${ROOT_ID} .ctb-manager-row>span{color:#85898e;font-size:9px;} #${ROOT_ID} .ctb-manager-editor{display:grid;align-content:start;gap:6px;padding:8px;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-manager-content{min-height:190px;height:190px;} #${ROOT_ID} .ctb-manager-fields{flex-wrap:wrap;} #${ROOT_ID} .ctb-manager-fields select{width:auto;min-width:110px;} #${ROOT_ID} .ctb-manager-actions{justify-content:flex-end;} #${ROOT_ID} .ctb-manager-savebar{position:sticky;bottom:-15px;justify-content:space-between;margin:10px -16px -15px;padding:8px 16px;border-top:1px solid #cdd0d4;background:#ececef;color:#697069;font-size:11px;}
            #${ROOT_ID} .ctb-preset-transfer-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;} #${ROOT_ID} .ctb-preset-entry-list{max-height:365px;overflow:auto;margin-top:6px;border:1px solid #cfd2d6;border-radius:3px;background:#ececef;} #${ROOT_ID} .ctb-preset-entry{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:start;gap:6px;padding:7px;border-bottom:1px solid #d5d7da;color:#51555b;} #${ROOT_ID} .ctb-preset-entry:last-child{border-bottom:0;} #${ROOT_ID} .ctb-preset-entry.is-selected{background:#dfe8e2;} #${ROOT_ID} .ctb-preset-entry.is-target{grid-template-columns:1fr;} #${ROOT_ID} .ctb-preset-entry span{display:flex;min-width:0;flex-direction:column;gap:2px;} #${ROOT_ID} .ctb-preset-entry strong,#${ROOT_ID} .ctb-preset-entry small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} #${ROOT_ID} .ctb-preset-entry strong{font-size:11px;} #${ROOT_ID} .ctb-preset-entry small{color:#85898e;font-size:9px;}
            #${ROOT_ID} .ctb-list-more{display:block;width:100%;border:0;border-top:1px solid #d1d4d7;background:#e1e3e5;color:#697078;padding:7px;cursor:pointer;font:10px var(--mainFontFamily,Arial,sans-serif);} #${ROOT_ID} .ctb-list-more:hover{background:#d8ddda;}
            #${SETTINGS_ID}{margin:10px 0;border:1px solid var(--SmartThemeBorderColor,#777);border-radius:5px;background:rgba(255,255,255,.04);color:var(--SmartThemeBodyColor,inherit);} #${SETTINGS_ID}>summary{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:pointer;font-weight:700;} #${SETTINGS_ID}>summary span{margin-left:auto;color:var(--SmartThemeEmColor,#999);font-size:11px;font-weight:400;} #${SETTINGS_ID} .ctb-extension-settings-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 12px;padding:4px 12px 12px;} #${SETTINGS_ID} .ctb-extension-settings-title,#${SETTINGS_ID} p{grid-column:1/-1;} #${SETTINGS_ID} .ctb-extension-settings-title{font-weight:700;} #${SETTINGS_ID} label{display:flex;align-items:center;gap:6px;} #${SETTINGS_ID} input{width:16px;height:16px;accent-color:#7da287;} #${SETTINGS_ID} p{margin:4px 0 0;color:var(--SmartThemeEmColor,#999);font-size:11px;line-height:1.45;}
            @media (max-width:560px){#${ROOT_ID} .ctb-tabs{padding:0 5px;}#${ROOT_ID} .ctb-tab{font-size:11px;}#${ROOT_ID} .ctb-post-grid,#${ROOT_ID} .ctb-post-preview,#${ROOT_ID} .ctb-channel-grid,#${ROOT_ID} .ctb-rewrite-compare{grid-template-columns:1fr;}#${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:auto;}#${ROOT_ID} .ctb-channel-grid>*{grid-column:1!important;}#${ROOT_ID} .ctb-preset-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-preset-row select{max-width:none;flex-basis:100%;}#${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:0;border-top:1px solid #d3d5d8;}#${ROOT_ID} .ctb-export-tag-options{grid-template-columns:1fr;}}
            @media (max-width:560px){#${ROOT_ID} .ctb-manager-grid,#${ROOT_ID} .ctb-preset-transfer-grid{grid-template-columns:1fr;}#${ROOT_ID} .ctb-manager-list,#${ROOT_ID} .ctb-preset-entry-list{max-height:250px;}#${ROOT_ID} .ctb-manager-savebar{margin-left:-12px;margin-right:-12px;padding-left:12px;padding-right:12px;}#${SETTINGS_ID} .ctb-extension-settings-body{grid-template-columns:1fr;}}
        `;
        doc.head.appendChild(style);

        root = doc.createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        root.addEventListener('click', (event) => {
            if (event.target === root) closePanel();
        });
        root.addEventListener('input', handleInput);
        root.addEventListener('change', handleChange);
        root.addEventListener('keydown', (event) => {
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
        else if (id === 'ctb-theater-context-floors') settings.theater.contextFloors = target.value;
        else if (id === 'ctb-theater-context-tags') settings.theater.contextTags = target.value;
        else if (id === 'ctb-worldbook-search') { worldbookSearch = target.value; return; }
        else if (id === 'ctb-worldbook-comment' && worldbookDraft) { worldbookDraft.comment = target.value; worldbookDirty = true; return; }
        else if (id === 'ctb-worldbook-keys' && worldbookDraft) { worldbookDraft.key = target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); worldbookDirty = true; return; }
        else if (id === 'ctb-worldbook-content' && worldbookDraft) { worldbookDraft.content = target.value; worldbookDirty = true; return; }
        else if (id === 'ctb-worldbook-order' && worldbookDraft) { worldbookDraft.order = Number(target.value) || 0; worldbookDirty = true; return; }
        else if (id === 'ctb-worldbook-depth' && worldbookDraft) { worldbookDraft.depth = Number(target.value) || 0; worldbookDirty = true; return; }
        else if (id === 'ctb-preset-transfer-search') { presetTransferSearch = target.value; return; }
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
        if (id?.startsWith('ctb-post-edit-') || id?.startsWith('ctb-rewrite-') || id?.startsWith('ctb-theater-')) saveSettings();
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
        else if (target.dataset.worldbookSelectUid !== undefined) {
            const uid = String(target.dataset.worldbookSelectUid);
            if (target.checked) worldbookSelected.add(uid);
            else worldbookSelected.delete(uid);
            renderPanel();
            return;
        }
        else if (target.dataset.presetEntryId !== undefined) {
            const idValue = String(target.dataset.presetEntryId);
            if (target.checked) presetTransferSelected.add(idValue);
            else presetTransferSelected.delete(idValue);
            renderPanel();
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
        else if (id === 'ctb-worldbook-book') {
            await chooseWorldbook(target.value);
            return;
        }
        else if (id === 'ctb-worldbook-transfer-target') {
            worldbookTransferTarget = target.value;
            return;
        }
        else if (id === 'ctb-worldbook-position' && worldbookDraft) {
            worldbookDraft.position = Number(target.value) || 0;
            worldbookDirty = true;
            return;
        }
        else if (id === 'ctb-worldbook-constant' && worldbookDraft) {
            worldbookDraft.constant = target.checked;
            worldbookDirty = true;
            return;
        }
        else if (id === 'ctb-worldbook-disabled' && worldbookDraft) {
            worldbookDraft.disable = target.checked;
            worldbookDirty = true;
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
            saveSettings();
        } else if (id === 'ctb-rewrite-persona') {
            settings.rewrite.includePersona = target.checked;
            saveSettings();
        } else if (id === 'ctb-theater-character') {
            settings.theater.includeCharacter = target.checked;
            saveSettings();
        } else if (id === 'ctb-theater-persona') {
            settings.theater.includePersona = target.checked;
            saveSettings();
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
                settings.theater.worldEntries = Array.isArray(preset.worldEntries) ? preset.worldEntries.map((item) => ({ world: String(item.world), uid: String(item.uid) })) : [];
                settings.theater.channelId = preset.channelId || 'main';
            } else settings.theater.presetName = '';
            saveSettings();
            renderPanel();
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
            case 'close-notice': transientNotice = null; return renderPanel();
            case 'confirm-dialog': {
                const confirm = pendingConfirm;
                pendingConfirm = null;
                renderPanel();
                if (confirm?.action === 'replace-all') return replaceAllNow();
                return undefined;
            }
            case 'cancel-dialog': pendingConfirm = null; return renderPanel();
            case 'show-info': infoMessage = infoMessage === data.infoKey ? null : data.infoKey; return renderPanel();
            case 'close-info': infoMessage = null; return renderPanel();
            case 'tab': infoMessage = null; activeTab = data.tab; return renderPanel();
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
                saveSettings();
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
            case 'clear-theater-world-selection': settings.theater.worldEntries = []; saveSettings(); return renderPanel();
            case 'select-theater-world-all': return setTheaterWorldBookSelection(true);
            case 'clear-theater-world-book': return setTheaterWorldBookSelection(false);
            case 'save-theater-preset': return saveTheaterPreset();
            case 'delete-theater-preset': return deleteTheaterPreset();
            case 'run-theater': return runTheater();
            case 'preview-theater-prompt': return previewTheaterPrompt();
            case 'close-theater-preview': theaterPromptPreview = ''; return renderPanel();
            case 'use-theater-history': return loadTheaterHistory(data.historyIndex);
            case 'refresh-worldbook': return loadWorldbookManager({ force: true, book: worldbookBook });
            case 'create-worldbook': return createWorldbookBook();
            case 'rename-worldbook': return renameWorldbookBook();
            case 'delete-worldbook': return deleteWorldbookBook();
            case 'new-worldbook-entry': return createWorldbookEntry();
            case 'filter-worldbook': worldbookVisibleLimit = 120; return renderPanel();
            case 'more-worldbook-entries': worldbookVisibleLimit += 120; return renderPanel();
            case 'edit-worldbook-entry': return editWorldbookEntry(data.worldbookUid);
            case 'apply-worldbook-entry': return applyWorldbookDraft();
            case 'sort-worldbook-priority':
                worldbookEntries.sort((left, right) => Number(right.raw?.order || 0) - Number(left.raw?.order || 0) || worldbookRecordLabel(left).localeCompare(worldbookRecordLabel(right)));
                return renderPanel();
            case 'save-worldbook': return saveCurrentWorldbook();
            case 'copy-worldbook-entries': return transferWorldbookEntries('copy');
            case 'move-worldbook-entries': return transferWorldbookEntries('move');
            case 'delete-worldbook-entries': return deleteSelectedWorldbookEntries();
            case 'refresh-preset-transfer': return loadPresetTransfer({ force: true });
            case 'filter-preset-transfer': presetTransferVisibleLimit = 120; return renderPanel();
            case 'more-preset-transfer-entries': presetTransferVisibleLimit += 120; return renderPanel();
            case 'copy-preset-entries': return transferPresetEntries('copy');
            case 'move-preset-entries': return transferPresetEntries('move');
            case 'delete-preset-entries': return deletePresetEntries();
            default: return undefined;
        }
    }

    function findMenuTarget() {
        const direct = doc.querySelector('#option_manage_chat_files, #option_select_chat_file, #option_select_chat');
        if (direct) return direct;
        const candidates = Array.from(doc.querySelectorAll('a, button, .list-group-item, .option_select'));
        return candidates.find((node) => {
            const text = String(node.textContent || '').trim();
            return /manage\s+chat\s+files|管理聊天文件/i.test(text);
        }) || null;
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
            '#extensions_settings2 .inline-drawer-content',
            '#extensions_settings2',
            '#extensions_settings .inline-drawer-content',
            '#extensions_settings',
            '.extensions_settings',
        ];
        for (const selector of selectors) {
            const node = doc.querySelector(selector);
            if (node && !node.closest(`#${ROOT_ID}`)) return node;
        }
        return null;
    }

    function injectExtensionSettings() {
        if (destroyed || !doc.body) return false;
        const target = findExtensionsSettingsRoot();
        if (!target) return false;
        let panel = doc.getElementById(SETTINGS_ID);
        if (panel && panel.parentElement === target) return true;
        if (!panel) {
            panel = doc.createElement('details');
            panel.id = SETTINGS_ID;
            panel.className = 'ctb-extension-settings';
            panel.open = false;
            panel.addEventListener('change', (event) => {
                const input = event.target.closest('[data-ctb-module]');
                if (!input) return;
                const key = input.dataset.ctbModule;
                if (!MODULES.some((module) => module.key === key)) return;
                settings.modules[key] = Boolean(input.checked);
                saveSettings();
                ensureActiveTab();
                renderPanel();
                injectExtensionSettings();
            });
        }
        panel.innerHTML = `<summary><i class="fa-solid fa-toolbox"></i> 聊天工具箱 <span>v${VERSION}</span></summary><div class="ctb-extension-settings-body"><div class="ctb-extension-settings-title">功能开关</div>${MODULES.map((module) => `<label><input type="checkbox" data-ctb-module="${module.key}"${settings.modules?.[module.key] !== false ? ' checked' : ''}> <span>${module.label}</span></label>`).join('')}<p>关闭后只隐藏对应功能页；三条杠菜单中的“聊天工具箱”入口始终保留。</p></div>`;
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
        if (menu.lastElementChild !== entry) menu.appendChild(entry);
        return true;
    }

    function registerSlashCommand() {
        try {
            const parser = host.SillyTavern?.SlashCommandParser;
            const command = host.SillyTavern?.SlashCommand;
            if (parser && command?.fromProps) parser.addCommandObject(command.fromProps({ name: 'chat-toolbox', callback: () => showPanel('search'), helpString: '打开聊天工具箱' }));
        } catch (_) {}
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        stopSearchSaveClock();
        menuObserver?.disconnect();
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
        theaterHistory = Array.isArray(settings.theater?.history) ? settings.theater.history : [];
        presetTransferApi = settings.presetTransfer?.apiId || 'openai';
        presetTransferSource = settings.presetTransfer?.source || '';
        presetTransferTarget = settings.presetTransfer?.target || '';
        saveSettings();
        createUI();
        injectMenuEntry();
        injectExtensionSettings();
        host.setTimeout(injectMenuEntry, 800);
        host.setTimeout(injectExtensionSettings, 900);
        host.setTimeout(injectMenuEntry, 2200);
        host.setTimeout(injectExtensionSettings, 2300);
        menuObserver = new MutationObserver(() => {
            injectMenuEntry();
            injectExtensionSettings();
        });
        menuObserver.observe(doc.body, { childList: true, subtree: true });
        registerSlashCommand();
        host.addEventListener('pagehide', destroy, { once: true });
        host.addEventListener('unload', destroy, { once: true });
        host[INSTANCE_KEY] = destroy;
        console.info(`[聊天工具箱] v${VERSION} 已加载`);
    }

    init();
})();
