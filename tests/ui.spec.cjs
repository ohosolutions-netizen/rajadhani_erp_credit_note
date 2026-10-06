const {test,expect}=require('@playwright/test');
const fs=require('fs');
async function start(page,live=false,mode='success'){
 if(live) await page.route('**/dist/CreditNotePreview.html',async route=>{
  let html=fs.readFileSync('dist/CreditNotePreview.html','utf8');
  html=html.replace('<script type="module">',`<script>const originalRequest=ZFAPPS.request; ZFAPPS.request=async o=>{if(o.method==='POST'){window.sentRequest=o; ${mode==='reject' ? "return {data:{status:400,body:JSON.stringify({code:14,message:'Credit Note rejected',details:[{field:'line_items[0].item_custom_fields',message:'Invalid values are given for creation'}]})}};" : mode==='network' ? "throw new Error('Network lost');" : "return {code:0,creditnote:{creditnote_id:'cn1',creditnote_number:'CN-1',status:'draft',total:2655}};"}}return originalRequest(o);};</script><script type="module">`);
  html=html.replace('renderLines();await connect();', 'renderLines();await connect();window.RAJADHANI_PREVIEW_CONFIG=null;');
  await route.fulfill({contentType:'text/html',body:html});
 });
 await page.goto('/dist/CreditNotePreview.html');await expect(page.locator('#connectionStatus')).toHaveText('Preview · sample data');await expect(page.locator('#location')).toHaveValue('loc1');
 await page.locator('#customerSearch').fill('Malabar');await page.getByRole('option').filter({hasText:'Malabar Trading Company'}).click();await expect(page.locator('#billingAddress')).toContainText('Kochi');
 await page.locator('#itemSearch').fill('PAP-A4-75');await page.locator('#itemSearch').press('Tab');await expect(page.locator('[data-bill]').first()).toBeEnabled();
}
async function bill(page){await page.locator('[data-bill]').first().click();await expect(page.locator('#billRows tr')).toHaveCount(4);await page.locator('#billFilter').fill('REF-124');await expect(page.locator('#billRows tr')).toHaveCount(2);await page.locator('#billRows button').first().click();}
async function review(page){await page.locator('#cf_billType').selectOption('Credit');await page.locator('#location').selectOption('loc2');await page.locator('#salesperson').selectOption('s1');await page.locator('#saveButton').click();await expect(page.locator('#reviewDialog')).toBeVisible();}
test('bill picker lists matching transactions, retains duplicate item lines and copies source values',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page);
 await page.locator('[data-bill]').click();await expect(page.locator('#billRows tr')).toHaveCount(4);
 await expect(page.locator('#billRows')).not.toContainText('OTHER-CUSTOMER');await expect(page.locator('#billRows tr').filter({hasText:'INV-DRAFT'}).locator('button')).toBeDisabled();
 await page.getByRole('button',{name:'Close bills'}).click();await bill(page);
 await expect(page.locator('[data-bill]')).toHaveText('INV-00124');await expect(page.locator('#lineItems')).toContainText('REF-124');await expect(page.locator('[data-field=rate]')).toHaveValue('250');await expect(page.locator('[data-field=discount]')).toHaveValue('10');
 await review(page);await expect(page.locator('#reviewContent')).toContainText('INV-00124');await expect(page.locator('#confirmSave')).toBeDisabled();expect(errors).toEqual([]);
});
test('missing bill and excessive quantity block review; customer change clears references',async({page})=>{
 await start(page);await page.locator('#cf_billType').selectOption('Credit');await page.locator('#location').selectOption('loc2');await page.locator('#salesperson').selectOption('s1');await page.locator('#saveButton').click();await expect(page.locator('#notice')).toContainText('select an original bill');
 await bill(page);await page.locator('[data-field=quantity]').fill('1000');await page.locator('#saveButton').click();await expect(page.locator('#notice')).toContainText('exceeds billed quantity');
 await page.locator('#customerSearch').fill('Sree');await expect(page.locator('#lineCount')).toHaveText('0');
});
test('same item can be returned from two different bills',async({page})=>{
 await start(page);await bill(page);await page.locator('#itemSearch').fill('PAP-A4-75');await page.locator('#itemSearch').press('Tab');await expect(page.locator('#lineCount')).toHaveText('2');
 await page.locator('[data-bill]').nth(1).click();await expect(page.locator('#billRows tr')).toHaveCount(4);await page.locator('#billFilter').fill('131');await page.locator('#billRows button').click();await expect(page.locator('[data-bill]').nth(1)).toHaveText('INV-00131');await review(page);
});
test('creates a draft Credit Note with invoice line references and locks after success',async({page})=>{
 await start(page,true);await bill(page);await review(page);await page.locator('#confirmSave').click();await expect(page.locator('#notice')).toContainText('Credit Note CN-1 saved');
 const request=await page.evaluate(()=>window.sentRequest);expect(request.url).toMatch(/\/creditnotes$/);const body=JSON.parse(request.body.raw);expect(body.is_draft).toBe(true);expect(body.custom_fields).toContainEqual({customfield_id:'4160832000001021023',value:'Credit'});expect(body.location_id).toBe('loc1');expect(body.line_items[0]).toMatchObject({invoice_id:'inv1',invoice_item_id:'il1',rate:250,discount:'10%',location_id:'loc2',item_custom_fields:[{customfield_id:'4160832000001016028',value:'INV-00124'},{customfield_id:'4160832000001015010',value:'2026-09-18'}]});expect(body.line_items[0]).not.toHaveProperty('salesorder_item_id');await expect(page.locator('#saveButton')).toBeDisabled();
});
test('API rejection permits retry; ambiguous network result prevents duplicate submission',async({page})=>{
 await start(page,true,'reject');await bill(page);await review(page);await page.locator('#confirmSave').click();await expect(page.locator('#saveStatus')).toContainText('Credit Note rejected');await expect(page.locator('#confirmSave')).toBeEnabled();await expect(page.locator('#saveDebug')).toBeVisible();const debug=JSON.parse(await page.locator('#saveDebugText').inputValue());expect(debug.error.code).toBe(14);expect(debug.response.details[0].field).toBe('line_items[0].item_custom_fields');expect(debug.request.payload.custom_fields).toContainEqual({customfield_id:'4160832000001021023',value:'Credit'});expect(debug.sdk.envelope.data.status).toBe(400);
});
test('ambiguous network failure disables retry',async({page})=>{
 await start(page,true,'network');await bill(page);await review(page);await page.locator('#confirmSave').click();await expect(page.locator('#saveStatus')).toContainText('Could not confirm');await expect(page.locator('#confirmSave')).toBeDisabled();
});
test('bill lookup failure is visible and retry works',async({page})=>{
 await start(page);await page.evaluate(()=>{const original=ZFAPPS.request;let failed=false;ZFAPPS.request=o=>{if(!failed && o.url.endsWith('/invoices')){failed=true;throw Error('Lookup failed');}return original(o);};});
 await page.locator('[data-bill]').click();await expect(page.locator('#billStatus')).toContainText('Could not load transactions');await page.getByRole('button',{name:'Close bills'}).click();await bill(page);await expect(page.locator('[data-bill]')).toHaveText('INV-00124');
});
test('popup remains bounded and bill table scrolls',async({page})=>{
 await page.setViewportSize({width:1100,height:700});await start(page);await page.locator('[data-bill]').click();await expect(page.locator('#billRows tr')).toHaveCount(4);const box=await page.locator('#billDialog').boundingBox();expect(box.width).toBeLessThanOrEqual(1100);expect(box.height).toBeLessThanOrEqual(700);await page.screenshot({path:'dist/CreditNotePreview.png'});await page.getByRole('button',{name:'Close bills'}).click();await expect(page.locator('#invoiceItemsCard th')).toHaveText(['Item Code','Bill No','Ref Bill No','Ref Bill Date','Pieces / pack','Order Qty','Rate','Disc %','Tax','Amount']);await expect(page.locator('#location')).toBeVisible();await expect(page.locator('#cf_transport,#cf_agent,#cf_vehicle,#cf_billCreatedBy,#cf_mobile,#cf_shippingPhone')).toHaveCount(0);const grid=await page.locator('#invoiceItemsCard').boundingBox();const sidebar=await page.locator('aside').boundingBox();expect(sidebar.x).toBeGreaterThanOrEqual(grid.x+grid.width);const fitted=await page.locator('#invoiceItemsCard .tablewrap').evaluate(el=>el.scrollWidth<=el.clientWidth+1);expect(fitted).toBe(true);await page.locator('#invoiceItemsCard').screenshot({path:'dist/CreditNoteItems.png'});
});
