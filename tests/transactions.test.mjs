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
 const payload=core.makePayload(state,values,config);assert.equal(payload.is_draft,true);assert.equal(payload.invoice_id,'i1');assert.equal(payload.line_items[0].invoice_id,'');assert.equal(payload.line_items[0].invoice_item_id,'');assert.equal(payload.reference_invoice_type,'');
});

test('selected Godown overrides source location and line fields preserve bill number/date',()=>{
 const line={item_id:'item1',quantity:1,pieces:2,rate:100,discount:0,tax:{id:'t',percentage:5},sourceBill:{invoiceId:'inv1',lineId:'il1',customerId:'c1',quantity:10,number:'INV-001',date:'2026-09-01',locationId:'old-warehouse'}};
 const state={customer:{contact_id:'c1'},lines:[line]};
 const values={date:'2026-10-06',place_of_supply:'KL',custom:{},godown_id:'new-warehouse',location_id:'parent-branch',notes:'Returned damaged'};
 const config={invoiceQuantityMode:'pieces',customFields:{},requireLocation:true,lineCustomFields:{billNo:{label:'BillNO',id:'123'},billDate:{label:'Ref_Bill Date',apiName:'cf_ref_bill_date'}}};
 assert.deepEqual(core.validateCreditNote(state,values,config),[]);
 const payload=core.makePayload(state,values,config);
 assert.equal(payload.location_id,'parent-branch');assert.equal(payload.line_items[0].location_id,'new-warehouse');assert.equal(payload.notes,'Returned damaged');
 assert.deepEqual(payload.line_items[0].item_custom_fields,[{label:'BillNO',value:'INV-001'},{label:'Ref_Bill Date',value:'2026-09-01'}]);
 assert.ok(core.validateCreditNote(state,{...values,godown_id:''},config).includes('Select a Godown.'));
 const missing={...config,lineCustomFields:{billNo:{label:'BillNO',id:''}}};
 assert.ok(core.validateCreditNote(state,values,missing).some(e=>e.includes('BillNO')));
 assert.throws(()=>core.makePayload(state,values,missing),/BillNO/);
});

test('single-invoice create includes invoice context; mixed invoices do not get a false context',async()=>{
 const api=new ERP({},{}),calls=[];api.request=async(...args)=>{calls.push(args);return {};};
 const payload={line_items:[{invoice_id:'inv1'},{invoice_id:'inv1'}]};await api.createCreditNote(payload);
 assert.deepEqual(calls[0],['/creditnotes',{},'POST',payload]);
 await api.createCreditNote({line_items:[{invoice_id:'inv1'},{invoice_id:'inv2'}]});assert.equal(calls[1][1].invoice_id,undefined);
});
test('inspection only reads bounded source records and records permission failures',async()=>{
 const api=new ERP({},{}),calls=[];api.request=async(path,query,method)=>{calls.push({path,method});if(path==='/creditnotes')throw Error('Missing READ scope');return {code:0};};
 const inspection=await api.inspectCreation({customer_id:'c1',line_items:[{invoice_id:'inv1',item_id:'it1'},{invoice_id:'inv1',item_id:'it1'}]});
 assert.equal(inspection.readOnly,true);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.method===undefined));assert.match(inspection.checks.at(-1).error,/READ scope/);
});


test('Invoice Type follows customer GSTIN and never the shipping GSTIN or Bill type',()=>{
 const values={date:'2026-10-06',place_of_supply:'KL',custom:{billType:'Cash'},shipping_gst_no:'32SHIPPING1234Z5'};
 const config={customFields:{billType:{id:'bill-type'}}};
 for(const gst of ['32ABCDE1234F1Z5',' 32ABCDE1234F1Z5 ', '', '   ', null, undefined]) {
  const customer={contact_id:'customer',gst_no:gst};
  const payload=core.makePayload({customer,lines:[]},values,config);
  const registered=Boolean(gst?.trim());
  assert.equal(payload.reference_invoice_type,registered?'registered':'b2cs');
  assert.equal(core.customerInvoiceType(customer).label,registered?'Registered':'B2C others');
  assert.deepEqual(payload.custom_fields,[{customfield_id:'bill-type',value:'Cash'}]);
 }
});


test('native creation context uses selected location series, GST and stock return fields; mixed bills retain links',()=>{
 const sourceBill={invoiceId:'invoice-a',lineId:'line-a',number:'INV-A',date:'2026-10-01',accountId:'sales-account',unit:'pcs',hsn:'620442'};
 const line={item_id:'item',quantity:1,pieces:5,rate:1120,discount:0,sourceBill};
 const state={customer:{contact_id:'customer',gst_no:'32ABCDE1234F1Z5',gst_treatment:'business_gst'},warehouses:[{location_id:'branch',autonumbergenerationgroup_id:'series'}],lines:[line]};
 const values={date:'2026-10-07',place_of_supply:'KL',location_id:'branch',godown_id:'warehouse',custom:{}};
 const config={customFields:{},invoiceQuantityMode:'pieces'};
 const p=core.makePayload(state,values,config);
 assert.equal(p.invoice_id,'invoice-a');assert.equal(p.autonumbergenerationgroup_id,'series');assert.equal(p.gst_treatment,'business_gst');assert.equal(p.gst_no,state.customer.gst_no);assert.equal(p.gst_reason,'others');
 assert.equal(p.line_items[0].quantity,5);assert.equal(p.line_items[0].account_id,'sales-account');assert.equal(p.line_items[0].unit,'pcs');assert.equal(p.line_items[0].hsn_or_sac,'620442');assert.equal(p.line_items[0].is_returned_to_stock,true);assert.equal(p.line_items[0].is_item_shipped,false);
 const mixed=core.makePayload({...state,lines:[line,{...line,sourceBill:{...sourceBill,invoiceId:'invoice-b',lineId:'line-b'}}]},values,config);
 assert.equal(mixed.invoice_id,undefined);assert.equal(mixed.reference_invoice_type,'registered');assert.deepEqual(mixed.line_items.map(l=>[l.invoice_id,l.invoice_item_id]),[['invoice-a','line-a'],['invoice-b','line-b']]);
});


test('invoice-wide discount is allocated proportionally across returned items, not charged in full',async()=>{
 const api=new ERP({},{});
 let invoice={invoice_id:'inv',customer_id:'c',status:'sent',discount_type:'entity_level',is_discount_before_tax:true,discount_total:150,line_items:[{item_id:'a',line_item_id:'la',quantity:10,rate:100},{item_id:'b',line_item_id:'lb',quantity:5,rate:100}]};
 api.request=async path=>path==='/invoices'?{invoices:[{invoice_id:'inv'}]}:{invoice};
 const [a]=await api.itemTransactions('c','a');const [b]=await api.itemTransactions('c','b');
 assert.equal(a.discount,10);assert.equal(b.discount,10);assert.equal(a.discountError,'');
 assert.equal(core.lineAmounts({quantity:2,pieces:1,rate:a.rate,discount:a.discount}).discount,20);
 invoice={...invoice,discount:'12.5%',discount_total:187.5};assert.equal((await api.itemTransactions('c','a'))[0].discount,12.5);
 invoice={...invoice,is_discount_before_tax:false};assert.match((await api.itemTransactions('c','a'))[0].discountError,/after tax/);
});
