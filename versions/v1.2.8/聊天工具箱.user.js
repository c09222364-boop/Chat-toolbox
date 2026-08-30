// ==UserScript==
// @name         聊天工具箱（查找、导出与 AI 改写）
// @version      1.2.8
// @description  SillyTavern 当前聊天的楼层导航、暂存式查找替换、TXT/EPUB 导出、AI 词句修改、IF 支线收藏、世界书管理与预设条目转移
// @match        *://*/*
// ==/UserScript==

import { createIfBranchModule } from './if-branch.js';
import { createWorldbookModule } from './worldbook.js';
import { createPresetTransferModule } from './preset-transfer.js';
import { createSearchExportModule } from './search-export.js';
import { createPostEditModule } from './post-edit.js';

(function () {
    'use strict';

    const VERSION = '1.2.8';
    const PREFIX = 'chat-toolbox';
    const ROOT_ID = `${PREFIX}-root`;
    const ENTRY_ID = `${PREFIX}-menu-entry`;
    const SETTINGS_ID = `${PREFIX}-extension-settings`;
    const INSTANCE_KEY = '__ChatToolbox__';
    const COMMAND_HANDLER_KEY = '__ChatToolboxCommandHandler__';
    const COMMAND_REGISTERED_KEY = '__ChatToolboxCommandRegistered__';
    const STORAGE_KEY = 'chat-toolbox-settings';
    const MAX_RESULTS = 2000;
    const AI_REQUEST_TIMEOUT_SEC = 300;

    let doc = document;
    let host = window;
    try {
        if (window.parent && window.parent !== window && window.parent.document) {
            doc = window.parent.document;
            host = window.parent;
        }
    } catch (_) {}

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
    let settingsSaveTimer = null;
    let infoMessage = null;
    let initAttempts = 0;
    // Keep plugin notifications inside the toolbox so API/save errors do not
    // leak into SillyTavern's page-level toastr layer while the panel is open.
    let transientNotice = null;
    let pendingDialog = null;
    let settings = defaults();

    const INFO = Object.freeze({
        'search-results': '用于查看所有查找结果。点击一条结果可跳到对应楼层，上下按钮可切换当前结果。',
        'json-readonly': '用于查看消息的完整数据，例如发言者、正文和消息类型；这里只能查找，不能替换。',
        'export-range': '用于选择导出的楼层范围。两项都留空会导出全部楼层，只填一项则从该楼层开始或到该楼层结束。',
        'export-tags': '用于只导出指定标签里的文字，例如 content；留空会导出整条消息正文。',
        'export-epub': '用于把聊天导出为 EPUB 电子书，每条消息会成为一个章节。',
        'undo': '用于撤销本次打开页面后的最后一次查找替换操作；刷新页面后撤销记录会清空。',
        'post-edit-overview': '用于修订一个 AI 楼层的词句。生成后可以逐段审核，采用的内容才会写回聊天。',
        'post-edit-scope': '用于指定要修订的正文标签。填写 content 时，只处理 <content> 标签内的文字；留空则处理整条正文。',
        'channel-main': '选择“跟随酒馆主接口”会使用酒馆当前连接；选择自定义渠道则使用单独填写的地址、密钥和模型。',
        'system-cache': '用于填写模型的身份、写作要求和输出格式。留空时使用默认提示词。',
        'if-branch-scope': '先从开场词库选择一条指令建立临时 IF 支线，然后直接在酒馆主聊天中连续对话。结束时可收藏并删除整条支线、仅删除，或保留为主线。',
        'worldbook-save': '进入世界书管理时会优先打开当前角色卡绑定的世界书；“模拟”可检查最近 2 层触发的条目并展开实际正文。“双书对比”只显示同名但内容或设置不同的条目，差异句子和设置会标深红，可编辑任一侧或完整覆盖另一侧。普通条目修改会先暂存在页面中，点击“现在保存”后写入世界书文件。',
        'preset-transfer': '用于查看、编辑、复制或移动预设中的提示词条目。双预设模式可进入纯差异视图，只显示同名但正文、角色或启用状态不同的条目，并将差异句子与设置标深红。',
    });

    function defaults() {
        return {
            uiTheme: 'blue',
            modules: {
                search: true,
                export: true,
                postEdit: true,
                ifBranch: true,
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
            ifBranch: {
                prompts: [],
                favorites: [],
            },
        };
    }

    const MODULES = Object.freeze([
        { key: 'search', tab: 'search', label: '查找/替换' },
        { key: 'worldbook', tab: 'worldbook', label: '世界书管理' },
        { key: 'ifBranch', tab: 'if-branch', label: 'IF 支线' },
        { key: 'postEdit', tab: 'post-edit', label: '词句修改' },
        { key: 'export', tab: 'export', label: '文本导出' },
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
        const model = String(channel.model || '');
        return {
            id: String(channel.id || `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
            name: String(channel.name || '自定义渠道'),
            url: String(channel.url || ''),
            key: String(channel.key || ''),
            model,
            models: Array.isArray(channel.models) ? [...new Set(channel.models.map(String).filter(Boolean))] : [],
            temperature: Math.max(0, Math.min(2, Number(channel.temperature) || 0)),
            maxTokens: !Number.isFinite(rawMaxTokens) || rawMaxTokens <= 0
                ? 4096
                : Math.round(rawMaxTokens),
            timeoutSec: !Number.isFinite(rawTimeout) || rawTimeout <= 0
                ? AI_REQUEST_TIMEOUT_SEC
                : Math.max(10, Math.min(600, Math.round(rawTimeout))),
        };
    }

    function normalizeIfPrompt(prompt) {
        if (!prompt || typeof prompt !== 'object') return null;
        const name = String(prompt.name || '').trim();
        const content = String(prompt.content || '').trim();
        if (!name || !content) return null;
        return {
            id: String(prompt.id || `if-prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
            name,
            tags: String(prompt.tags || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean).join(', '),
            content,
        };
    }

    function normalizeIfFavorite(item) {
        if (!item || typeof item !== 'object') return null;
        const messages = (Array.isArray(item.messages) ? item.messages : []).map((message) => {
            let text = String(message?.text || '');
            if (!text && message?.renderedHtml) {
                const container = doc.createElement('div');
                container.innerHTML = String(message.renderedHtml);
                text = String(container.textContent || '');
            }
            return {
                role: message?.role === 'user' ? 'user' : message?.role === 'system' ? 'system' : 'assistant',
                name: String(message?.name || ''),
                text,
            };
        }).filter((message) => message.text);
        if (!messages.length) return null;
        return {
            id: String(item.id || `if-favorite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
            title: String(item.title || '未命名 IF 支线').trim() || '未命名 IF 支线',
            tags: String(item.tags || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).join(', '),
            character: String(item.character || ''),
            chat: String(item.chat || ''),
            createdAt: String(item.createdAt || new Date().toISOString()),
            messages,
        };
    }

    function loadSettings() {
        try {
            const stored = getContext()?.extensionSettings?.[STORAGE_KEY];
            if (!stored || typeof stored !== 'object') return defaults();
            const next = defaults();
            next.ai.channels = (Array.isArray(stored.ai?.channels) ? stored.ai.channels : [])
                .map(normalizeSavedChannel)
                .filter(Boolean);
            const validChannel = (id) => id === 'main' || next.ai.channels.some((channel) => channel.id === id);
            const postChannelId = String(stored.postEdit?.channelId || 'main');
            next.postEdit.channelId = validChannel(postChannelId) ? postChannelId : 'main';
            next.postEdit.systemPrompt = typeof stored.postEdit?.systemPrompt === 'string' ? stored.postEdit.systemPrompt : next.postEdit.systemPrompt;
            next.postEdit.rules = typeof stored.postEdit?.rules === 'string' ? stored.postEdit.rules : '';
            next.postEdit.presets = Array.isArray(stored.postEdit?.presets) ? stored.postEdit.presets : [];
            next.ifBranch.prompts = (Array.isArray(stored.ifBranch?.prompts) ? stored.ifBranch.prompts : []).map(normalizeIfPrompt).filter(Boolean);
            next.ifBranch.favorites = (Array.isArray(stored.ifBranch?.favorites) ? stored.ifBranch.favorites : []).map(normalizeIfFavorite).filter(Boolean);
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
            ifBranch: {
                prompts: (Array.isArray(settings.ifBranch.prompts) ? settings.ifBranch.prompts : [])
                    .map(normalizeIfPrompt)
                    .filter(Boolean),
                favorites: (Array.isArray(settings.ifBranch.favorites) ? settings.ifBranch.favorites : [])
                    .map(normalizeIfFavorite)
                    .filter(Boolean),
            },
        };
    }

    function saveSettings() {
        if (settingsSaveTimer) host.clearTimeout(settingsSaveTimer);
        settingsSaveTimer = null;
        try {
            const context = getContext();
            if (!context.extensionSettings || typeof context.extensionSettings !== 'object') return;
            context.extensionSettings[STORAGE_KEY] = JSON.parse(JSON.stringify(persistentSettingsSnapshot()));
            context.saveSettingsDebounced?.();
        } catch (error) {
            console.warn('[聊天工具箱] 设置保存失败', error);
        }
    }


    function scheduleSettingsSave() {
        if (settingsSaveTimer) host.clearTimeout(settingsSaveTimer);
        settingsSaveTimer = host.setTimeout(() => {
            settingsSaveTimer = null;
            saveSettings();
        }, 450);
    }

    function flushSettingsSave() {
        if (!settingsSaveTimer) return;
        host.clearTimeout(settingsSaveTimer);
        settingsSaveTimer = null;
        saveSettings();
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

    function renderDialog() {
        if (!pendingDialog) return '';
        const isPrompt = pendingDialog.kind === 'prompt';
        const promptField = isPrompt
            ? `<label class="ctb-dialog-field">${pendingDialog.label ? `<span>${escapeHTML(pendingDialog.label)}</span>` : ''}<input class="ctb-input" id="ctb-dialog-input" value="${escapeHTML(pendingDialog.value || '')}" placeholder="${escapeHTML(pendingDialog.placeholder || '')}"></label>`
            : '';
        const actions = dialogChoices(pendingDialog).map((choice, index) => {
            const tone = choice.tone === 'danger' ? ' ctb-danger' : choice.tone === 'primary' ? ' ctb-primary' : '';
            return `<button type="button" class="ctb-button${tone}" data-action="resolve-dialog" data-dialog-choice="${index}">${escapeHTML(choice.label)}</button>`;
        }).join('');
        return `<div class="ctb-notice-overlay" role="dialog" aria-modal="true"><div class="ctb-notice-card is-warning"><div class="ctb-notice-title">${escapeHTML(pendingDialog.title || '请确认')}</div>${pendingDialog.message ? `<div class="ctb-notice-message">${escapeHTML(pendingDialog.message)}</div>` : ''}${promptField}<div class="ctb-inline ctb-dialog-actions">${actions}</div></div></div>`;
    }

    function dialogChoices(dialog) {
        if (Array.isArray(dialog?.buttons) && dialog.buttons.length) {
            return dialog.buttons.map((choice) => ({
                label: String(choice?.label || '确认'),
                value: choice?.value,
                tone: choice?.tone,
                submit: choice?.submit === true,
            }));
        }
        return [
            {
                label: String(dialog?.confirmLabel || '确认'),
                value: true,
                tone: dialog?.danger ? 'danger' : 'primary',
                submit: dialog?.kind === 'prompt',
            },
            { label: String(dialog?.cancelLabel || '取消'), value: null },
        ];
    }

    function requestDialog(options = {}) {
        if (pendingDialog) cancelPendingDialog();
        return new Promise((resolve) => {
            pendingDialog = { ...options, kind: options.kind === 'prompt' ? 'prompt' : 'confirm', resolve };
            renderPanel();
        });
    }

    function cancelPendingDialog() {
        const dialog = pendingDialog;
        pendingDialog = null;
        if (typeof dialog?.resolve === 'function') dialog.resolve(null);
    }

    function resolvePendingDialog(choiceIndex) {
        const dialog = pendingDialog;
        if (!dialog) return;
        const choice = dialogChoices(dialog)[Number(choiceIndex)];
        if (!choice) return;
        const value = dialog.kind === 'prompt' && choice.submit
            ? String(root?.querySelector('#ctb-dialog-input')?.value ?? '')
            : choice.value;
        pendingDialog = null;
        renderPanel();
        dialog.resolve?.(value);
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
                    headers: postEdit.requestHeaders(),
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
                console.warn('[聊天工具箱] 酒馆原生楼层重渲染失败，使用备用渲染', error);
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


    function showPanel(tab = activeTab) {
        if (!root) return;
        activeTab = tab;
        ensureActiveTab();
        root.hidden = false;
        renderPanel();
    }

    async function closePanel() {
        if (!(await worldbook.beforePanelClose())) return;
        infoMessage = null;
        transientNotice = null;
        cancelPendingDialog();
        if (root) root.hidden = true;
    }


    const searchExport = createSearchExportModule({
        host,
        doc,
        prefix: PREFIX,
        maxResults: MAX_RESULTS,
        getSettings: () => settings,
        getContext,
        getChat,
        messageId,
        messageName,
        messageText,
        setMessageText,
        isUserMessage,
        currentChatName,
        chatKey,
        normalizeBlankLines,
        collapseExtraBlankLines,
        escapeHTML,
        escapeXml,
        escapeRegex,
        escapeCss,
        saveChat,
        verifySavedEntries,
        refreshVisibleMessage,
        emitMessageEdited,
        emitMessageUpdated,
        download,
        notify,
        renderPanel,
        closePanel,
        getRoot: () => root,
        infoButton,
        requestDialog,
    });


    const postEdit = createPostEditModule({
        host,
        aiRequestTimeoutSec: AI_REQUEST_TIMEOUT_SEC,
        getSettings: () => settings,
        defaults,
        getContext,
        getChat,
        messageId,
        messageText,
        setMessageText,
        isAssistantMessage,
        escapeRegex,
        normalizeBlankLines,
        saveChat,
        verifySavedEntries,
        refreshVisibleMessage,
        emitMessageEdited,
        emitMessageUpdated,
        rememberUndo: searchExport.rememberUndo,
        saveSettings,
        scheduleSettingsSave,
        flushSettingsSave,
        notify,
        renderPanel,
        escapeHTML,
        infoButton,
        requestDialog,
        defaultPostEditSystemPrompt,
    });


    const ifBranch = createIfBranchModule({
        host,
        doc,
        getSettings: () => settings,
        getContext,
        getChat,
        currentCharacterCard,
        currentChatName,
        messageId,
        messageText,
        messageName,
        isUserMessage,
        deepClone,
        normalizeIfPrompt,
        normalizeIfFavorite,
        saveSettings,
        saveChat,
        notify,
        download,
        escapeHTML,
        infoButton,
        requestDialog,
        renderPanel,
        isPanelTabActive: (tab) => Boolean(root && !root.hidden && activeTab === tab),
        isDestroyed: () => destroyed,
    });


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

    const worldbook = createWorldbookModule({
        host,
        getContext,
        getChat,
        chatKey,
        currentCharacterCard,
        deepClone,
        stProxyJson: postEdit.stProxyJson,
        notify,
        renderPanel,
        getRoot: () => root,
        requestDialog,
        escapeHTML,
        messageId,
        messageName,
        messageText,
        infoButton,
    });


    const presetTransfer = createPresetTransferModule({
        host,
        getContext,
        deepClone,
        notify,
        renderPanel,
        getRoot: () => root,
        escapeHTML,
        infoButton,
        requestDialog,
    });


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
        // 切换标签时，先保存当前标签的滚动位置，避免覆盖目标标签的滚动位置。
        if (remember) rememberPanelScroll(activeTab);
        const total = getChat().length;
        const modules = ensureActiveTab();
        const renderers = {
            search: searchExport.renderSearchTab,
            export: searchExport.renderExportTab,
            'post-edit': postEdit.renderTab,
            'if-branch': ifBranch.renderTab,
            worldbook: worldbook.renderTab,
            'preset-transfer': presetTransfer.renderTab,
        };
        const body = activeTab && renderers[activeTab]
            ? renderers[activeTab]()
            : '<div class="ctb-results ctb-results-empty">所有功能都已在 Extensions 设置中关闭；菜单入口会继续保留。</div>';
        const tabs = modules.map((module) => `<button type="button" class="ctb-tab${activeTab === module.tab ? ' is-active' : ''}" data-action="tab" data-tab="${module.tab}">${module.label}</button>`).join('');
        const wideManager = activeTab === 'preset-transfer';
        const theme = settings.uiTheme === 'green' ? 'green' : 'blue';
        const nextThemeLabel = theme === 'green' ? '蓝色界面' : '绿色界面';
        root.innerHTML = `<div class="ctb-card ctb-theme-${theme}${wideManager ? ' ctb-card-wide' : ''}" role="dialog" aria-modal="true" aria-label="聊天工具箱" data-ctb-version="${VERSION}">
            <header class="ctb-header"><div class="ctb-title"><i class="fa-solid fa-toolbox"></i> 聊天工具箱 <small class="ctb-runtime-version">v${VERSION}</small></div><div class="ctb-header-side"><span>${total} 条消息</span><button type="button" class="ctb-theme-toggle" data-action="toggle-ui-theme" title="切换为${nextThemeLabel}" aria-label="切换为${nextThemeLabel}"><i class="fa-solid fa-palette" aria-hidden="true"></i></button><button type="button" class="ctb-close" data-action="close" aria-label="关闭">×</button></div></header>
            ${tabs ? `<nav class="ctb-tabs" style="--ctb-tab-count:${Math.min(modules.length, 5)}">${tabs}</nav>` : ''}
            <main class="ctb-body">${body}${renderInfoPopup()}</main>
            ${renderTransientNotice()}
            ${renderDialog()}
        </div>${ifBranch.renderReader()}`;
        restorePanelScroll(activeTab);
        if (ifBranch.hasReader()) {
            (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(() => {
                root?.querySelector('[data-action="close-if-reader"]')?.focus?.({ preventScroll: true });
            });
        } else if (pendingDialog?.kind === 'prompt') {
            (host.requestAnimationFrame || ((callback) => host.setTimeout(callback, 0)))(() => {
                const input = root?.querySelector('#ctb-dialog-input');
                input?.focus?.({ preventScroll: true });
                input?.select?.();
            });
        }
    }


    function createUI() {

        root = doc.createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        root.addEventListener('click', (event) => {
            if (event.target === root) closePanel();
            if (event.target.classList?.contains('ctb-reader-overlay')) ifBranch.closeReader();
        });
        root.addEventListener('input', handleInput);
        root.addEventListener('change', handleChange);
        root.addEventListener('keydown', (event) => {
            if (pendingDialog && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelPendingDialog();
                renderPanel();
                return;
            }
            if (pendingDialog?.kind === 'prompt' && event.key === 'Enter' && event.target?.id === 'ctb-dialog-input') {
                event.preventDefault();
                resolvePendingDialog(0);
                return;
            }
            if (event.key === 'Escape' && ifBranch.hasReader()) {
                ifBranch.handleGlobalKeydown(event);
                return;
            }
            searchExport.handleKeydown(event);
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
        searchExport.handleInput(target)
            || postEdit.handleInput(target)
            || ifBranch.handleInput(target)
            || worldbook.handleInput(target)
            || presetTransfer.handleInput(target);
    }


    async function handleChange(event) {
        const target = event.target;
        if (!target) return;
        if (searchExport.handleChange(target)) return;
        if (postEdit.handleChange(target)) return;
        if (await worldbook.handleChange(target)) return;
        await presetTransfer.handleChange(target);
    }


    async function handleAction(action, data) {
        if (await searchExport.handleAction(action, data) || await postEdit.handleAction(action, data) || await ifBranch.handleAction(action, data) || await worldbook.handleAction(action, data) || await presetTransfer.handleAction(action, data)) return;
        switch (action) {
            case 'close': return closePanel();
            case 'toggle-ui-theme':
                settings.uiTheme = settings.uiTheme === 'green' ? 'blue' : 'green';
                return renderPanel();
            case 'close-notice': transientNotice = null; return renderPanel();
            case 'resolve-dialog': return resolvePendingDialog(data.dialogChoice);
            case 'show-info': infoMessage = infoMessage === data.infoKey ? null : data.infoKey; return renderPanel();
            case 'close-info': infoMessage = null; return renderPanel();
            case 'tab':
                rememberPanelScroll(activeTab);
                infoMessage = null;
                activeTab = data.tab;
                return renderPanel({ remember: false });
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

    function hostMutationNeedsInjection(mutations) {
        const needsMenu = !doc.getElementById(ENTRY_ID)?.isConnected;
        const needsSettings = !doc.getElementById(SETTINGS_ID)?.isConnected;
        if (!needsMenu && !needsSettings) return false;
        const menuSelector = '#options,#options_menu,#options-menu,#options-content,#options-content-wrapper,.options-content,#option_list';
        const settingsSelector = '#extensions_settings,#extensions_settings2,.extensions_settings';
        const matchesRelevantNode = (node, selector) => node?.nodeType === 1
            && (node.matches?.(selector) || node.querySelector?.(selector));
        for (const mutation of mutations) {
            const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
            if (needsMenu && target?.closest?.(menuSelector)) return true;
            if (needsSettings && target?.closest?.(settingsSelector)) return true;
            for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
                if ((needsMenu && matchesRelevantNode(node, menuSelector))
                    || (needsSettings && matchesRelevantNode(node, settingsSelector))) return true;
            }
        }
        return false;
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
            // 注册一次斜杠命令，实例重载时只替换回调。
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
        flushSettingsSave();
        destroyed = true;
        searchExport.destroy();
        if (injectionTimer) host.clearTimeout(injectionTimer);
        injectionTimer = null;
        menuObserver?.disconnect();
        if (onPageHide) host.removeEventListener('pagehide', onPageHide);
        if (onUnload) host.removeEventListener('unload', onUnload);
        host.removeEventListener('keydown', ifBranch.handleGlobalKeydown, true);
        onPageHide = null;
        onUnload = null;
        if (host[COMMAND_HANDLER_KEY] === commandHandler) {
            host[COMMAND_HANDLER_KEY] = null;
        }
        commandHandler = null;
        ifBranch.destroy();
        doc.getElementById(ROOT_ID)?.remove();
        doc.getElementById(ENTRY_ID)?.remove();
        doc.getElementById(SETTINGS_ID)?.remove();
        if (host[INSTANCE_KEY] === destroy) delete host[INSTANCE_KEY];
    }

    function init() {
        if (!doc.body) return host.setTimeout(init, 80);
        const context = getContext();
        if ((!context || !context.extensionSettings) && initAttempts++ < 30) return host.setTimeout(init, 100);
        settings = loadSettings();
        createUI();
        injectMenuEntry();
        injectExtensionSettings();
        host.setTimeout(scheduleHostInjection, 800);
        host.setTimeout(scheduleHostInjection, 2200);
        menuObserver = new MutationObserver((mutations) => {
            if (hostMutationNeedsInjection(mutations)) scheduleHostInjection();
        });
        menuObserver.observe(doc.body, { childList: true, subtree: true });
        registerSlashCommand();
        ifBranch.bindEvents();
        onPageHide = destroy;
        onUnload = destroy;
        host.addEventListener('pagehide', onPageHide, { once: true });
        host.addEventListener('unload', onUnload, { once: true });
        host.addEventListener('keydown', ifBranch.handleGlobalKeydown, true);
        host[INSTANCE_KEY] = destroy;
        console.info(`[聊天工具箱] v${VERSION} 已加载`);
    }

    init();
})();
