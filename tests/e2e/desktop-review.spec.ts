import {test,expect} from './fixture.js';

test('healthy polling preserves a failed preview explanation until action retry succeeds',async({page,workerBridge})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Создать сайт',exact:true}).click();
 await page.getByLabel('Домен',{exact:true}).fill('preview-error.test');
 await page.getByRole('button',{name:'Создать',exact:true}).click();
 await expect(page.getByText('Локальная версия готова',{exact:true})).toBeVisible({timeout:30000});
 workerBridge.failNext('preview.open','Chromium test launch failed');
 await page.getByRole('button',{name:'Открыть preview-error.test в Chromium'}).click();
 await expect(page.getByRole('alert')).toContainText('Chromium test launch failed');
 await page.screenshot({path:'.local-state/desktop-action-error.png',fullPage:true});
 const before=workerBridge.polls();
 await expect.poll(()=>workerBridge.polls()).toBeGreaterThanOrEqual(before+3);
 await expect(page.getByRole('alert')).toContainText('Chromium test launch failed');
 await page.getByRole('button',{name:'Повторить операцию'}).click();
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('healthy polling preserves a catalog error until catalog reload succeeds',async({page,workerBridge})=>{
 workerBridge.failNext('catalog.list','Catalog test read failed');
 await page.goto('/');
 await expect(page.getByRole('alert')).toContainText('Catalog test read failed');
 const before=workerBridge.polls();
 await expect.poll(()=>workerBridge.polls()).toBeGreaterThanOrEqual(before+3);
 await expect(page.getByRole('alert')).toContainText('Catalog test read failed');
 await page.getByRole('button',{name:'Загрузить референсы повторно'}).click();
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('creates using an eligible named library reference and excludes disabled-only references',async({page,workerBridge})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Референсы',exact:true}).click();
 await expect(page.getByText('Folio',{exact:true})).toBeVisible();
 await page.getByRole('checkbox',{name:'Светлый продуктовый Версия 1.0.0'}).click();
 await expect(page.getByRole('checkbox',{name:'Светлый продуктовый Версия 1.0.0'})).not.toBeChecked();
 await page.getByRole('button',{name:'Сайты',exact:true}).click();
 await page.getByRole('button',{name:'Создать сайт',exact:true}).click();
 const selection=page.getByRole('combobox',{name:'Референс',exact:true});
 await expect(selection).toBeVisible();
 await expect(selection.locator('option[value="northstar"]')).toHaveCount(0);
 await expect(selection.locator('option[value="startix"]')).toHaveText('Startix');
 await selection.selectOption({label:'Folio'});
 await page.screenshot({path:'.local-state/desktop-named-reference.png',fullPage:true});
 await page.getByLabel('Домен',{exact:true}).fill('folio-reference.test');
 await page.getByRole('button',{name:'Создать',exact:true}).click();
 await expect(page.getByText('Локальная версия готова',{exact:true})).toBeVisible({timeout:30000});
 expect(workerBridge.requests.find(request=>request.method==='site.create')?.params.referenceId).toBe('folio');
});
