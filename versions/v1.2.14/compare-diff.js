function lcsMatches(left, right, key = (value) => value) {
    const rows = left.length + 1;
    const columns = right.length + 1;
    if (rows * columns > 180000) return [];
    const table = Array.from({ length: rows }, () => new Uint16Array(columns));
    for (let i = left.length - 1; i >= 0; i -= 1) {
        for (let j = right.length - 1; j >= 0; j -= 1) {
            table[i][j] = key(left[i]) === key(right[j])
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const matches = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        if (key(left[i]) === key(right[j])) {
            matches.push([i, j]);
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            i += 1;
        } else {
            j += 1;
        }
    }
    return matches;
}

function structuredPromptLine(value) {
    const text = String(value || '');
    return /<%|{{|<\/?[a-z][^>]*>|^\s*[\[{]|=>|^\s*(?:const|let|var|function|class)\b/i.test(text);
}

function sentenceUnits(value) {
    const text = String(value || '');
    const parts = text.match(/.*?(?:[。！？!?；;]+|$)/g)?.filter(Boolean) || [];
    return parts.length > 1 ? parts : [text];
}

function marked(value, different, escapeHTML) {
    const text = escapeHTML(String(value ?? ''));
    return different ? `<mark class="ctb-compare-difference">${text || '&nbsp;'}</mark>` : text;
}

export function normalizeComparableText(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/^\n+|\n+$/g, '');
}

function renderSentencePair(leftLine, rightLine, escapeHTML) {
    if (structuredPromptLine(leftLine) || structuredPromptLine(rightLine)) {
        return { left: marked(leftLine, true, escapeHTML), right: marked(rightLine, true, escapeHTML) };
    }
    const left = sentenceUnits(leftLine);
    const right = sentenceUnits(rightLine);
    if (left.length === 1 && right.length === 1) {
        return { left: marked(leftLine, true, escapeHTML), right: marked(rightLine, true, escapeHTML) };
    }
    const matches = lcsMatches(left, right, (value) => String(value).trim());
    const leftSame = new Set(matches.map(([index]) => index));
    const rightSame = new Set(matches.map(([, index]) => index));
    return {
        left: left.map((value, index) => marked(value, !leftSame.has(index), escapeHTML)).join(''),
        right: right.map((value, index) => marked(value, !rightSame.has(index), escapeHTML)).join(''),
    };
}

/**
 * Render a two-sided prompt comparison. Lines are aligned first; changed prose
 * lines are then compared by sentence. Structured template/code lines stay
 * intact and are highlighted as a whole.
 */
export function renderTextDifference(leftValue, rightValue, escapeHTML) {
    const left = normalizeComparableText(leftValue).split('\n');
    const right = normalizeComparableText(rightValue).split('\n');
    const matches = lcsMatches(left, right);
    const leftHtml = [];
    const rightHtml = [];
    let leftIndex = 0;
    let rightIndex = 0;
    const appendChangedBlock = (leftEnd, rightEnd) => {
        const count = Math.max(leftEnd - leftIndex, rightEnd - rightIndex);
        for (let offset = 0; offset < count; offset += 1) {
            const hasLeft = leftIndex + offset < leftEnd;
            const hasRight = rightIndex + offset < rightEnd;
            if (hasLeft && hasRight) {
                const pair = renderSentencePair(left[leftIndex + offset], right[rightIndex + offset], escapeHTML);
                leftHtml.push(pair.left);
                rightHtml.push(pair.right);
            } else {
                leftHtml.push(hasLeft ? marked(left[leftIndex + offset], true, escapeHTML) : '');
                rightHtml.push(hasRight ? marked(right[rightIndex + offset], true, escapeHTML) : '');
            }
        }
        leftIndex = leftEnd;
        rightIndex = rightEnd;
    };
    for (const [nextLeft, nextRight] of matches) {
        appendChangedBlock(nextLeft, nextRight);
        leftHtml.push(escapeHTML(left[nextLeft]));
        rightHtml.push(escapeHTML(right[nextRight]));
        leftIndex = nextLeft + 1;
        rightIndex = nextRight + 1;
    }
    appendChangedBlock(left.length, right.length);
    return { left: leftHtml.join('\n'), right: rightHtml.join('\n') };
}
