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

test('selected Godown overrides source location and line fields preserve bill number/date',()=>{
 const line={item_id:'item1',quantity:1,pieces:2,rate:100,discount:0,tax:{id:'t',percentage:5},sourceBill:{invoiceId:'inv1',lineId:'il1',customerId:'c1',quantity:10,number:'INV-001',date:'2026-09-01',locationId:'old-warehouse'}};
 const state={customer:{contact_id:'c1'},lines:[line]};
 const values={date:'2026-10-06',place_of_supply:'KL',custom:{},godown_id:'new-warehouse',location_id:'parent-branch',notes:'Returned damaged'};
 const config={invoiceQuantityMode:'pieces',customFields:{},requireLocation:true,lineCustomFields:{billNo:{label:'BillNO',id:'123'},billDate:{label:'Ref_Bill Date',apiName:'cf_ref_bill_date'}}};
 assert.deepEqual(core.validateCreditNote(state,values,config),[]);
 const payload=core.makePayload(state,values,config);
 assert.equal(payload.location_id,'parent-branch');assert.equal(payload.line_items[0].location_id,'new-warehouse');assert.equal(payload.notes,'Returned damaged');
 assert.deepEqual(payload.line_items[0].item_custom_fields,[{customfield_id:'123',value:'INV-001'},{api_name:'cf_ref_bill_date',value:'2026-09-01'}]);
 assert.ok(core.validateCreditNote(state,{...values,godown_id:''},config).includes('Select a Godown.'));
 const missing={...config,lineCustomFields:{billNo:{label:'BillNO',id:''}}};
 assert.ok(core.validateCreditNote(state,values,missing).some(e=>e.includes('BillNO')));
 assert.throws(()=>core.makePayload(state,values,missing),/BillNO/);
});

test('single-invoice create includes invoice context; mixed invoices do not get a false context',async()=>{
 const api=new ERP({},{}),calls=[];api.request=async(...args)=>{calls.push(args);return {};};
 const payload={line_items:[{invoice_id:'inv1'},{invoice_id:'inv1'}]};await api.createCreditNote(payload);
 assert.deepEqual(calls[0],['/creditnotes',{ignore_auto_number_generation:false,invoice_id:'inv1'},'POST',payload]);
 await api.createCreditNote({line_items:[{invoice_id:'inv1'},{invoice_id:'inv2'}]});assert.equal(calls[1][1].invoice_id,undefined);
});
test('inspection only reads bounded source records and records permission failures',async()=>{
 const api=new ERP({},{}),calls=[];api.request=async(path,query,method)=>{calls.push({path,method});if(path==='/creditnotes')throw Error('Missing READ scope');return {code:0};};
 const inspection=await api.inspectCreation({customer_id:'c1',line_items:[{invoice_id:'inv1',item_id:'it1'},{invoice_id:'inv1',item_id:'it1'}]});
 assert.equal(inspection.readOnly,true);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.method===undefined));assert.match(inspection.checks.at(-1).error,/READ scope/);
});
