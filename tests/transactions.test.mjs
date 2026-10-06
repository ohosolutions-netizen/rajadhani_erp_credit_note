import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const core=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('app/js/core.js')).toString('base64'));
const erpSource=fs.readFileSync('app/js/erp.js','utf8').replace("import { decodeResponse } from './core.js';",'const decodeResponse = '+core.decodeResponse.toString()+';');
const {ERP}=await import('data:text/javascript;base64,'+Buffer.from(erpSource).toString('base64'));
test('lookup traverses pages, preserves duplicate item lines, filters customer and fails incomplete details',async()=>{
 const api=new ERP({},{}),pages=[];
 api.request=async(path,q)=>{
  if(path==='/invoices'){pages.push(q.page);return {invoices:[{invoice_id:String(q.page)}],page_context:{has_more_page:q.page===1}};}
  return {invoice:{invoice_id:path.slice(-1),customer_id:'c1',invoice_number:'INV',date:'2026-09-01',status:'paid',line_items:[{item_id:'i1',line_item_id:'a',quantity:2,rate:100,discount_amount:20},{item_id:'i1',line_item_id:'b',quantity:1,rate:90,discount:'5%'},{item_id:'other',line_item_id:'c',quantity:2,rate:1}]}};
 };
 const rows=await api.itemTransactions('c1','i1');assert.equal(rows.length,4);assert.deepEqual(pages,[1,2]);assert.equal(rows[0].discount,10);assert.equal(rows[1].discount,5);
 assert.equal((await api.itemTransactions('other','i1')).length,0);
 api.request=async path=>path==='/invoices'?{invoices:[{invoice_id:'bad'}]}:{invoice:{}};
 await assert.rejects(()=>api.itemTransactions('c1','i1'),/incomplete/);
});
test('references and aggregate quantities validated; payload uses draft and original line IDs',()=>{
 const sourceBill={invoiceId:'i1',lineId:'l1',customerId:'c1',quantity:3,number:'INV-1',date:'2026-01-01'};
 const line={item_id:'item',quantity:2,pieces:1,rate:10,discount:0,tax:{id:'t',percentage:5},sourceBill};
 const state={customer:{contact_id:'c1'},lines:[line]},values={date:'2026-10-01',place_of_supply:'KL',custom:{}},config={invoiceQuantityMode:'pieces',customFields:{}};
 assert.deepEqual(core.validateCreditNote(state,values,config),[]);
 assert.ok(core.validateCreditNote({...state,lines:[line,line]},values,config).some(e=>e.includes('exceeds billed')));
 assert.ok(core.validateCreditNote({...state,lines:[{...line,sourceBill:null}]},values,config).some(e=>e.includes('original bill')));
 assert.ok(core.validateCreditNote({...state,customer:{contact_id:'other'}},values,config).some(e=>e.includes('different customer')));
 const payload=core.makePayload(state,values,config);assert.equal(payload.is_draft,true);assert.equal(payload.line_items[0].invoice_id,'i1');assert.equal(payload.line_items[0].invoice_item_id,'l1');
});
