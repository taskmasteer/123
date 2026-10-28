import { it, expect } from 'vitest';
import { siteCount, jobStageLabel, jobStateLabel } from '../src/lib/labels.js';
it.each([[1, '1 сайт'], [2, '2 сайта'], [5, '5 сайтов'], [11, '11 сайтов'], [21, '21 сайт'], [112, '112 сайтов']])('inflects Russian site count %s', (n, text) => expect(siteCount(Number(n))).toBe(text));
it('translates known worker stages/states and retains safe unknown labels', () => { expect(jobStageLabel('validate')).toBe('Проверка'); expect(jobStateLabel('running')).toBe('Выполняется'); expect(jobStageLabel('future_stage')).toBe('future_stage'); });
