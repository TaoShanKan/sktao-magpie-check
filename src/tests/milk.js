import { milkPrompt } from './milk-prompt.js';

export function normalizeAnswer(text) {
  return text.normalize('NFKC')
    .replace(/\\(?:text|mathrm|textrm|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:boxed|fbox)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\\[,;! ]/g, ' ')
    .replace(/\\[()[\]]|[$*`{}]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function grade(answer) {
  const text = normalizeAnswer(answer);
  const unknown = (reason) => ({ result: 'unknown', extracted: null, reason });
  if (!text) return unknown('回答为空，无法提取最终答案');
  // Explicit final conclusions take precedence over numbers in the derivation.
  // Rounding conclusions are final-answer markers too. Pick the last marker so
  // a numeric derivation after "average adult height" cannot hide the conclusion.
  const markers = [...text.matchAll(/(?:\brounded\s+to\s+(?:four|4)\s+significant\s+figures\s*:|(?:final(?:\s+(?:answer|result))?|average\s+adult\s+height|(?:the\s+)?answer\s+is|最终(?:答案|结果|结论)?|平均(?:成年)?身高|答案)\s*(?::|：|=|is\b|为|是)?)\s*/gi)];
  let candidate;
  if (markers.length) {
    const last = markers.at(-1);
    if (/\b(?:another|alternative|possible)\s+$/i.test(text.slice(0, last.index)))
      return unknown('最终结论存在多个候选答案');
    const tail = text.slice(last.index + last[0].length);
    candidate = tail.match(/^(?:approximately\s+|about\s+|约为?\s*)?([+-]?\d+(?:\.\d+)?)(?:\s*(?:inches|inch|英寸|in\b))?/i);
    if (!candidate) return unknown('最终结论中未能可靠提取数值');
    const rest = tail.slice(candidate[0].length);
    if (/^\s*(?:is\s+(?:incorrect|not\s+correct)|(?:不是|不正确|错误)|(?:or|或)\s+\d)/i.test(rest))
      return unknown('最终结论包含否定或多个候选值');
    if (/^\s*(?:cm\b|centimeters?\b|met(?:er|re)s?\b|feet\b|ft\b|厘米|米|英尺)/i.test(rest))
      return unknown('最终答案未使用英寸单位');
    if (/\d/.test(rest.replace(/\(?4\s+significant\s+figures\)?/gi, '')))
      return unknown('最终结论之后仍有其他数值，需人工确认');
  } else if (/^[+-]?\d+(?:\.\d+)?(?:\s*(?:inches|inch|英寸))?[.!。]?$/i.test(text)) {
    candidate = text.match(/([+-]?\d+(?:\.\d+)?)/);
  } else {
    const boxed = [...answer.matchAll(/\\boxed\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    const values = [...text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:inches|inch|英寸)\b/gi)];
    if (boxed.length) {
      // A boxed value is reliable only if later text does not introduce a new number.
      const box = boxed.at(-1);
      const after = normalizeAnswer(answer.slice(box.index + box[0].length));
      if (/\d/.test(after.replace(/four significant figures/gi, '')))
        return unknown('框选答案之后仍有数值，无法确定最终结论');
      const normalized = normalizeAnswer(box[1]);
      candidate = normalized.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*(?:inches|inch|英寸))?$/i);
    } else if (values.length === 1 && /^(?:thus|therefore|hence|所以|因此)\b/i.test(text) && !/incorrect|wrong|not\s+correct|不正确|错误|不是/i.test(text)) {
      candidate = values[0];
    }
    if (!candidate) return unknown('没有唯一、明确的最终答案');
  }
  const number = Number(candidate[1]);
  if (!Number.isFinite(number)) return unknown('最终答案不是有效数值');
  const rounded = Number(number.toPrecision(4));
  return {
    result: rounded === 46.24 ? 'passed' : 'failed', extracted: String(number),
    reason: rounded === 46.24 ? '最终答案按四位有效数字为 46.24 英寸' : `最终答案为 ${number}，与 46.24 英寸不符`,
  };
}

export const milk = Object.freeze({
  id: 'milk', name: '奶牛推理', promptVersion: 'milk-original-v1',
  ruleVersion: 'milk-final-v2', prompt: milkPrompt, expected: '46.24 英寸', grade,
});
