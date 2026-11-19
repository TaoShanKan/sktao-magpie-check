import { describe, test, expect } from 'bun:test';
import { milk } from '../src/tests/milk.js';

describe('milk final answer grading', () => {
  for (const answer of [
    '46.24', '46.24 inches', '**46.24 inches**',
    String.raw`\boxed{46.24\text{ inches}}`, String.raw`\boxed{46.24\mathrm{inches}}`,
    String.raw`\(\boxed{46.24\text{ inches}}\)`,
    String.raw`With milk: 54 inches. Without milk: 42 inches. **Average adult height: \(\boxed{46.24\text{ inches}}\)** (four significant figures).`,
    'Final answer: 46.2426407 inches.', '最终答案为 46.24 英寸。',
    'Thus the answer is approximately 46.24 inches.',
  ]) test(`accepts ${answer}`, () => expect(milk.grade(answer).result).toBe('passed'));
  for (const answer of [
    '48 inches', '46.24 inches is incorrect. Final: 48 inches.',
    '46.24 inches is incorrect. Final: 48', '最终答案为 48 英寸。',
  ]) test(`rejects ${answer}`, () => expect(milk.grade(answer).result).toBe('failed'));
  for (const answer of ['', 'I cannot solve this', '42 inches and 54 inches', '46.24 inches is incorrect.',
    'Final answer: either 46.24 or 48 inches', 'Final answer: 46.24 or 48 inches', 'Final answer: 46.24 cm',
    'Intermediate calculation: 46.24 inches. I did not finish.', 'Final: 46.24 inches. Actually 48 inches.',
    String.raw`\boxed{46.24} but another answer is 48 inches`])
    test(`ambiguous ${answer}`, () => expect(milk.grade(answer).result).toBe('unknown'));
  test('does not put evaluation guidance in prompt', () => {
    expect(milk.prompt).not.toContain('46.24');
    expect(milk.prompt.endsWith('Don’t use search.Don’t use memory.')).toBe(true);
  });

  // Synthetic examples of the three extraction failures found during review.
  // Do not copy private model responses into repository fixtures.
  for (const answer of [
    String.raw`The average adult height is therefore 42 + 12 / (2 sqrt(2)) = 46.2426407 inches.
Rounded to four significant figures: **\(\boxed{46.24\text{ inches}}\)**.`,
    String.raw`The mean height is 46.2426407 inches.
Rounded to four significant figures: **\(46.24\) inches**.`,
    String.raw`The population's average adult height is 42 + 12 / (2 sqrt(2)) = 46.2426407 inches.
Rounded to four significant figures: **\(\boxed{46.24\text{ inches}}\)**.`,
    'Rounded to 4 significant figures: 46.24 inches.',
  ]) test(`extracts rounding conclusion: ${answer}`, () => {
    expect(milk.grade(answer)).toMatchObject({ result: 'passed', extracted: '46.24' });
  });

  test('rounding conclusion does not accept an earlier correct value', () => {
    expect(milk.grade('Intermediate: 46.24 inches. Rounded to four significant figures: 48.00 inches.'))
      .toMatchObject({ result: 'failed', extracted: '48' });
  });

  for (const conclusion of [
    'either 46.24 or 48 inches', '46.24 or 48 inches', '46.24 cm',
    '46.24 inches is incorrect', '46.24 inches. Actually 48 inches.',
    '46.24 + 1 inches',
  ]) test(`keeps unsafe rounding conclusion unknown: ${conclusion}`, () => {
    expect(milk.grade(`Rounded to four significant figures: ${conclusion}`).result).toBe('unknown');
  });

  test('versions the new rule without changing the prompt', () => {
    expect(milk.ruleVersion).toBe('milk-final-v2');
    expect(milk.promptVersion).toBe('milk-original-v1');
  });
});
