import { test, expect } from './fixture.js';

test('reviews isolated refinements, accepts a draft, publishes explicitly and rejects the next edit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать сайт', exact: true }).click();
  await page.getByLabel('Домен', { exact: true }).fill('editor.test');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Локальная версия готова', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Правки editor.test' }).click();
  await page.getByLabel('Инструкция для правки').fill('Clearer data systems');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Принять в черновик' })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByRole('img', { name: 'После — editor.test' })).toBeVisible();
  await page.getByRole('button', { name: 'Уточнить', exact: true }).click();
  await page.getByLabel('Инструкция для правки').fill('Reliable data for everyone');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.candidate-decision').getByText('Вариант 2 · Готов к проверке', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.local-state/editor-comparison.png', fullPage: true });
  await page.getByRole('button', { name: 'Принять в черновик' }).click();
  await expect(page.getByText('Есть принятый черновик', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await expect(page.getByText('Черновик опубликован локально', { exact: true })).toBeVisible();
  await page.getByLabel('Инструкция для правки').fill('Discard this demonstration');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.locator('.candidate-decision').getByText('Вариант 3 · Готов к проверке', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
  await expect(page.locator('.candidate-decision').getByText('Вариант 3 · Отклонён', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1040, height: 680 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.local-state/editor-minimum.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('iframe').count()).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Правки editor.test' }).click();
  await expect(page.getByText('Reliable data for everyone', { exact: true })).toBeVisible();
});

test('a failed first registry load is not presented as an empty registry', async ({ page, workerBridge }) => {
  workerBridge.failNext('site.list', 'Registry unavailable');
  await page.goto('/');
  await expect(page.getByText('Не удалось обновить состояние')).toBeVisible();
  await expect(page.getByText('Сайтов пока нет')).not.toBeVisible();
});
