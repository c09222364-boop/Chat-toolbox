// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      0.7.0
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改与逐段改写
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.6.0';
    const PREFIX = 'ctb-v020';
    const STYLE_ID = `${PREFIX}-style`;
    const ROOT_ID = `${PREFIX}-root`;
    const FLOAT_ID = `${PREFIX}-float`;
    const ENTRY_ID = `${PREFIX}-menu-entry`;
    const INSTANCE_KEY = '__ChatToolbox_v020__';
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
    });

    function defaults() {
        return {
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
            const next = {
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
            const found = […33697 tokens truncated…-rewrite-compare>div{min-width:0;padding:7px;} #${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:1px solid #d3d5d8;background:#e5ebe7;} #${ROOT_ID} .ctb-rewrite-compare small{color:#85898e;} #${ROOT_ID} .ctb-rewrite-compare p{margin:3px 0 0;color:#4e5156;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;} #${ROOT_ID} .ctb-rewrite-review>.ctb-inline{padding:0 7px 7px;}
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
            @media (max-width:560px){#${ROOT_ID} .ctb-tabs{padding:0 5px;}#${ROOT_ID} .ctb-tab{font-size:11px;}#${ROOT_ID} .ctb-post-grid,#${ROOT_ID} .ctb-post-preview,#${ROOT_ID} .ctb-channel-grid,#${ROOT_ID} .ctb-rewrite-compare{grid-template-columns:1fr;}#${ROOT_ID} .ctb-post-preview>.ctb-section-title{grid-column:auto;}#${ROOT_ID} .ctb-channel-grid>*{grid-column:1!important;}#${ROOT_ID} .ctb-preset-row{flex-wrap:wrap;}#${ROOT_ID} .ctb-preset-row select{max-width:none;flex-basis:100%;}#${ROOT_ID} .ctb-rewrite-compare>div+div{border-left:0;border-top:1px solid #d3d5d8;}#${ROOT_ID} .ctb-export-tag-options{grid-template-columns:1fr;}}
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
        if (id?.startsWith('ctb-post-edit-') || id?.startsWith('ctb-rewrite-')) saveSettings();
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
        else if (id === 'ctb-rewrite-world-book') {
            await chooseRewriteWorldBook(target.value);
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
                if (index < 0 || !host.confirm('确定删除这个生成渠道吗？词句修改和逐段改写中引用它的设置都会改为跟随酒馆主接口。')) return;
                settings.ai.channels.splice(index, 1);
                if (settings.postEdit.channelId === data.channelId) settings.postEdit.channelId = 'main';
                if (settings.rewrite.channelId === data.channelId) settings.rewrite.channelId = 'main';
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
        if (host[INSTANCE_KEY] === destroy) delete host[INSTANCE_KEY];
    }

    function init() {
        if (!doc.body) return host.setTimeout(init, 80);
        const context = getContext();
        if ((!context || !context.extensionSettings) && initAttempts++ < 30) return host.setTimeout(init, 100);
        settings = loadSettings();
        saveSettings();
        createUI();
        injectMenuEntry();
        host.setTimeout(injectMenuEntry, 800);
        host.setTimeout(injectMenuEntry, 2200);
        menuObserver = new MutationObserver(() => injectMenuEntry());
        menuObserver.observe(doc.body, { childList: true, subtree: true });
        registerSlashCommand();
        host.addEventListener('pagehide', destroy, { once: true });
        host.addEventListener('unload', destroy, { once: true });
        host[INSTANCE_KEY] = destroy;
        console.info(`[聊天工具箱] v${VERSION} 已加载`);
    }

    init();
})();

